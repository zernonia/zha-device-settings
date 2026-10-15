# Changelog

Release notes for ZHA Device Settings. Each version's section is published as its GitHub release, which is what Home Assistant shows in the update dialog.

How to release: move the items under **Unreleased** into a new `## [x.y.z] - YYYY-MM-DD` section, set the same version in `custom_components/zha_device_settings/manifest.json`, and push to `main`. The release is created automatically, and is refused if the version has no section here.

## [Unreleased]

## [0.4.2] - 2026-10-15

### Changed
- The logo is now red, to match ZHA's own icon.

### Added
- A Buy Me a Coffee link in the README and a Sponsor button on GitHub, for anyone who wants to support the project.

## [0.4.1] - 2026-10-15

### Added
- The integration has its own icon and logo. On Home Assistant 2026.3 and newer they show on the integration's card under **Settings → Devices & services** (restart Home Assistant after updating). The HACS store list still shows a placeholder until HACS supports icons shipped with integrations.
- The README now explains why this plugin exists.

## [0.4.0] - 2026-10-15

### Changed
- **Every setting for a device is on one page again**, including ones ZHA already shows as entities (start-up behaviour, transition times, thermostat calibration and similar). Those are marked **Also in ZHA**. Coverage is now 971 device types and 2,288 settings.

### Fixed
- Changing a setting here now updates ZHA's own entity for it right away. Before, the ZHA entity could keep showing the old value until its next poll.

## [0.3.0] - 2026-10-15

### Added
- **Sonoff** support: TRVZB and TRV-ZBT valve opening/closing degree, frost protection, temperature accuracy and external temperature sensor; SWV water valve irrigation duration, amount and fail-safe; SNZB presence and sensor settings.
- **Philips Hue** support: motion sensor LED and sensitivity, wall switch module device mode.
- **IKEA** support: INSPELNING and TRETAKT plug child lock and LED, STARKVIND air purifier, VALLHORN motion sensor timer.
- Aqara thermostats (W100 / TH-S04D, WT-A03E, E1 radiator valve) can switch between internal and external temperature sensor.

### Fixed
- Aqara thermostat sensor settings now carry the current time and the device's own address, instead of fixed values.
- Number settings can no longer be set beyond what the device can store (for example Aqara motion detection interval is now limited to 2–255 seconds).

### Note
- This release only listed settings that ZHA didn't already offer. 0.4.0 brought the rest back.

## [0.2.1] - 2026-10-15

### Changed
- "LED disabled night" is now **LED indicator at night**, and the toggle means what it says: on keeps the LED lit at night, off keeps it dark.
- Clearer names and descriptions for common Aqara settings: Button mode (decoupled), Invert indicator LED, Restore state after power loss, Switch mode, Click mode.

### Upgrade note
- The LED-at-night toggle is reversed compared to 0.2.0. Your switch keeps its current behaviour, but if you had turned the old toggle **off**, the new one will show **on**.

## [0.2.0] - 2026-10-15

### Added
- **All Aqara / Xiaomi devices** that Zigbee2MQTT supports: 141 device types, including the Z1 wall switches (`lumi.switch.acn048`, `acn049`, `acn054`, `acn055`) alongside the Z1 Pro.
- Number settings with units and ranges (for example plug overload protection in watts).
- Settings the device can't report back are marked as write-only and show the last value set from the panel.

## [0.1.0] - 2026-10-15

### Added
- First release: a **Zigbee Settings** page in the Home Assistant sidebar for ZHA devices.
- Aqara Smart Wall Switch Z1 Pro (1–4 rocker): decoupled mode and relay lock per rocker, click mode, power-on behaviour, anti-flicker mode, LED at night.
- **Raw attributes** tab to read or write any attribute on any ZHA device.
