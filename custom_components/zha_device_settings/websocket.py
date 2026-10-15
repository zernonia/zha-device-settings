"""Websocket API used by the sidebar panel."""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import area_registry as ar, device_registry as dr

from . import zigbee
from .const import DOMAIN
from .definitions import (
    apply_dynamic,
    find_setting,
    load_definitions,
    match_definition,
    raw_to_ui,
    writes_for,
)


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_devices)
    websocket_api.async_register_command(hass, ws_device_settings)
    websocket_api.async_register_command(hass, ws_write_setting)
    websocket_api.async_register_command(hass, ws_raw_read)
    websocket_api.async_register_command(hass, ws_raw_write)
    websocket_api.async_register_command(hass, ws_reload_definitions)


def _definitions(hass: HomeAssistant) -> dict[str, dict[str, Any]]:
    return hass.data[DOMAIN]["definitions"]


def _ha_device(hass: HomeAssistant, ieee: str):
    return dr.async_get(hass).async_get_device(
        connections={(dr.CONNECTION_ZIGBEE, ieee)}
    )


def _device_def(hass: HomeAssistant, ieee: str) -> dict[str, Any]:
    device = zigbee.get_zigpy_device(hass, ieee)
    device_def = match_definition(_definitions(hass), device.model)
    if device_def is None:
        raise HomeAssistantError(f"No definition for model {device.model}")
    return device_def


def _last_written(hass: HomeAssistant) -> dict[tuple[str, str], Any]:
    """Values written this session for write-only settings (they can't be read back)."""
    return hass.data[DOMAIN].setdefault("last_written", {})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/devices"})
@callback
def ws_devices(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """List all ZHA devices, flagging the ones we have a definition for."""
    try:
        app = zigbee.get_app_controller(hass)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "zha_unavailable", str(err))
        return

    areas = ar.async_get(hass)
    result = []
    for ieee, dev in app.devices.items():
        if dev.nwk == 0x0000:  # coordinator
            continue
        ieee_s = str(ieee)
        ha_dev = _ha_device(hass, ieee_s)
        device_def = match_definition(_definitions(hass), dev.model)
        area = areas.async_get_area(ha_dev.area_id) if ha_dev and ha_dev.area_id else None
        result.append(
            {
                "ieee": ieee_s,
                "name": (ha_dev.name_by_user or ha_dev.name) if ha_dev else ieee_s,
                "area": area.name if area else None,
                "manufacturer": dev.manufacturer,
                "model": dev.model,
                "definition": device_def["name"] if device_def else None,
                "variant": device_def.get("model") if device_def else None,
                "setting_count": len(device_def["settings"]) if device_def else 0,
                "endpoints": {
                    ep_id: sorted(ep.in_clusters)
                    for ep_id, ep in dev.endpoints.items()
                    if ep_id != 0
                },
            }
        )
    result.sort(key=lambda d: (d["definition"] is None, (d["area"] or "~"), d["name"]))
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/device_settings", vol.Required("ieee"): str}
)
@websocket_api.async_response
async def ws_device_settings(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Return the device's settings, with live values read from it where possible."""
    ieee = msg["ieee"]
    try:
        device = zigbee.get_zigpy_device(hass, ieee)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return

    device_def = match_definition(_definitions(hass), device.model)
    if device_def is None:
        connection.send_result(msg["id"], {"definition": None, "settings": []})
        return

    settings = [{**s, "id": s["key"]} for s in device_def["settings"]]
    last = _last_written(hass)

    # Batch reads per (endpoint, cluster, manufacturer).
    groups: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for s in settings:
        target = s.get("target")
        if target:
            groups[(target["endpoint"], target["cluster"], target.get("manufacturer"))].append(s)
        else:
            s["status"] = "WRITE_ONLY"
            s["value"] = last.get((ieee, s["key"]))
    for (ep, cluster, mfr), items in groups.items():
        attr_ids = sorted({s["target"]["attribute"] for s in items})
        values = await zigbee.read_attributes(hass, ieee, ep, cluster, attr_ids, mfr)
        for s in items:
            res = values.get(s["target"]["attribute"], {})
            s["status"] = res.get("status", "NO_RESPONSE")
            s.update(raw_to_ui(s, res.get("value")))

    connection.send_result(
        msg["id"],
        {"definition": device_def["name"], "variant": device_def.get("model"), "settings": settings},
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/write_setting",
        vol.Required("ieee"): str,
        vol.Required("setting_id"): str,
        vol.Required("value"): vol.Any(int, float, bool),
    }
)
@websocket_api.async_response
async def ws_write_setting(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    ieee = msg["ieee"]
    try:
        setting = find_setting(_device_def(hass, ieee), msg["setting_id"])
        if setting is None:
            raise HomeAssistantError(f"Unknown setting {msg['setting_id']}")
        try:
            writes = apply_dynamic(writes_for(setting, msg["value"]), ieee, time.time())
        except (ValueError, TypeError, OverflowError) as err:
            raise HomeAssistantError(str(err)) from err

        status = "SUCCESS"
        for w in writes:
            status = await zigbee.write_attribute(
                hass,
                ieee,
                w["endpoint"],
                w["cluster"],
                w["attribute"],
                w["type"],
                w["value"],
                w.get("manufacturer"),
                raw=bool(w.get("raw")),
            )
            if status != "SUCCESS":
                break

        target = setting.get("target")
        if target is None:
            if status == "SUCCESS":
                _last_written(hass)[(ieee, setting["key"])] = msg["value"]
            connection.send_result(msg["id"], {"status": status, "value": msg["value"] if status == "SUCCESS" else None})
            return

        # Read back so the UI shows what the device actually holds.
        readback = await zigbee.read_attributes(
            hass, ieee, target["endpoint"], target["cluster"], [target["attribute"]], target.get("manufacturer")
        )
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return

    res = readback.get(target["attribute"], {})
    if res.get("status") == "SUCCESS":
        connection.send_result(msg["id"], {"status": status, **raw_to_ui(setting, res.get("value"))})
    else:
        # Some devices don't answer reads for every attribute; trust the write status.
        connection.send_result(msg["id"], {"status": status, "value": msg["value"] if status == "SUCCESS" else None})


RAW_SCHEMA = {
    vol.Required("ieee"): str,
    vol.Required("endpoint"): vol.Coerce(int),
    vol.Required("cluster"): vol.Coerce(int),
    vol.Required("attribute"): vol.Coerce(int),
    vol.Optional("manufacturer"): vol.Any(None, vol.Coerce(int)),
}


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/raw_read", **RAW_SCHEMA})
@websocket_api.async_response
async def ws_raw_read(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        values = await zigbee.read_attributes(
            hass, msg["ieee"], msg["endpoint"], msg["cluster"], [msg["attribute"]], msg.get("manufacturer")
        )
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "read_failed", str(err))
        return
    connection.send_result(msg["id"], values[msg["attribute"]])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/raw_write",
        **RAW_SCHEMA,
        vol.Required("data_type"): vol.Coerce(int),
        vol.Required("value"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_raw_write(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        status = await zigbee.write_attribute(
            hass,
            msg["ieee"],
            msg["endpoint"],
            msg["cluster"],
            msg["attribute"],
            msg["data_type"],
            msg["value"],
            msg.get("manufacturer"),
        )
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(msg["id"], {"status": status})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/reload_definitions"})
@websocket_api.async_response
async def ws_reload_definitions(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    index = await hass.async_add_executor_job(load_definitions, hass)
    hass.data[DOMAIN]["definitions"] = index
    connection.send_result(msg["id"], {"models": len(index)})
