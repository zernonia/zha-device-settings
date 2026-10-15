"""Load device definitions and expand them into concrete settings for a device."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant

from .const import USER_DEFINITIONS_DIR

_LOGGER = logging.getLogger(__name__)

BUNDLED_DIR = Path(__file__).parent / "definitions"


def _load_dir(path: Path) -> list[dict[str, Any]]:
    defs: list[dict[str, Any]] = []
    if not path.is_dir():
        return defs
    for file in sorted(path.glob("*.json")):
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            _LOGGER.error("Skipping invalid definition %s: %s", file, err)
            continue
        data.setdefault("id", file.stem)
        data["_source"] = str(file)
        defs.append(data)
    return defs


def load_definitions(hass: HomeAssistant) -> dict[str, dict[str, Any]]:
    """Bundled definitions, then /config/zha_device_settings/*.json (same id overrides)."""
    by_id: dict[str, dict[str, Any]] = {}
    for d in _load_dir(BUNDLED_DIR):
        by_id[d["id"]] = d
    for d in _load_dir(Path(hass.config.path(USER_DEFINITIONS_DIR))):
        by_id[d["id"]] = d
    _LOGGER.debug("Loaded %d device definitions", len(by_id))
    return by_id


def match_definition(
    definitions: dict[str, dict[str, Any]], model: str | None
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Return (definition, model_variant) for a zigpy model string."""
    if not model:
        return None
    for definition in definitions.values():
        variant = definition.get("match", {}).get("models", {}).get(model)
        if variant is not None:
            return definition, variant
    return None


def expand_settings(
    definition: dict[str, Any], variant: dict[str, Any]
) -> list[dict[str, Any]]:
    """Turn definition settings into one concrete entry per (setting, endpoint)."""
    defaults = definition.get("defaults", {})
    relay_eps: dict[str, int] = variant.get("relay_endpoints") or {"": 1}
    out: list[dict[str, Any]] = []
    for setting in definition.get("settings", []):
        base = {
            "cluster": setting.get("cluster", defaults.get("cluster")),
            "manufacturer": setting.get("manufacturer", defaults.get("manufacturer")),
            "attribute": setting["attribute"],
            "type": setting["type"],
            "control": setting.get("control", "number"),
            "options": setting.get("options"),
            "min": setting.get("min"),
            "max": setting.get("max"),
            "description": setting.get("description", ""),
            "group": setting.get("group", "Settings"),
        }
        if setting.get("per_relay_endpoint"):
            for ep_label, ep_id in relay_eps.items():
                label = setting["label"] + (f" ({ep_label})" if ep_label else "")
                out.append(
                    {
                        **base,
                        "id": f"{setting['key']}@{ep_id}",
                        "label": label,
                        "endpoint": ep_id,
                    }
                )
        else:
            ep_id = setting.get("endpoint", defaults.get("endpoint", 1))
            out.append(
                {**base, "id": f"{setting['key']}@{ep_id}", "label": setting["label"], "endpoint": ep_id}
            )
    return out
