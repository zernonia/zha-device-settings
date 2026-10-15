"""Export the (cluster, attribute) pairs ZHA already exposes as entities.

generate.js tags matching settings so the panel can note they're also ZHA entities.

    pip install zha    # plus its radio libraries for imports to succeed
    python3 export_zha_builtins.py > zha_builtin_attributes.json
"""

import dataclasses
import importlib.metadata
import importlib
import json
import pkgutil
import sys

import zha
import zha.application.platforms as platforms
from zigpy.zcl import Cluster

for mod in pkgutil.walk_packages(platforms.__path__, platforms.__name__ + "."):
    try:
        importlib.import_module(mod.name)
    except Exception as err:  # noqa: BLE001
        print(f"skipping {mod.name}: {err}", file=sys.stderr)

from zha.application.platforms import PlatformEntity  # noqa: E402


def subclasses(cls):
    for sub in cls.__subclasses__():
        yield sub
        yield from subclasses(sub)


generic: set[tuple[int, int]] = set()
by_model: dict[str, set[tuple[int, int]]] = {}
by_manufacturer: dict[str, set[tuple[int, int]]] = {}

for cls in set(subclasses(PlatformEntity)):
    attr = getattr(cls, "_attribute_name", None)
    match = getattr(cls, "_cluster_match", None)
    if not isinstance(attr, str) or match is None or not dataclasses.is_dataclass(match):
        continue
    m = dataclasses.asdict(match)
    if m.get("exposed_features") or m.get("profile_device_types"):
        continue  # depends on a quirk or device type; can't tell statically
    for cid in m.get("server_clusters") or ():
        cluster = Cluster._registry.get(cid)
        a = cluster.attributes_by_name.get(attr) if cluster else None
        if a is None:
            continue
        pair = (cid, a.id)
        if m.get("models"):
            for model in m["models"]:
                by_model.setdefault(model, set()).add(pair)
        elif m.get("manufacturers"):
            for manuf in m["manufacturers"]:
                by_manufacturer.setdefault(manuf, set()).add(pair)
        else:
            generic.add(pair)

json.dump(
    {
        "zha_version": importlib.metadata.version("zha"),
        "generic": sorted(generic),
        "by_model": {k: sorted(v) for k, v in sorted(by_model.items())},
        "by_manufacturer": {k: sorted(v) for k, v in sorted(by_manufacturer.items())},
    },
    sys.stdout,
    indent=1,
)
