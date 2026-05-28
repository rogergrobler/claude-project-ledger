#!/usr/bin/env bash
# Headless wrapper that fires the Stellenbosch Ledger rebuild + publish pipeline.
# Invoked by launchd (macOS) at 06:30 / 13:00 / 21:00 SAST, or manually via:
#
#     bash ~/code/claude-project-ledger/scripts/ledger-cron.sh
#
# Spawns a non-interactive Claude Code session (`claude --print`) that runs
# the /ledger-now skill — sweep across WhatsApp / Gmail / Calendar / Notion /
# Drive, merge into current.html, snapshot, push to GitHub Pages, poll for live.
#
# All output (including the model's reasoning and any errors) is appended to a
# per-fire log file. Logs accumulate under cron-logs/ — prune by hand if needed.

set -uo pipefail

# --- paths -------------------------------------------------------------------

CLAUDE_BIN="$HOME/.local/bin/claude"
PROJDIR="$HOME/Documents/Claude/Projects/Project Ledger/project_ledger"
LOG_DIR="$PROJDIR/cron-logs"

mkdir -p "$LOG_DIR"

TS_FILE=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d_%H-%M')
TS_DISPLAY=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d %H:%M SAST')
LOG="$LOG_DIR/ledger-cron-${TS_FILE}.log"

# --- sanity ------------------------------------------------------------------

{
  echo "============================================================"
  echo "Ledger cron fire · ${TS_DISPLAY}"
  echo "Log: ${LOG}"
  echo "============================================================"
} >> "$LOG"

if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "ERROR: claude binary not found at ${CLAUDE_BIN}" >> "$LOG"
  exit 1
fi

if [[ ! -d "$PROJDIR" ]]; then
  echo "ERROR: project_ledger dir not found at ${PROJDIR}" >> "$LOG"
  exit 1
fi

# --- fire --------------------------------------------------------------------

# `--print` runs a single non-interactive turn and exits.
# `--dangerously-skip-permissions` is required because the skill writes files,
#   shells out to git, pushes to origin, and curls the live URL. Roger's
#   ~/.claude/settings.json already sets skipDangerousModePermissionPrompt:true
#   for interactive use; this is the headless equivalent.
# We cd to $HOME so the session's cwd is stable and predictable.

cd "$HOME"

{
  echo ""
  echo "--- claude --print '/ledger-now' ---"
  echo ""
} >> "$LOG"

"$CLAUDE_BIN" \
  --print \
  --dangerously-skip-permissions \
  "/ledger-now" \
  >> "$LOG" 2>&1

EXIT_CODE=$?

{
  echo ""
  echo "--- exit code: ${EXIT_CODE} ---"
  echo "Finished: $(TZ='Africa/Johannesburg' date '+%Y-%m-%d %H:%M:%S SAST')"
  echo "============================================================"
  echo ""
} >> "$LOG"

# Keep last 30 logs; prune older ones so the dir doesn't grow without bound.
ls -t "$LOG_DIR"/ledger-cron-*.log 2>/dev/null | tail -n +31 | xargs -I {} rm -f {} 2>/dev/null || true

exit $EXIT_CODE
