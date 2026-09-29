#!/usr/bin/env python3
"""Preview or explicitly install the USL workspace-linking policy in repositories.

This utility has no network behavior.  It only ever considers repositories named
with ``--repo`` and changes them only with ``--apply``.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from typing import Final


MAX_POLICY_BYTES: Final = 64 * 1024
MAX_AGENTS_BYTES: Final = 1024 * 1024
BEGIN: Final = b"<!-- usl-workspace-linking:begin -->"
END: Final = b"<!-- usl-workspace-linking:end -->"
PAYLOAD_PATH: Final = Path(__file__).resolve().parents[1] / "agent-rules" / "workspace-linking.md"


class InstallError(Exception):
    """A repository is unsuitable for a safe policy installation."""


def bounded_regular_bytes(path: Path, limit: int, label: str) -> tuple[bytes, os.stat_result]:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        raise
    except OSError as error:
        if error.errno == getattr(os, "ELOOP", 40):
            raise InstallError(f"{label} must not be a symlink: {path}") from error
        raise InstallError(f"{label} cannot be opened safely: {path}") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise InstallError(f"{label} must be a regular file: {path}")
        if info.st_size > limit:
            raise InstallError(f"{label} exceeds {limit} bytes: {path}")
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            data = stream.read(limit + 1)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    if len(data) > limit:
        raise InstallError(f"{label} exceeds {limit} bytes: {path}")
    return data, info


def marked_block(data: bytes, label: str) -> bytes:
    if len(data) > MAX_POLICY_BYTES:
        raise InstallError(f"{label} exceeds {MAX_POLICY_BYTES} bytes")
    begin_count, end_count = data.count(BEGIN), data.count(END)
    begin, end = data.find(BEGIN), data.find(END)
    if begin_count != 1 or end_count != 1 or begin < 0 or end < 0 or begin >= end:
        raise InstallError(f"{label} must contain exactly one ordered USL workspace-linking marker pair")
    return data[begin : end + len(END)]


def load_policy() -> bytes:
    try:
        data, _ = bounded_regular_bytes(PAYLOAD_PATH, MAX_POLICY_BYTES, "policy payload")
    except FileNotFoundError as error:
        raise InstallError(f"policy payload is missing: {PAYLOAD_PATH}") from error
    return marked_block(data, "policy payload")


def canonical_repository(argument: str) -> Path:
    candidate = Path(argument)
    try:
        root = candidate.resolve(strict=True)
    except OSError as error:
        raise InstallError(f"repository path cannot be resolved: {candidate}") from error
    if not root.is_dir():
        raise InstallError(f"repository path is not a directory: {candidate}")
    completed = subprocess.run(
        ["git", "-C", os.fspath(root), "rev-parse", "--show-toplevel"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise InstallError(f"repository has no Git toplevel: {candidate}")
    try:
        git_root = Path(completed.stdout.decode("utf-8", "strict").strip()).resolve(strict=True)
    except (UnicodeDecodeError, OSError) as error:
        raise InstallError(f"repository Git toplevel cannot be resolved: {candidate}") from error
    if root != git_root:
        raise InstallError(f"repository path must be its Git toplevel: {candidate}")
    return root


def updated_agents(previous: bytes | None, policy: bytes) -> bytes:
    if previous is None:
        return policy + b"\n"
    begin_count, end_count = previous.count(BEGIN), previous.count(END)
    begin, end = previous.find(BEGIN), previous.find(END)
    if begin_count == 0 and end_count == 0:
        if not previous:
            return policy + b"\n"
        separator = b"" if previous.endswith(b"\n") else b"\n"
        return previous + separator + b"\n" + policy + b"\n"
    if begin_count != 1 or end_count != 1 or begin < 0 or end < 0 or begin >= end:
        raise InstallError("AGENTS.md has malformed or duplicate USL workspace-linking markers")
    return previous[:begin] + policy + previous[end + len(END) :]


def same_snapshot(path: Path, previous: bytes | None, prior_stat: os.stat_result | None) -> bool:
    try:
        current, current_stat = bounded_regular_bytes(path, MAX_AGENTS_BYTES, "AGENTS.md")
    except FileNotFoundError:
        return previous is None
    if previous is None or prior_stat is None:
        return False
    return (current == previous and current_stat.st_dev == prior_stat.st_dev and
            current_stat.st_ino == prior_stat.st_ino and current_stat.st_mode == prior_stat.st_mode)


def atomic_write(path: Path, content: bytes, previous: bytes | None, prior_stat: os.stat_result | None) -> None:
    directory = path.parent
    descriptor, temporary_name = tempfile.mkstemp(prefix=".usl-workspace-linking-", dir=directory)
    temporary = Path(temporary_name)
    try:
        mode = (prior_stat.st_mode & 0o7777) if prior_stat is not None else 0o644
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if not same_snapshot(path, previous, prior_stat):
            raise InstallError(f"AGENTS.md changed while preparing update: {path}")
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def install_one(argument: str, policy: bytes, apply: bool) -> str:
    repository = canonical_repository(argument)
    target = repository / "AGENTS.md"
    try:
        previous, prior_stat = bounded_regular_bytes(target, MAX_AGENTS_BYTES, "AGENTS.md")
    except FileNotFoundError:
        previous, prior_stat = None, None
    next_content = updated_agents(previous, policy)
    if next_content == previous:
        return f"{repository}: already current"
    if not apply:
        operation = "create" if previous is None else "update"
        return f"{repository}: would {operation} AGENTS.md (pass --apply to write)"
    atomic_write(target, next_content, previous, prior_stat)
    return f"{repository}: updated AGENTS.md"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", action="append", required=True, metavar="PATH", help="Git toplevel to inspect; repeat for each repository")
    parser.add_argument("--apply", action="store_true", help="write changes; without this flag only preview")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        policy = load_policy()
    except InstallError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    status = 0
    for repository in args.repo:
        try:
            print(install_one(repository, policy, args.apply))
        except InstallError as error:
            status = 2
            print(f"error: {repository}: {error}", file=sys.stderr)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
