#!/usr/bin/env bash
# Manual CRAGGemini installer. It only runs prepare-gemini from the main installer.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -ne 0 ]]; then
  echo "install-gemini.sh does not take arguments; it always runs prepare-gemini" >&2
  exit 2
fi
exec bash "$here/install.sh" prepare-gemini
