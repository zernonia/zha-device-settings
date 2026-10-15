# ZHA Device Settings

A Zigbee2MQTT-style settings page for **ZHA** in Home Assistant.

ZHA can already talk to almost any Zigbee setting, but only through raw cluster IDs in *Manage Zigbee device*, and its write service silently drops attributes that the cluster class doesn't know about (common with manufacturer clusters). This integration adds a **Zigbee Settings** sidebar page with:

- **Friendly settings per device**, defined in small JSON files (ported from Zigbee2MQTT converters): dropdowns and toggles, with live values read from the device.
- **Raw attributes tab** for any device: read/write any attribute with an explicit data type and manufacturer code.
- Writes go straight through zigpy as typed ZCL frames, then read back so the UI shows what the device actually holds.

## Supported devices (bundled definitions)

| Device | Models | Settings |
|---|---|---|
| Aqara Smart Wall Switch Z1 Pro (1/2/3/4 rocker) | `lumi.switch.acn056`–`acn059` (ZNQBKG42LM–45LM) | Button mode (decoupled) per rocker, lock relay per rocker, click mode, power-on behaviour, anti-flicker / quick mode, LED off at night |

## Install

**HACS (recommended):**
1. HACS → ⋮ (top right) → **Custom repositories**
2. Repository: `https://github.com/zernonia/zha-device-settings` — Type: **Integration** → Add
3. Search *ZHA Device Settings* in HACS → **Download** → restart Home Assistant

Updates then appear in **Settings → Updates** like any other HACS integration.

**Manual:** copy `custom_components/zha_device_settings` into `/config/custom_components/` → restart.

Then **Settings → Devices & services → Add integration → ZHA Device Settings**. A *Zigbee Settings* item appears in the sidebar (admin only).

## Adding a device

Drop a JSON file in `/config/zha_device_settings/` (a definition with the same `id` overrides a bundled one). Use `definitions/aqara_z1_pro.json` as the template:

```jsonc
{
  "id": "my_device",
  "name": "Brand Model",
  "match": { "models": { "<zigpy model string>": { "label": "Variant", "relay_endpoints": { "Left": 1, "Right": 2 } } } },
  "defaults": { "cluster": 64704, "manufacturer": 4447, "endpoint": 1 },
  "settings": [
    { "key": "led", "label": "LED", "group": "Indicator", "attribute": 515, "type": 16, "control": "toggle" },
    { "key": "mode", "label": "Mode", "attribute": 4, "type": 33, "control": "select",
      "options": [{ "label": "A", "value": 1 }, { "label": "B", "value": 4 }] },
    { "key": "per_button", "label": "Per button", "per_relay_endpoint": true, "attribute": 512, "type": 32, "control": "select", "options": [] }
  ]
}
```

- `type` is the ZCL data type id (16 = bool, 32 = uint8, 33 = uint16, 48 = enum8 …).
- `control`: `select`, `toggle` or `number` (with optional `min`/`max`).
- `per_relay_endpoint: true` renders the setting once per entry in the variant's `relay_endpoints`.
- The zigpy model string is shown under each device in the panel's list (and in ZHA's device info).

To find attribute IDs, open the device's converter in [zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters/tree/master/src/devices) and follow the `modernExtend` helpers to their `attribute: {ID, type}`.

## Notes for the Z1 Pro

- **Decoupled mode** stops the rocker from switching its relay. ZHA needs to receive the press as an event for automations; check *Logbook* / `zha_event` after switching. If presses don't show up, the device needs a quirk for its multistate input — that's the next piece to add.
- Mains-powered switches answer reads immediately. Sleepy battery devices may not respond until woken.

## Releasing an update

Bump `version` in `custom_components/zha_device_settings/manifest.json` and push to `main`. The *Release* workflow creates a `vX.Y.Z` tag and GitHub release, and HACS offers it as an update. Pushes that don't change the version stay unreleased.

## Development

```
custom_components/zha_device_settings/
  __init__.py        # registers panel, static files, websocket API
  websocket.py       # devices / device_settings / write_setting / raw_read / raw_write / reload_definitions
  zigbee.py          # typed raw ZCL read/write via ZHA's zigpy controller
  definitions.py     # loads + expands JSON definitions
  definitions/*.json # bundled device definitions
  frontend/zha-device-settings-panel.js  # panel (vanilla web component, no build)
```

After editing a definition, call the `zha_device_settings/reload_definitions` websocket command or restart.
