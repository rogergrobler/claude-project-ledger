#!/usr/bin/env bash
# Install the Ledger launchd job on macOS.
# Run once per machine that should be a scheduled-fire host.
#
#     bash ~/code/claude-project-ledger/scripts/install-launchd.sh
#
# Idempotent: unloads any existing job before re-installing.

set -euo pipefail

REPO_DIR="$HOME/code/claude-project-ledger"
PLIST_SRC="$REPO_DIR/launchd/com.rogergrobler.ledger.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.rogergrobler.ledger.plist"
SCRIPT="$REPO_DIR/scripts/ledger-cron.sh"

if [[ ! -f "$PLIST_SRC" ]]; then
  echo "ERROR: plist not found at $PLIST_SRC" >&2
  exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: cron script not found at $SCRIPT" >&2
  exit 1
fi

chmod +x "$SCRIPT"

# Make sure ~/Library/LaunchAgents exists.
mkdir -p "$HOME/Library/LaunchAgents"

# Unload any existing job (ignore errors — first install will have nothing to unload).
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# Copy the plist into place.
cp "$PLIST_SRC" "$PLIST_DEST"

# Load it.
launchctl load "$PLIST_DEST"

echo ""
echo "Installed: $PLIST_DEST"
echo ""
echo "Scheduled fires (SAST):"
echo "  06:30 — morning"
echo "  13:00 — midday"
echo "  21:00 — evening"
echo ""
echo "Inspect with:"
echo "  launchctl list | grep ledger"
echo "  ls -lt ~/Documents/Claude/Projects/Project\\ Ledger/project_ledger/cron-logs/"
echo ""
echo "Fire one manually for a smoke test:"
echo "  bash $SCRIPT"
echo ""
echo "Uninstall with:"
echo "  launchctl unload $PLIST_DEST && rm $PLIST_DEST"
