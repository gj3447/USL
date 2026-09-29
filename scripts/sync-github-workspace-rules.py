#!/usr/bin/env python3
"""Safely preview or apply the USL workspace-linking rule to GitHub repositories.

The default is a read-only preview.  ``--apply`` is deliberately required for
each remote write.  The generated report may contain private repository names,
so its destination is required and must be an absolute local path.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable
from urllib.parse import quote


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
INSTALLER_PATH = SCRIPT_DIRECTORY / "install-workspace-linking-rules.py"
MAX_AGENTS_BYTES = 1024 * 1024
DEFAULT_BRANCH_FOR_EMPTY_REPOSITORY = "main"

# Importing the local byte-preserving marker implementation prevents the two
# installation paths from drifting.  It is deliberately loaded without bytecode
# output so a preview never dirties the checkout.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("usl_workspace_rule_installer", INSTALLER_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"cannot load {INSTALLER_PATH}")
INSTALLER = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(INSTALLER)


class SyncError(Exception):
    """An individual repository cannot safely be synchronized."""


Runner = Callable[[list[str], bytes | None], tuple[int, bytes, bytes]]


def default_runner(arguments: list[str], input_bytes: bytes | None) -> tuple[int, bytes, bytes]:
    options: dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "check": False,
        "timeout": 45,
    }
    if input_bytes is None:
        options["stdin"] = subprocess.DEVNULL
    else:
        options["input"] = input_bytes
    try:
        completed = subprocess.run(
            arguments,
            **options,
        )
    except subprocess.TimeoutExpired as error:
        raise SyncError("gh invocation timed out after 45 seconds") from error
    except OSError as error:
        raise SyncError(f"cannot invoke gh: {error.strerror or error.__class__.__name__}") from error
    return completed.returncode, completed.stdout, completed.stderr


def gh_json(runner: Runner, arguments: list[str], payload: object | None = None) -> Any:
    input_bytes = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    command = ["gh", "api", "--hostname", "github.com", *arguments]
    if payload is not None:
        command.extend(["--input", "-"])
    code, stdout, stderr = runner(command, input_bytes)
    if code:
        message = stderr.decode("utf-8", "replace").strip() or f"gh api exited {code}"
        raise SyncError(message)
    try:
        return json.loads(stdout.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SyncError("GitHub returned invalid JSON") from error


def gh_cli_json(runner: Runner, arguments: list[str]) -> Any:
    code, stdout, stderr = runner(arguments, None)
    if code:
        raise SyncError(stderr.decode("utf-8", "replace").strip() or f"gh exited {code}")
    try:
        return json.loads(stdout.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SyncError("GitHub CLI returned invalid JSON") from error


def required_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise SyncError(f"{label} must be a non-empty string")
    return value


def canonical_inventory(value: object, owner: str, selected: set[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise SyncError("inventory must be a JSON array")
    repositories: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise SyncError("inventory entries must be objects")
        name = required_string(item.get("nameWithOwner"), "nameWithOwner")
        expected_prefix = f"{owner}/"
        if not name.startswith(expected_prefix) or not name[len(expected_prefix):] or "/" in name[len(expected_prefix):]:
            raise SyncError(f"inventory repository is outside --owner: {name}")
        if name in seen:
            raise SyncError(f"inventory contains a duplicate repository: {name}")
        seen.add(name)
        if selected and name not in selected:
            continue
        if (not isinstance(item.get("isArchived"), bool) or not isinstance(item.get("isEmpty"), bool)
                or not isinstance(item.get("visibility"), str)):
            raise SyncError(f"inventory metadata is incomplete for {name}")
        branch = item.get("defaultBranchRef")
        if branch is not None and (not isinstance(branch, dict) or not isinstance(branch.get("name"), str)):
            raise SyncError(f"defaultBranchRef is invalid for {name}")
        repositories.append(dict(item))
    missing = selected - seen
    if missing:
        raise SyncError("--repo is absent from inventory: " + ", ".join(sorted(missing)))
    return repositories


def load_inventory(args: argparse.Namespace, runner: Runner) -> list[dict[str, Any]]:
    if args.inventory:
        try:
            raw = Path(args.inventory).read_bytes()
            data = json.loads(raw.decode("utf-8", "strict"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SyncError(f"cannot read inventory: {error}") from error
    else:
        data = gh_cli_json(runner, ["gh", "repo", "list", args.owner, "--limit", "1000", "--json", "nameWithOwner,isArchived,isEmpty,defaultBranchRef,visibility"])
    return canonical_inventory(data, args.owner, set(args.repo))


def read_remote_repository(runner: Runner, name: str) -> dict[str, Any]:
    data = gh_json(runner, ["-X", "GET", f"repos/{name}"])
    if not isinstance(data, dict):
        raise SyncError("repository response is not an object")
    return data


def verify_agents_tree(runner: Runner, name: str, branch: str, allow_absent_tree: bool) -> None:
    try:
        tree = gh_json(runner, ["-X", "GET", f"repos/{name}/git/trees/{quote(branch, safe='')}"])
    except SyncError as error:
        message = str(error)
        if allow_absent_tree and ("404" in message or "Not Found" in message or
                                  ("409" in message and "Git Repository is empty" in message)):
            return
        raise
    if not isinstance(tree, dict) or not isinstance(tree.get("tree"), list):
        raise SyncError("Git tree response is invalid")
    entries = [entry for entry in tree["tree"] if isinstance(entry, dict) and entry.get("path") == "AGENTS.md"]
    if not entries:
        return
    if len(entries) != 1 or entries[0].get("type") != "blob" or entries[0].get("mode") not in ("100644", "100755"):
        raise SyncError("AGENTS.md must be a regular Git blob, not a symlink or directory")


def read_agents(runner: Runner, name: str, branch: str, allow_absent_tree: bool = False) -> tuple[bytes | None, str | None]:
    verify_agents_tree(runner, name, branch, allow_absent_tree)
    try:
        data = gh_json(runner, ["-X", "GET", f"repos/{name}/contents/AGENTS.md?ref={quote(branch, safe='')}"])
    except SyncError as error:
        # gh's REST error does not expose a stable machine error field through
        # stderr.  A missing AGENTS.md is only accepted when its normal 404 text
        # is present; every other error remains fail-closed.
        if "404" in str(error) or "Not Found" in str(error):
            return None, None
        raise
    if not isinstance(data, dict):
        raise SyncError("AGENTS.md response is not an object")
    if data.get("type") != "file":
        raise SyncError("AGENTS.md is not a regular file")
    size = data.get("size")
    if not isinstance(size, int) or size < 0 or size > MAX_AGENTS_BYTES:
        raise SyncError("AGENTS.md exceeds the 1 MiB limit")
    encoded, blob_sha = data.get("content"), data.get("sha")
    if not isinstance(encoded, str) or not isinstance(blob_sha, str):
        raise SyncError("AGENTS.md response lacks content or SHA")
    try:
        content = base64.b64decode("".join(encoded.split()).encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError) as error:
        raise SyncError("AGENTS.md content is not valid base64") from error
    if len(content) != size or len(content) > MAX_AGENTS_BYTES:
        raise SyncError("AGENTS.md size changed while reading")
    return content, blob_sha


def desired_agents(previous: bytes | None, policy: bytes) -> bytes:
    try:
        return INSTALLER.updated_agents(previous, policy)
    except INSTALLER.InstallError as error:
        raise SyncError(str(error)) from error


def patch_archived(runner: Runner, name: str, archived: bool) -> None:
    response = gh_json(runner, ["-X", "PATCH", f"repos/{name}"], {"archived": archived})
    if not isinstance(response, dict) or response.get("archived") is not archived:
        raise SyncError("GitHub did not confirm archived state")


def write_agents(runner: Runner, name: str, branch: str, expected_sha: str | None, desired: bytes) -> str:
    payload: dict[str, Any] = {
        "message": "chore: add USL workspace-linking policy",
        "content": base64.b64encode(desired).decode("ascii"),
        "branch": branch,
    }
    if expected_sha is not None:
        payload["sha"] = expected_sha
    response = gh_json(runner, ["-X", "PUT", f"repos/{name}/contents/AGENTS.md"], payload)
    try:
        return required_string(response["commit"]["sha"], "commit.sha")
    except (KeyError, TypeError) as error:
        raise SyncError("GitHub did not return a commit SHA") from error


class MutationGate:
    """Keep remote mutations slow enough to avoid GitHub secondary rate limits."""

    def __init__(self) -> None:
        self.last_mutation: float | None = None

    def wait(self) -> None:
        if self.last_mutation is not None:
            remaining = 1.5 - (time.monotonic() - self.last_mutation)
            if remaining > 0:
                time.sleep(remaining)
        self.last_mutation = time.monotonic()


def status_record(name: str, status: str, **values: Any) -> dict[str, Any]:
    return {"repository": name, "status": status, **values}


def synchronize_one(runner: Runner, item: dict[str, Any], policy: bytes, apply: bool, include_archived: bool,
                    mutation_gate: MutationGate | None = None) -> dict[str, Any]:
    name = required_string(item.get("nameWithOwner"), "nameWithOwner")
    remote = read_remote_repository(runner, name)
    archived = remote.get("archived")
    unborn = remote.get("default_branch") in (None, "")
    empty_repository = unborn or item.get("isEmpty") is True
    if not isinstance(archived, bool):
        raise SyncError("repository response lacks archived state")
    branch = remote.get("default_branch") or DEFAULT_BRANCH_FOR_EMPTY_REPOSITORY
    if not isinstance(branch, str) or not branch:
        raise SyncError("repository response lacks a usable default branch")
    if archived and not include_archived:
        return status_record(name, "SKIPPED_ARCHIVED", branch=branch)

    previous, source_sha = read_agents(runner, name, branch, empty_repository)
    desired = desired_agents(previous, policy)
    policy_sha = hashlib.sha256(policy).hexdigest()
    if desired == previous:
        return status_record(name, "UNCHANGED", branch=branch, sourceBlobSha=source_sha, outputPolicySha=policy_sha)
    if not apply:
        return status_record(name, "WOULD_COMMIT", branch=branch, sourceBlobSha=source_sha, outputPolicySha=policy_sha)

    restore_needed = False
    try:
        if archived:
            restore_needed = True
            if mutation_gate:
                mutation_gate.wait()
            patch_archived(runner, name, False)
        # Fresh read immediately before PUT prevents the update from replacing a
        # concurrent edit.  The Contents API SHA is GitHub's compare-and-swap.
        fresh, fresh_sha = read_agents(runner, name, branch, empty_repository)
        fresh_desired = desired_agents(fresh, policy)
        if fresh_desired == fresh:
            return status_record(name, "UNCHANGED", branch=branch, sourceBlobSha=fresh_sha, outputPolicySha=policy_sha)
        if mutation_gate:
            mutation_gate.wait()
        commit_sha = write_agents(runner, name, branch, fresh_sha, fresh_desired)
        verified, verified_sha = read_agents(runner, name, branch, False)
        if verified != fresh_desired:
            raise SyncError("post-write AGENTS.md verification differs from desired bytes")
        return status_record(name, "COMMITTED", branch=branch, commitSha=commit_sha, sourceBlobSha=source_sha,
                             actualFreshSha=fresh_sha, verifiedBlobSha=verified_sha, outputPolicySha=policy_sha)
    finally:
        if restore_needed:
            if mutation_gate:
                mutation_gate.wait()
            patch_archived(runner, name, True)


def write_report(destination: Path, report: dict[str, Any]) -> None:
    if not destination.is_absolute():
        raise SyncError("--output must be an absolute private local path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".usl-github-sync-", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, help="GitHub owner; every inventory entry must belong to it")
    parser.add_argument("--inventory", help="absolute/relative local JSON inventory from gh repo list")
    parser.add_argument("--repo", action="append", default=[], metavar="OWNER/NAME", help="limit to this repository; repeatable")
    parser.add_argument("--output", required=True, help="absolute private local JSON report path")
    parser.add_argument("--apply", action="store_true", help="perform remote writes; default is preview")
    parser.add_argument("--include-archived", action="store_true", help="temporarily unarchive changed archived repositories and restore them")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, runner: Runner = default_runner) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    output = Path(args.output)
    try:
        if not output.is_absolute():
            raise SyncError("--output must be an absolute private local path")
        # Create the private report before the first remote mutation, then
        # checkpoint it after each repository for interruption recovery.
        report: dict[str, Any] = {"owner": args.owner, "apply": args.apply, "results": []}
        write_report(output, report)
        policy = INSTALLER.load_policy()
        repositories = load_inventory(args, runner)
        results: list[dict[str, Any]] = report["results"]
        mutation_gate = MutationGate() if args.apply else None
        for item in repositories:
            name = required_string(item.get("nameWithOwner"), "nameWithOwner")
            try:
                record = synchronize_one(runner, item, policy, args.apply, args.include_archived, mutation_gate)
            except SyncError as error:
                record = status_record(name, "FAILED", error=str(error))
            results.append(record)
            write_report(output, report)
            print(f"{name}: {record['status']}")
        return 0 if all(result["status"] != "FAILED" for result in results) else 2
    except SyncError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
