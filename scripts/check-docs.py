"""Check active local documentation links and immutable pre-consolidation snapshots."""
import hashlib
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[1]
archive = root / "archive/2026-09-14-before-consolidation"
manifest = json.loads((archive / "manifest.json").read_text())
for item in manifest["files"]:
    data = (archive / item["original_path"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == item["sha256"], item["original_path"]

documents = [root / "README.md", root / "LICENSING.md", root / "CONTRIBUTING.md", root / "CLA.md", root / "archive/README.md", root / "audit/README.md", *sorted((root / "docs").glob("*.md")), *sorted((root / "agent-rules").glob("*.md"))]
broken = []
absolute_filesystem_links = []
for document in documents:
    body = re.sub(r"```.*?```", "", document.read_text(), flags=re.S)
    for target in re.findall(r"\]\(([^)]+)\)", body):
        target = target.strip()
        if target.startswith("file://"):
            absolute_filesystem_links.append((str(document.relative_to(root)), target))
            continue
        if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*://", target) or target.startswith("#"):
            continue
        target = target.strip("<>").split("#", 1)[0]
        target = re.sub(r":\d+$", "", target)
        path = pathlib.Path(target)
        if path.is_absolute():
            absolute_filesystem_links.append((str(document.relative_to(root)), target))
            continue
        path = document.parent / path
        if not path.exists():
            broken.append((str(document.relative_to(root)), target))
assert not broken, json.dumps(broken, ensure_ascii=False)
assert not absolute_filesystem_links, json.dumps(absolute_filesystem_links, ensure_ascii=False)
print(json.dumps({"active_documents": len(documents), "archived_hashes_verified": len(manifest["files"]), "broken_links": len(broken), "absolute_filesystem_links": len(absolute_filesystem_links)}))
