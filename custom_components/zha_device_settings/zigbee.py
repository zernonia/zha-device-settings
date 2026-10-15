"""Low-level Zigbee access via ZHA's zigpy application controller.

We bypass `zha.set_zigbee_cluster_attribute` on purpose: that service only
writes attributes the cluster class already knows about, and manufacturer
clusters (like Aqara's 0xFCC0) are often missing exactly the ones we need.
Here we send raw, explicitly-typed ZCL Read/Write Attributes frames.
"""

from __future__ import annotations

import inspect
import logging
from typing import Any

import zigpy.types as t
from zigpy.zcl import foundation

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

_LOGGER = logging.getLogger(__name__)

# ZCL data type id -> zigpy python type
DATA_TYPES: dict[int, type] = {
    0x10: t.Bool,
    0x18: t.bitmap8,
    0x19: t.bitmap16,
    0x20: t.uint8_t,
    0x21: t.uint16_t,
    0x22: t.uint24_t,
    0x23: t.uint32_t,
    0x24: t.uint40_t,
    0x25: t.uint48_t,
    0x28: t.int8s,
    0x29: t.int16s,
    0x2A: t.int24s,
    0x2B: t.int32s,
    0x30: t.enum8,
    0x31: t.enum16,
    0x38: t.Half,
    0x39: t.Single,
    0x3A: t.Double,
    0x41: t.LVBytes,
}

FLOAT_TYPES = {0x38, 0x39, 0x3A}
BYTES_TYPES = {0x41}


def _coerce(type_id: int, value: Any):
    """Build the zigpy value for a ZCL type from a JSON value."""
    py_type = DATA_TYPES.get(type_id)
    if py_type is None:
        raise HomeAssistantError(f"Unsupported ZCL data type 0x{type_id:02x}")
    if type_id in BYTES_TYPES:
        return py_type(bytes(value))
    if type_id in FLOAT_TYPES:
        return py_type(float(value))
    if type_id == 0x10:
        return t.Bool(bool(value))
    return py_type(int(value))


def get_app_controller(hass: HomeAssistant):
    """Return ZHA's zigpy ControllerApplication, across HA versions."""
    try:
        from homeassistant.components.zha.helpers import get_zha_gateway

        return get_zha_gateway(hass).application_controller
    except Exception:  # noqa: BLE001 - fall through to older layout
        pass
    try:
        from homeassistant.components.zha.helpers import get_zha_gateway_proxy

        return get_zha_gateway_proxy(hass).gateway.application_controller
    except Exception as err:  # noqa: BLE001
        raise HomeAssistantError(
            "ZHA is not loaded or its internal API changed"
        ) from err


def get_zigpy_device(hass: HomeAssistant, ieee: str):
    app = get_app_controller(hass)
    try:
        return app.get_device(ieee=t.EUI64.convert(ieee))
    except KeyError as err:
        raise HomeAssistantError(f"Unknown Zigbee device {ieee}") from err


def _get_cluster(device, endpoint_id: int, cluster_id: int):
    endpoint = device.endpoints.get(endpoint_id)
    if endpoint is None:
        raise HomeAssistantError(
            f"Device {device.ieee} has no endpoint {endpoint_id}"
        )
    cluster = endpoint.in_clusters.get(cluster_id)
    if cluster is None:
        # Some devices accept manufacturer cluster traffic on endpoints that
        # don't advertise it (Z2M writes to them happily). Add it locally.
        cluster = endpoint.add_input_cluster(cluster_id)
    return cluster


def _sync_cache(cluster, attrid: int, value: Any) -> None:
    """Update zigpy's attribute cache so ZHA's own entities reflect the new value.

    The raw read/write calls bypass the cache, so without this a setting changed here
    would show a stale value on the matching ZHA entity until its next poll.
    """
    try:
        attr_def = cluster.attributes.get(attrid)
        if attr_def is not None:
            try:
                value = attr_def.type(value)
            except (TypeError, ValueError):
                pass
        cluster.update_attribute(attrid, value)
    except Exception as err:  # noqa: BLE001 - cache sync is best effort
        _LOGGER.debug("Cache update for 0x%04x/0x%04x failed: %s", cluster.cluster_id, attrid, err)


