"""Exercise definitions + typed raw read/write against real zigpy clusters (radio mocked)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import zigpy.types as t
from zigpy.zcl import foundation
from zigpy.zcl.clusters.general import Basic

from custom_components.zha_device_settings import definitions as defs_mod
from custom_components.zha_device_settings import zigbee

ROOT = Path(__file__).parent.parent / "custom_components/zha_device_settings"
IEEE = "00:11:22:33:44:55:66:77"


def load_z1():
    return json.loads((ROOT / "definitions/aqara_z1_pro.json").read_text())


def test_expand_double_rocker():
    d = load_z1()
    variant = d["match"]["models"]["lumi.switch.acn057"]
    settings = defs_mod.expand_settings(d, variant)
    ids = [s["id"] for s in settings]
    assert "operation_mode@1" in ids and "operation_mode@2" in ids
    assert "lock_relay@2" in ids
    assert "operation_mode@3" not in ids
    pob = next(s for s in settings if s["id"] == "power_on_behavior@1")
    assert (pob["cluster"], pob["attribute"], pob["type"], pob["manufacturer"]) == (0xFCC0, 0x0517, 0x20, 0x115F)
    assert next(s for s in settings if s["id"] == "operation_mode@2")["label"] == "Button mode (Bottom)"


def test_expand_single_rocker_has_no_suffix():
    d = load_z1()
    settings = defs_mod.expand_settings(d, d["match"]["models"]["lumi.switch.acn056"])
    assert next(s for s in settings if s["id"] == "operation_mode@1")["label"] == "Button mode"


def test_match():
    d = load_z1()
    m = defs_mod.match_definition({d["id"]: d}, "lumi.switch.acn059")
    assert m and m[1]["relay_endpoints"] == {"Top": 1, "Center": 2, "Bottom": 3}
    assert defs_mod.match_definition({d["id"]: d}, "lumi.other") is None


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
