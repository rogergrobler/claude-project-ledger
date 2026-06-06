#!/usr/bin/env bash
# Install the Ledger launchd job on macOS.
# Run once per machine that should be a scheduled-fire host.
#
#     bash ~/code/claude-project-ledger/scripts/install-launchd.sh
#
# Idempotent: unloads any existing job before re-installing.
#
# IMPORTANT FIX (5 Jun 2026): switched from legacy `launchctl load` to modern
# `launchctl bootstrap gui/$(id -u)`. Reason: `launchctl load` is
# session-scoped — it does NOT survive a Mac reboot. The job was being
# silently dropped each time the Mac restarted, and no fires landed until
# someone re-ran the install script. The original install (May 28) ran
# `launchctl load`; the Mac restarted at some point; from then on no fires
# happened. Bootstrap-loaded jobs persist across reboots because they're
# registered with launchd's gui domain rather than the legacy session.

set -euo pipefail

REPO_DIR="$HOME/code/claude-project-ledger"
PLIST_SRC="$REPO_DIR/launchd/com.rogergrobler.ledger.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.rogergrobler.ledger.plist"
SCRIPT="$REPO_DIR/scripts/ledger-cron.sh"
LABEL="com.rogergrobler.ledger"
DOMAIN="gui/$(id -u)"
TARGET="${DOMAIN}/${LABEL}"

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

# Tear down any existing registration. Try modern bootout first, then legacy
# unload as a fallback for old installs that used the deprecated command.
launchctl bootout "$TARGET" 2>/dev/null || true
launchctl unload  "$PLIST_DEST" 2>/dev/null || true

# Copy the plist into place.
cp "$PLIST_SRC" "$PLIST_DEST"

# Bootstrap-load into the gui domain — survives reboots.
launchctl bootstrap "$DOMAIN" "$PLIST_DEST"

# Enable the service explicitly (some macOS versions need this after a fresh
# bootstrap before the StartCalendarInterval fires kick in).
launchctl enable "$TARGET" 2>/dev/null || true

echo ""
echo "Installed: $PLIST_DEST"
echo "Bootstrap target: $TARGET"
echo ""
echo "Scheduled fires (SAST):"
echo "  07:00 — morning briefing as the day starts"
echo "  12:00 — midday checkpoint (pre-lunch)"
echo "  15:00 — mid-afternoon refresh (still time to act before EOD)"
echo ""
echo "Confirm it's loaded:"
echo "  launchctl print $TARGET | head -20"
echo "  launchctl list | grep ledger"
echo ""
echo "Inspect cron logs:"
echo "  ls -lt ~/Documents/Claude/Projects/Project\\ Ledger/project_ledger/cron-logs/"
echo ""
echo "Fire one manually for a smoke test:"
echo "  bash $SCRIPT"
echo ""
echo "Uninstall with:"
echo "  launchctl bootout $TARGET && rm $PLIST_DEST"
