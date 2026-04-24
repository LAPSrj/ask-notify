#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PS1_PATH="$SCRIPT_DIR/install.ps1"

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "Error: powershell.exe not found. This script must run inside WSL on Windows." >&2
  exit 1
fi

WIN_PATH="$(wslpath -w "$PS1_PATH")"

echo "Running $PS1_PATH on the Windows side..."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$WIN_PATH"

echo
echo "Wiring the Notification hook into ~/.claude/settings.json..."
node "$SCRIPT_DIR/install-hook.js"
