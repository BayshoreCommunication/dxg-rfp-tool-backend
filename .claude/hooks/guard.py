#!/usr/bin/env python3
"""PreToolUse guard for Claude Code (committed; shared by the three RFPilot repos).

Blocks (exit 2, reason on stderr, which Claude sees):
  - writing runtime env files (.env, .env.local, ...; *.example is fine)
  - hand-editing generated contracts (contracts/generated/**)
  - editing a PostgreSQL migration that is already committed (migrations/postgres/*)
  - shell commands that print a runtime env file (cat/grep/... .env)
"""
import json
import os
import re
import subprocess
import sys


def block(reason: str) -> None:
    print(reason, file=sys.stderr)
    sys.exit(2)


def is_runtime_env(path: str) -> bool:
    name = os.path.basename(path)
    return name.startswith(".env") and not name.endswith(".example")


def check_write(path: str, root: str) -> None:
    if not path:
        return
    rel = os.path.relpath(os.path.abspath(path), root)
    if is_runtime_env(path):
        block(f"Blocked: {rel} is a runtime env file. Change .env.example instead and tell the user which value to set locally.")
    if "contracts/generated/" in rel.replace(os.sep, "/"):
        block(f"Blocked: {rel} is generated. Edit the source contract and run `npm run contracts:generate` (dashboard: regenerate from the backend).")
    norm = rel.replace(os.sep, "/")
    if norm.startswith("migrations/postgres/") and os.path.exists(path):
        tracked = subprocess.run(
            ["git", "-C", root, "ls-files", "--error-unmatch", norm],
            capture_output=True,
        ).returncode == 0
        if tracked:
            block(f"Blocked: {rel} is a committed migration and may already be applied. Add a new NNN_name.up.sql/.down.sql pair instead.")


ENV_READ = re.compile(
    r"(?:^|[\s;&|(])(?:cat|less|more|head|tail|bat|grep|rg|egrep|sed|awk|xxd|od|strings|base64|diff|jq)\b[^;&|]*?"
    r"(?:^|[\s/'\"=])\.env(?:\.(?!example\b)[\w.-]+)?(?=$|[\s'\";&|)])"
)


def check_bash(command: str) -> None:
    if command and ENV_READ.search(command):
        block("Blocked: this command would print a runtime .env file into the conversation. Read .env.example, or ask the user for the specific non-secret value.")


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    tool = data.get("tool_name", "")
    ti = data.get("tool_input") or {}
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        check_write(ti.get("file_path") or ti.get("notebook_path") or "", root)
    elif tool == "Bash":
        check_bash(ti.get("command", ""))


if __name__ == "__main__":
    main()
