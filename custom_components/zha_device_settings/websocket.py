"""Websocket API used by the sidebar panel."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import area_registry as ar, device_registry as dr

from . import zigbee
from .const import DOMAIN
from .definitions import expand_settings, load_definitions, match_definition


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


def _find_setting(hass: HomeAssistant, ieee: str, setting_id: str) -> dict[str, Any]:
    device = zigbee.get_zigpy_device(hass, ieee)
    matched = match_definition(_definitions(hass), device.model)
    if matched is None:
        raise HomeAssistantError(f"No definition for model {device.model}")
    for s in expand_settings(*matched):
        if s["id"] == setting_id:
            return s
    raise HomeAssistantError(f"Unknown setting {setting_id}")


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
        matched = match_definition(_definitions(hass), dev.model)
        area = areas.async_get_area(ha_dev.area_id) if ha_dev and ha_dev.area_id else None
        result.append(
            {
                "ieee": ieee_s,
                "name": (ha_dev.name_by_user or ha_dev.name) if ha_dev else ieee_s,
                "area": area.name if area else None,
                "manufacturer": dev.manufacturer,
                "model": dev.model,
                "definition": matched[0]["name"] if matched else None,
                "variant": matched[1].get("label") if matched else None,
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
    """Return the definition's settings for a device, with live values read from it."""
    try:
        device = zigbee.get_zigpy_device(hass, msg["ieee"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return

    matched = match_definition(_definitions(hass), device.model)
    if matched is None:
        connection.send_result(msg["id"], {"definition": None, "settings": []})
        return

    settings = expand_settings(*matched)

    # Batch reads per (endpoint, cluster, manufacturer).
    groups: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for s in settings:
        groups[(s["endpoint"], s["cluster"], s["manufacturer"])].append(s)
    for (ep, cluster, mfr), items in groups.items():
        values = await zigbee.read_attributes(
            hass, msg["ieee"], ep, cluster, [s["attribute"] for s in items], mfr
        )
        for s in items:
            s.update(values.get(s["attribute"], {}))

    connection.send_result(
        msg["id"],
        {
            "definition": matched[0]["name"],
            "variant": matched[1].get("label"),
            "settings": settings,
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/write_setting",
        vol.Required("ieee"): str,
        vol.Required("setting_id"): str,
        vol.Required("value"): vol.Any(int, bool),
    }
)
@websocket_api.async_response
async def ws_write_setting(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        s = _find_setting(hass, msg["ieee"], msg["setting_id"])
        value = int(msg["value"])
        status = await zigbee.write_attribute(
            hass, msg["ieee"], s["endpoint"], s["cluster"], s["attribute"], s["type"], value, s["manufacturer"]
        )
        # Read back so the UI shows what the device actually holds.
        readback = await zigbee.read_attributes(
            hass, msg["ieee"], s["endpoint"], s["cluster"], [s["attribute"]], s["manufacturer"]
        )
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(
        msg["id"], {"status": status, **readback.get(s["attribute"], {})}
    )


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
    defs = await hass.async_add_executor_job(load_definitions, hass)
    hass.data[DOMAIN]["definitions"] = defs
    connection.send_result(msg["id"], {"count": len(defs)})
