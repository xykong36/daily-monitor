#!/usr/bin/env bash
# Weekly report generator
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

source .venv/bin/activate
python weekly.py
