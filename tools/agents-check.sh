#!/usr/bin/env bash
# Fail if the .agents plugin is malformed: manifests that do not parse or disagree
# on name/version, a skill whose frontmatter `name` is not its directory, a
# skill without a description, or a manifest version that is not the module's.
#
# Same plugin layout as mattmarshall/scope's .agents; this is the cheap static
# half of its scripts/test_codex_plugin.py (no Codex install needed).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 - "$root" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
agents = root / ".agents"
errors = []


def load(p):
    try:
        return json.loads(p.read_text())
    except Exception as e:  # noqa: BLE001 - report any parse failure
        errors.append(f"{p.relative_to(root)}: {e}")
        return {}


plugin = load(agents / "plugin.json")
codex = load(agents / ".codex-plugin" / "plugin.json")
market = load(agents / "plugins" / "marketplace.json")

m = re.search(r'module\(\s*name\s*=\s*"spec",\s*version\s*=\s*"([^"]+)"',
              (root / "MODULE.bazel").read_text())
module_version = m.group(1) if m else None
for label, man in (("plugin.json", plugin), (".codex-plugin/plugin.json", codex)):
    if man.get("name") != "spec":
        errors.append(f"{label}: name {man.get('name')!r} != 'spec'")
    if man.get("version") != module_version:
        errors.append(f"{label}: version {man.get('version')!r} != MODULE.bazel {module_version!r}")

entries = [p for p in market.get("plugins", []) if p.get("name") == "spec"]
if not entries or entries[0].get("source", {}).get("path") != "./.agents":
    errors.append("plugins/marketplace.json: no 'spec' entry with source.path ./.agents")

skills = sorted((agents / "skills").glob("*/SKILL.md"))
if not skills:
    errors.append("no skills under .agents/skills/")
for s in skills:
    text = s.read_text()
    fm = re.match(r"\A---\n(.*?)\n---\n", text, re.S)
    if not fm:
        errors.append(f"{s.relative_to(root)}: missing frontmatter")
        continue
    meta = dict(re.findall(r"^(\w+):\s*(.+)$", fm.group(1), re.M))
    if meta.get("name") != s.parent.name:
        errors.append(f"{s.relative_to(root)}: name {meta.get('name')!r} != dir {s.parent.name!r}")
    if not meta.get("description"):
        errors.append(f"{s.relative_to(root)}: empty description")
    for link in re.findall(r"\]\((?!https?://|#)([^)]+)\)", text):
        if not (s.parent / link).exists():
            errors.append(f"{s.relative_to(root)}: broken link {link}")

agents_md = (root / "AGENTS.md").read_text()
for s in skills:
    if f"`{s.parent.name}`" not in agents_md:
        errors.append(f"AGENTS.md does not route to skill {s.parent.name}")

if errors:
    print("agents check FAILED:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
print(f"agents check OK: {len(skills)} skills, plugin spec@{module_version}")
PY
