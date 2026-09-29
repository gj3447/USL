#!/usr/bin/env python3
"""Mocked focused tests for GitHub workspace-rule synchronization."""

from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("sync-github-workspace-rules.py")
SPEC = importlib.util.spec_from_file_location("github_workspace_sync", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)

POLICY = b"<!-- usl-workspace-linking:begin -->\nrule\n<!-- usl-workspace-linking:end -->"


class FakeGithub:
    def __init__(self, *, archived: bool = False, empty: bool = False, content: bytes | None = b"before\n") -> None:
        self.archived, self.empty, self.content = archived, empty, content
        self.sha = "old-sha" if content is not None else None
        self.calls: list[tuple[list[str], object | None]] = []
        self.fail_put = False
        self.fail_restore = False
        self.tree_mode = "100644"
        self.empty_default_branch = False

    def __call__(self, arguments: list[str], input_bytes: bytes | None) -> tuple[int, bytes, bytes]:
        payload = json.loads(input_bytes) if input_bytes is not None else None
        self.calls.append((arguments, payload))
        endpoint = arguments[arguments.index("--input") - 1] if "--input" in arguments else arguments[-1]
        method = arguments[arguments.index("-X") + 1] if "-X" in arguments else "GET"
        if endpoint == "repos/gj3447/demo" and method == "GET":
            branch = "main" if (not self.empty or self.empty_default_branch) else None
            return 0, json.dumps({"archived": self.archived, "size": 0 if self.empty else 1, "default_branch": branch}).encode(), b""
        if endpoint.startswith("repos/gj3447/demo/git/trees/") and method == "GET":
            if self.empty:
                return 1, b"", b"HTTP 409 Git Repository is empty."
            entries = [] if self.content is None else [{"path": "AGENTS.md", "type": "blob", "mode": self.tree_mode}]
            return 0, json.dumps({"tree": entries}).encode(), b""
        if endpoint.startswith("repos/gj3447/demo/contents/AGENTS.md") and method == "GET":
            if self.content is None:
                return 1, b"", b"HTTP 404 Not Found"
            return 0, json.dumps({"type": "file", "size": len(self.content), "sha": self.sha, "content": base64.b64encode(self.content).decode()}).encode(), b""
        if endpoint == "repos/gj3447/demo" and method == "PATCH":
            if payload["archived"] and self.fail_restore:
                return 1, b"", b"HTTP 500 restore failed"
            self.archived = payload["archived"]
            return 0, json.dumps({"archived": self.archived}).encode(), b""
        if endpoint == "repos/gj3447/demo/contents/AGENTS.md" and method == "PUT":
            if self.fail_put:
                return 1, b"", b"HTTP 409 conflict"
            if self.content is not None and payload.get("sha") != self.sha:
                return 1, b"", b"HTTP 409 conflict"
            self.content = base64.b64decode(payload["content"])
            self.sha = "new-sha"
            self.empty = False
            return 0, json.dumps({"commit": {"sha": "commit-sha"}}).encode(), b""
        raise AssertionError((arguments, payload))


