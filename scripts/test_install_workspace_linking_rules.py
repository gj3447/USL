#!/usr/bin/env python3
"""Focused tests for the explicit local workspace-linking rule installer."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("install-workspace-linking-rules.py")
SPEC = importlib.util.spec_from_file_location("workspace_rules", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RULES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RULES)

POLICY = b"""# Local policy\n<!-- usl-workspace-linking:begin -->\n- explicit consent\n<!-- usl-workspace-linking:end -->\n"""


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        self.payload = self.root / "workspace-linking.md"
        self.payload.write_bytes(POLICY)
        self.old_payload = RULES.PAYLOAD_PATH
        RULES.PAYLOAD_PATH = self.payload

    def tearDown(self) -> None:
        RULES.PAYLOAD_PATH = self.old_payload
        self.temp.cleanup()

    def test_preview_apply_and_idempotence_preserve_surrounding_bytes(self) -> None:
        agents = self.repo / "AGENTS.md"
        original = b"before\r\n"
        agents.write_bytes(original)
        self.assertEqual(RULES.main(["--repo", str(self.repo)]), 0)
        self.assertEqual(agents.read_bytes(), original)
        self.assertEqual(RULES.main(["--apply", "--repo", str(self.repo)]), 0)
        first = agents.read_bytes()
        self.assertTrue(first.startswith(original))
        self.assertIn(RULES.marked_block(POLICY, "test policy"), first)
        self.assertEqual(RULES.main(["--apply", "--repo", str(self.repo)]), 0)
        self.assertEqual(agents.read_bytes(), first)

    def test_refuses_malformed_markers_and_symlink(self) -> None:
        agents = self.repo / "AGENTS.md"
        agents.write_bytes(RULES.BEGIN + b"\n" + RULES.BEGIN + b"\n" + RULES.END)
        self.assertEqual(RULES.main(["--apply", "--repo", str(self.repo)]), 2)
        agents.unlink()
        outside = self.root / "outside.md"
        outside.write_text("outside", encoding="utf-8")
        agents.symlink_to(outside)
        self.assertEqual(RULES.main(["--apply", "--repo", str(self.repo)]), 2)
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside")

    def test_replaces_only_the_existing_marked_section(self) -> None:
        agents = self.repo / "AGENTS.md"
        before = b"prefix\r\n"
        after = b"\r\nsuffix"
        agents.write_bytes(before + RULES.BEGIN + b"\nold\n" + RULES.END + after)
        self.assertEqual(RULES.main(["--apply", "--repo", str(self.repo)]), 0)
        self.assertEqual(agents.read_bytes(), before + RULES.marked_block(POLICY, "test policy") + after)


if __name__ == "__main__":
    unittest.main()