def _status_records(rsp: Any) -> list:
    """Extract status records from a zigpy response (shape varies by version)."""
    if rsp is None:
        return []
    records = getattr(rsp, "status_records", None)
    if records is not None:
        return list(records)
    if isinstance(rsp, (list, tuple)) and rsp:
        first = rsp[0]
        if isinstance(first, (list, tuple)):
            return list(first)
        return list(rsp)
    return []


def _plain(value: Any) -> Any:
    """Convert zigpy values to JSON-friendly python values."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return str(value)


async def read_attributes(
    hass: HomeAssistant,
    ieee: str,
    endpoint_id: int,
    cluster_id: int,
    attribute_ids: list[int],
    manufacturer: int | None,
) -> dict[int, dict[str, Any]]:
    """Read attributes. Returns {attr_id: {"value": ..., "status": ...}}."""
    device = get_zigpy_device(hass, ieee)
    cluster = _get_cluster(device, endpoint_id, cluster_id)
    out: dict[int, dict[str, Any]] = {
        a: {"value": None, "status": "NO_RESPONSE"} for a in attribute_ids
    }
    try:
        rsp = await cluster.read_attributes_raw(
            attribute_ids, manufacturer=manufacturer
        )
    except Exception as err:  # noqa: BLE001 - surface as status, keep going
        _LOGGER.debug("Read %s ep%s 0x%04x failed: %s", ieee, endpoint_id, cluster_id, err)
        for a in attribute_ids:
            out[a]["status"] = f"ERROR: {err}"
        return out

    for rec in _status_records(rsp):
        attrid = int(getattr(rec, "attrid", -1))
        if attrid not in out:
            continue
        status = getattr(rec, "status", None)
        ok = status == foundation.Status.SUCCESS
        tv = getattr(rec, "value", None)
        if ok:
            _sync_cache(cluster, attrid, getattr(tv, "value", tv))
        out[attrid] = {
            "value": _plain(getattr(tv, "value", tv)) if ok else None,
            "status": "SUCCESS" if ok else str(status),
        }
    return out


async def write_attribute(
    hass: HomeAssistant,
    ieee: str,
    endpoint_id: int,
    cluster_id: int,
    attribute_id: int,
    type_id: int,
    value: Any,
    manufacturer: int | None,
    raw: bool = False,
) -> str:
    """Write one explicitly-typed attribute. Returns the ZCL status name.

    With raw=True, `value` is the already-serialized bytes that follow the type id
    (used for arrays and structs, which the definitions pre-encode).
    """
    zvalue = t.SerializableBytes(bytes(value)) if raw else _coerce(type_id, value)
    device = get_zigpy_device(hass, ieee)
    cluster = _get_cluster(device, endpoint_id, cluster_id)

    record = foundation.Attribute(
        attrid=t.uint16_t(attribute_id),
        value=foundation.TypeValue(type=type_id, value=zvalue),
    )

    # zigpy renamed the kwarg at some point; support both spellings.
    params = inspect.signature(cluster.write_attributes_raw).parameters
    mfr_kw = "manufacturer_code" if "manufacturer_code" in params else "manufacturer"
    try:
        rsp = await cluster.write_attributes_raw([record], **{mfr_kw: manufacturer})
    except Exception as err:  # noqa: BLE001
        raise HomeAssistantError(f"Write failed: {err}") from err

    records = _status_records(rsp)
    if not records:
        # DefaultResponse or empty success list
        status = getattr(rsp, "status", foundation.Status.SUCCESS)
        result = "SUCCESS" if status == foundation.Status.SUCCESS else str(status)
    else:
        bad = [r for r in records if getattr(r, "status", None) != foundation.Status.SUCCESS]
        result = "SUCCESS" if not bad else str(bad[0].status)
    if result == "SUCCESS" and not raw:
        _sync_cache(cluster, attribute_id, zvalue)
    return result
