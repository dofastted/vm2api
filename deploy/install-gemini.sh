#!/usr/bin/env bash
# Manual CRAGGemini installer. It fetches the matching installer and runs only prepare-gemini.
set -euo pipefail
if [[ $# -ne 0 && ( $# -ne 2 || "$1" != --dir || ! "$2" =~ ^/[A-Za-z0-9._/-]+$ ) ]]; then
  echo "usage: install-gemini.sh [--dir /path/to/vm2api]" >&2
  exit 2
fi
url=https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 "$url" -o "$tmp"
bash "$tmp" prepare-gemini "$@"
