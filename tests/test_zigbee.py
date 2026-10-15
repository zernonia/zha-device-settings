"""Exercise definitions + typed raw read/write against real zigpy clusters (radio mocked)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import zigpy.types as t
from zigpy.zcl import foundation
from zigpy.zcl.clusters.general import Basic

from custom_components.zha_device_settings import definitions as defs_mod  # noqa: E402
from custom_components.zha_device_settings import zigbee

ROOT = Path(__file__).parent.parent / "custom_components/zha_device_settings"
IEEE = "00:11:22:33:44:55:66:77"


def load_index():
    index = {}
    for f in (ROOT / "definitions").glob("*.json"):
        for dev in json.loads(f.read_text())["devices"]:
            for m in dev["models"]:
                index[m] = dev
    return index


INDEX = load_index()


def _setting(model, key):
    return defs_mod.find_setting(INDEX[model], key)


def test_z1_double_rocker_generated_correctly():
    dev = defs_mod.match_definition(INDEX, "lumi.switch.acn049")
    assert dev["model"] == "ZNQBKG39LM"
    keys = {s["key"] for s in dev["settings"]}
    assert {"operation_mode_top", "operation_mode_bottom", "lock_relay_top", "power_on_behavior",
            "led_disabled_night", "click_mode"} <= keys
    top = _setting("lumi.switch.acn049", "operation_mode_top")["target"]
    bottom = _setting("lumi.switch.acn049", "operation_mode_bottom")["target"]
    assert (top["endpoint"], top["cluster"], top["attribute"], top["type"], top["manufacturer"]) == (1, 0xFCC0, 0x0200, 0x20, 0x115F)
    assert bottom["endpoint"] == 2
    # the Z1 overrides click_mode's attribute to 0x0286
    assert _setting("lumi.switch.acn049", "click_mode")["target"]["attribute"] == 0x0286


def test_z1_pro_has_anti_flicker():
    s = _setting("lumi.switch.acn057", "mode_switch")
    assert s["target"]["attribute"] == 0x0004 and s["target"]["type"] == 0x21
    assert [o["raw"] for o in s["options"]] == [1, 4]


def test_all_definitions_well_formed():
    assert len(INDEX) > 100
    for model, dev in INDEX.items():
        keys = [s["key"] for s in dev["settings"]]
        assert len(keys) == len(set(keys)), model
        for s in dev["settings"]:
            assert s["control"] in ("select", "toggle", "number"), (model, s["key"])
            if s["control"] == "number":
                assert s["target"], (model, s["key"])
            else:
                for o in s["options"]:
                    assert ("raw" in o) == bool(s["target"]), (model, s["key"])
                    for w in o.get("writes", []):
                        assert w["type"] in zigbee.DATA_TYPES, (model, s["key"], w["type"])
            if s["target"]:
                assert s["target"]["type"] in zigbee.DATA_TYPES, (model, s["key"])


def test_raw_ui_roundtrip_select():
    s = _setting("lumi.switch.acn049", "power_on_behavior")
    assert defs_mod.raw_to_ui(s, 1)["value"] == 1  # "Previous"
    w = defs_mod.writes_for(s, 2)
    assert w == [{**s["target"], "value": 2}]


def test_number_scaling_roundtrip():
    s = {"control": "number", "target": {"endpoint": 1, "cluster": 1, "attribute": 2, "type": 0x21, "manufacturer": None},
         "scale": 10, "offset": 0}
    assert defs_mod.writes_for(s, 2.5)[0]["value"] == 25
    assert defs_mod.raw_to_ui(s, 25)["value"] == 2.5


def test_float_number_not_rounded():
    s = {"control": "number", "target": {"endpoint": 1, "cluster": 1, "attribute": 2, "type": 0x39, "manufacturer": None},
         "scale": 1, "offset": 0}
    assert defs_mod.writes_for(s, 12.5)[0]["value"] == 12.5


def test_write_only_option_returns_its_writes():
    s = {"control": "select", "target": None,
         "options": [{"label": "A", "writes": [{"endpoint": 1, "cluster": 0, "attribute": 0xFFF0, "type": 0x41, "manufacturer": 0x115F, "value": [1, 2]}]}]}
    assert defs_mod.writes_for(s, 0)[0]["value"] == [1, 2]


class FakeEndpoint:
    def __init__(self):
        self.in_clusters = {}

    def add_input_cluster(self, cid, cluster=None):
        from zigpy.zcl import Cluster

        c = Cluster.from_id(self, cid, is_server=True)
        self.in_clusters[cid] = c
        return c


def make_device():
    ep = FakeEndpoint()
    ep.device = None
    return SimpleNamespace(ieee=IEEE, endpoints={1: ep, 2: FakeEndpoint()}, model="lumi.switch.acn057")


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_write_builds_typed_manufacturer_frame():
    device = make_device()
    with patch.object(zigbee, "get_zigpy_device", return_value=device):
        sent = {}

        async def fake_write(self, attrs, manufacturer=None, **kw):
            sent["attrs"] = attrs
            sent["mfr"] = manufacturer
            return foundation.WriteAttributesResponse.deserialize(b"\x00")[0]

        from zigpy.zcl import Cluster

        with patch.object(Cluster, "_write_attributes", fake_write):
            status = run(zigbee.write_attribute(None, IEEE, 2, 0xFCC0, 0x0200, 0x20, 0, 0x115F))

    assert status == "SUCCESS"
    assert sent["mfr"] == 0x115F
    rec = sent["attrs"][0]
    assert rec.attrid == 0x0200
    assert rec.value.type == 0x20 and isinstance(rec.value.value, t.uint8_t) and rec.value.value == 0
    # endpoint 2 didn't advertise 0xFCC0; it should have been added
    assert 0xFCC0 in device.endpoints[2].in_clusters


def test_write_bool_and_uint16():
    device = make_device()
    captured = []

    async def fake_write(self, attrs, manufacturer=None, **kw):
        captured.append(attrs[0])
        return foundation.WriteAttributesResponse.deserialize(b"\x00")[0]

    from zigpy.zcl import Cluster

    with patch.object(zigbee, "get_zigpy_device", return_value=device), patch.object(Cluster, "_write_attributes", fake_write):
        run(zigbee.write_attribute(None, IEEE, 1, 0xFCC0, 0x0203, 0x10, 1, 0x115F))
        run(zigbee.write_attribute(None, IEEE, 1, 0xFCC0, 0x0004, 0x21, 4, 0x115F))
    assert captured[0].value.value is t.Bool.true or captured[0].value.value == 1
    assert captured[0].serialize().hex() == "03021001"
    assert captured[1].serialize().hex() == "0400210400"


def test_read_parses_records_and_failures():
    device = make_device()
    ok = foundation.ReadAttributeRecord(
        attrid=0x0517, status=foundation.Status.SUCCESS, value=foundation.TypeValue(type=0x20, value=t.uint8_t(1))
    )
    missing = foundation.ReadAttributeRecord(attrid=0x0286, status=foundation.Status.UNSUPPORTED_ATTRIBUTE)

    from zigpy.zcl import Cluster

    with patch.object(zigbee, "get_zigpy_device", return_value=device), patch.object(
        Cluster, "_read_attributes", AsyncMock(return_value=[[ok, missing]])
    ):
        out = run(zigbee.read_attributes(None, IEEE, 1, 0xFCC0, [0x0517, 0x0286, 0x0203], 0x115F))

    assert out[0x0517] == {"value": 1, "status": "SUCCESS"}
    assert out[0x0286]["value"] is None and "UNSUPPORTED" in out[0x0286]["status"]
    assert out[0x0203]["status"] == "NO_RESPONSE"


def test_read_timeout_is_reported_not_raised():
    device = make_device()
    from zigpy.zcl import Cluster

    with patch.object(zigbee, "get_zigpy_device", return_value=device), patch.object(
        Cluster, "_read_attributes", AsyncMock(side_effect=asyncio.TimeoutError())
    ):
        out = run(zigbee.read_attributes(None, IEEE, 1, 0xFCC0, [0x0517], 0x115F))
    assert out[0x0517]["status"].startswith("ERROR")


def test_write_float_and_bytes_serialize():
    device = make_device()
    captured = []

    async def fake_write(self, attrs, manufacturer=None, **kw):
        captured.append(attrs[0])
        return foundation.WriteAttributesResponse.deserialize(b"\x00")[0]

    from zigpy.zcl import Cluster

    with patch.object(zigbee, "get_zigpy_device", return_value=device), patch.object(Cluster, "_write_attributes", fake_write):
        run(zigbee.write_attribute(None, IEEE, 1, 0xFCC0, 0x020B, 0x39, 2300, 0x115F))
        run(zigbee.write_attribute(None, IEEE, 1, 0x0000, 0xFFF0, 0x41, [0xAA, 0x10], 0x115F))
    assert captured[0].serialize().hex() == "0b0239" + "00c00f45"  # 2300.0 as float32 LE
    assert captured[1].serialize().hex() == "f0ff4102aa10"


def test_led_at_night_is_positive_toggle():
    # Z2M's "led_disabled_night" is a double negative; we expose it as "LED indicator at night"
    # where On (option index 1) must write 0 = "not disabled".
    s = _setting("lumi.switch.acn049", "led_disabled_night")
    assert s["label"] == "LED indicator at night"
    assert [o["label"] for o in s["options"]] == ["Off", "On"]
    assert defs_mod.writes_for(s, 1)[0]["value"] == 0
    assert defs_mod.raw_to_ui(s, 1)["value"] == 0  # device says disabled -> toggle shows Off
