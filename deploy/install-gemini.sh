#!/usr/bin/env bash
# Manual CRAGGemini installer. It fetches the matching installer and runs only prepare-gemini.
set -euo pipefail
if [[ $# -ne 0 ]]; then
  echo "install-gemini.sh does not take arguments; it always runs prepare-gemini" >&2
  exit 2
fi
url="${VM2API_INSTALL_URL:-https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
exec bash "$tmp" prepare-gemini
