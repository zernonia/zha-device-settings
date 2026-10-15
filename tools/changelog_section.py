"""Print the CHANGELOG.md section for a version (used as the GitHub release body).

    python3 tools/changelog_section.py 0.4.2      # prints the notes, exit 1 if missing
    python3 tools/changelog_section.py --manifest # uses the version in manifest.json
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def section(version: str) -> str | None:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
    if not m:
        return None
    body = m.group(1).strip()
    return body or None


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else "--manifest"
    if arg == "--manifest":
        manifest = ROOT / "custom_components" / "zha_device_settings" / "manifest.json"
        arg = json.loads(manifest.read_text())["version"]
    version = arg.lstrip("v")
    body = section(version)
    if body is None:
        print(
            f"CHANGELOG.md has no notes for {version}. Add a '## [{version}] - YYYY-MM-DD' "
            "section describing the release before bumping the version.",
            file=sys.stderr,
        )
        return 1
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
