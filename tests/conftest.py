"""Load the integration's modules without running its HA-dependent package __init__.

Run with: pip install zigpy pytest homeassistant && pytest tests
"""

import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).parent.parent / "custom_components" / "zha_device_settings"
sys.path.insert(0, str(ROOT.parent.parent))

pkg = types.ModuleType("custom_components.zha_device_settings")
pkg.__path__ = [str(ROOT)]
sys.modules["custom_components.zha_device_settings"] = pkg
