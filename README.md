# ZHA Device Settings

A Zigbee2MQTT-style settings page for **ZHA** in Home Assistant.

ZHA can already talk to almost any Zigbee setting, but only through raw cluster IDs in *Manage Zigbee device*, and its write service silently drops attributes that the cluster class doesn't know about (common with manufacturer clusters). This integration adds a **Zigbee Settings** sidebar page with:

- **Friendly settings for every Aqara / Xiaomi (Lumi) device Zigbee2MQTT supports**: dropdowns, toggles and number fields, with live values read from the device.
- **Raw attributes tab** for any device: read/write any attribute with an explicit data type and manufacturer code.
- Writes go straight through zigpy as typed ZCL frames, then read back so the UI shows what the device actually holds.

## Supported devices

**141 Aqara / Xiaomi device types, 649 settings**, generated from [zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters) (Zigbee2MQTT's device library). That includes wall switches (H1, Z1, Z1 Pro, D1, E1, T1 …), relays, plugs, sensors (motion, presence FP1/FP1E, vibration, smoke, gas), curtain motors, dimmers, thermostats and more. Examples:

| Device | zigpy model | Settings |
|---|---|---|
| Smart wall switch Z1 (1–4 rocker) | `lumi.switch.acn048`, `acn049`, `acn054`, `acn055` | Decoupled mode per rocker, lock relay, click mode, power-on behaviour, LED off at night |
| Smart wall switch Z1 Pro (1–4 rocker) | `lumi.switch.acn056`–`acn059` | Same as Z1 plus anti-flicker / quick mode |
| Smart plug EU | `lumi.plug.maeu01` | Power outage memory, LED off at night, overload protection (W), auto-off, button lock |

The device list in the panel shows which of your devices are covered. Settings Zigbee2MQTT can't express as plain attribute writes (schedules, text fields, external-sensor linking, values that need prior device state) aren't included; `tools/lumi.skipped.json` lists them with the reason.

A few settings are **write-only** — Aqara expects them as fixed proprietary frames and doesn't report them back. The panel marks these and remembers the last value set from it.

## Install

**HACS (recommended):**
1. HACS → ⋮ (top right) → **Custom repositories**
2. Repository: `https://github.com/zernonia/zha-device-settings` — Type: **Integration** → Add
3. Search *ZHA Device Settings* in HACS → **Download** → restart Home Assistant

Updates then appear in **Settings → Updates** like any other HACS integration.

**Manual:** copy `custom_components/zha_device_settings` into `/config/custom_components/` → restart.

Then **Settings → Devices & services → Add integration → ZHA Device Settings**. A *Zigbee Settings* item appears in the sidebar (admin only).

## How definitions are generated

`tools/generate.js` doesn't re-implement Zigbee2MQTT's converters, it **runs** them: every settable option is fed each possible value through its converter against a mock device that records the resulting ZCL writes (endpoint, cluster, attribute, data type, manufacturer code, value). Each value is captured twice with different device addresses, and anything whose payload changes between runs (embedded addresses, sequence counters) is dropped, since it couldn't be safely replayed.

```sh
cd tools && npm install && node generate.js lumi   # writes custom_components/.../definitions/lumi.json
```

The *Regenerate definitions* workflow does this monthly against the latest converter release and opens a PR when anything changes. Other vendors can be generated the same way (`node generate.js ikea tuya …`, file names from `zigbee-herdsman-converters/dist/devices/`), though Tuya devices mostly use command-based data points, which aren't supported yet.

## Adding your own definitions

Drop a JSON file in `/config/zha_device_settings/`. Entries there override bundled ones for the same zigpy model. Same shape as the generated files:

```jsonc
{
  "id": "my_devices",
  "devices": [
    {
      "models": ["<zigpy model string>"],   // shown under each device in the panel's list
      "model": "VENDOR-MODEL",
      "name": "Brand Device",
      "settings": [
        { "key": "led", "label": "LED at night", "group": "Configuration", "control": "toggle",
          "target": { "endpoint": 1, "cluster": 64704, "attribute": 515, "type": 16, "manufacturer": 4447 },
          "options": [{ "label": "Off", "raw": 0 }, { "label": "On", "raw": 1 }] },
        { "key": "mode", "label": "Mode", "control": "select",
          "target": { "endpoint": 1, "cluster": 64704, "attribute": 4, "type": 33, "manufacturer": 4447 },
          "options": [{ "label": "Quick", "raw": 1 }, { "label": "Anti-flicker", "raw": 4 }] },
        { "key": "threshold", "label": "Threshold", "control": "number", "min": 0, "max": 100, "step": 1, "unit": "%",
          "target": { "endpoint": 1, "cluster": 64704, "attribute": 300, "type": 32, "manufacturer": 4447 },
          "scale": 1, "offset": 0 }
      ]
    }
  ]
}
```

- `type` is the ZCL data type id (16 bool, 32 uint8, 33 uint16, 35 uint32, 48 enum8, 57 float32, 65 octet string …).
- Toggles list `[off, on]` options. Numbers map with `raw = value × scale + offset`.
- Write-only settings use `"target": null` and give each option a `writes` list instead of `raw`.

After editing, restart HA or call the `zha_device_settings/reload_definitions` websocket command.

## Notes for Aqara wall switches

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
  definitions.py     # loads definitions, maps raw <-> UI values
  definitions/*.json # bundled definitions (generated)
tools/generate.js    # generates definitions by running Z2M converters against a mock device
  frontend/zha-device-settings-panel.js  # panel (vanilla web component, no build)
```

After editing a definition, call the `zha_device_settings/reload_definitions` websocket command or restart.