class SyncTests(unittest.TestCase):
    def item(self, *, archived: bool = False, empty: bool = False) -> dict[str, object]:
        return {"nameWithOwner": "gj3447/demo", "isArchived": archived, "isEmpty": empty, "defaultBranchRef": None if empty else {"name": "main"}, "visibility": "PRIVATE"}

    def test_cas_write_and_verification(self) -> None:
        fake = FakeGithub()
        result = SYNC.synchronize_one(fake, self.item(), POLICY, True, False)
        self.assertEqual(result["status"], "COMMITTED")
        put = next(payload for args, payload in fake.calls if "PUT" in args and any(arg.endswith("contents/AGENTS.md") for arg in args))
        self.assertEqual(put["sha"], "old-sha")
        self.assertEqual(fake.content, b"before\n\n" + POLICY + b"\n")

    def test_refuses_bad_markers_and_idempotence(self) -> None:
        malformed = SYNC.BEGIN if hasattr(SYNC, "BEGIN") else b"<!-- usl-workspace-linking:begin -->"
        fake = FakeGithub(content=malformed)
        with self.assertRaises(SYNC.SyncError):
            SYNC.synchronize_one(fake, self.item(), POLICY, True, False)
        current = b"before\n\n" + POLICY + b"\n"
        unchanged = FakeGithub(content=current)
        result = SYNC.synchronize_one(unchanged, self.item(), POLICY, True, False)
        self.assertEqual(result["status"], "UNCHANGED")
        self.assertFalse(any("PUT" in args for args, _ in unchanged.calls))

    def test_refuses_git_symlink_before_contents_read(self) -> None:
        fake = FakeGithub()
        fake.tree_mode = "120000"
        with self.assertRaises(SYNC.SyncError):
            SYNC.synchronize_one(fake, self.item(), POLICY, True, False)
        self.assertFalse(any("contents/AGENTS.md" in args[-1] for args, _ in fake.calls))

    def test_archive_is_restored_when_write_fails(self) -> None:
        fake = FakeGithub(archived=True)
        fake.fail_put = True
        with self.assertRaises(SYNC.SyncError):
            SYNC.synchronize_one(fake, self.item(archived=True), POLICY, True, True)
        self.assertTrue(fake.archived)
        patches = [payload["archived"] for args, payload in fake.calls if "PATCH" in args]
        self.assertEqual(patches, [False, True])

    def test_empty_repository_creates_main_without_source_sha(self) -> None:
        fake = FakeGithub(empty=True, content=None)
        result = SYNC.synchronize_one(fake, self.item(empty=True), POLICY, True, False)
        self.assertEqual(result["status"], "COMMITTED")
        put = next(payload for args, payload in fake.calls if "PUT" in args)
        self.assertEqual(put["branch"], "main")
        self.assertNotIn("sha", put)

    def test_empty_repository_with_main_branch_uses_exact_empty_tree_response(self) -> None:
        fake = FakeGithub(empty=True, content=None)
        fake.empty_default_branch = True
        result = SYNC.synchronize_one(fake, self.item(empty=True), POLICY, True, False)
        self.assertEqual(result["status"], "COMMITTED")

    def test_restore_error_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            inventory = Path(temporary) / "inventory.json"
            inventory.write_text(json.dumps([self.item(archived=True)]), encoding="utf-8")
            output = Path(temporary) / "report.json"
            fake = FakeGithub(archived=True)
            fake.fail_restore = True
            old_load = SYNC.INSTALLER.load_policy
            SYNC.INSTALLER.load_policy = lambda: POLICY
            try:
                self.assertEqual(SYNC.main(["--owner", "gj3447", "--inventory", str(inventory), "--output", str(output), "--apply", "--include-archived"], fake), 2)
            finally:
                SYNC.INSTALLER.load_policy = old_load
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["results"][0]["status"], "FAILED")

    def test_main_writes_private_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            inventory = Path(temporary) / "inventory.json"
            inventory.write_text(json.dumps([self.item()]), encoding="utf-8")
            output = Path(temporary) / "private" / "report.json"
            fake = FakeGithub()
            old_load = SYNC.INSTALLER.load_policy
            SYNC.INSTALLER.load_policy = lambda: POLICY
            try:
                self.assertEqual(SYNC.main(["--owner", "gj3447", "--inventory", str(inventory), "--output", str(output)], fake), 0)
            finally:
                SYNC.INSTALLER.load_policy = old_load
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["results"][0]["status"], "WOULD_COMMIT")

    def test_default_runner_uses_stdin_only_when_needed_and_has_timeout(self) -> None:
        completed = type("Completed", (), {"returncode": 0, "stdout": b"{}", "stderr": b""})()
        with patch.object(SYNC.subprocess, "run", return_value=completed) as run:
            SYNC.default_runner(["gh", "api"], None)
            self.assertEqual(run.call_args.kwargs["stdin"], SYNC.subprocess.DEVNULL)
            self.assertNotIn("input", run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs["timeout"], 45)
            SYNC.default_runner(["gh", "api", "--input", "-"], b"{}")
            self.assertEqual(run.call_args.kwargs["input"], b"{}")
            self.assertNotIn("stdin", run.call_args.kwargs)

    def test_default_runner_converts_timeout_without_exposing_payload(self) -> None:
        with patch.object(SYNC.subprocess, "run", side_effect=SYNC.subprocess.TimeoutExpired(["gh"], 45)):
            with self.assertRaisesRegex(SYNC.SyncError, "timed out after 45") as caught:
                SYNC.default_runner(["gh", "api"], b"private payload")
        self.assertNotIn("private payload", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
