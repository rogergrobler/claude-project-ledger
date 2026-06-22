#!/usr/bin/env bash
# Headless wrapper that fires the build-meetings workflow.
# Invoked by launchd (macOS) at 22:00 SAST daily, or manually via:
#
#     bash ~/code/claude-project-ledger/scripts/meetings-cron.sh
#
# Sweeps Plaud.ai + Google Meet "Notes by Gemini" Docs from the day,
# summarises each, extracts action items, writes to Notion "Meeting Minutes".
# Sensitive meetings (board / IC / MNPI) go to ~/spock-calibration/ outside
# the repo per the WALL discipline.

set -uo pipefail

CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for cand in \
    "/opt/homebrew/bin/claude" \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    "/usr/local/bin/claude"; do
    if [[ -x "$cand" ]]; then CLAUDE_BIN="$cand"; break; fi
  done
fi

PROJDIR="/Users/rogergrobler/spock-data/project_ledger"
LOG_DIR="$PROJDIR/cron-logs"
mkdir -p "$LOG_DIR"

TS_FILE=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d_%H-%M')
TS_DISPLAY=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d %H:%M SAST')
LOG="$LOG_DIR/meetings-cron-${TS_FILE}.log"

{
  echo "============================================================"
  echo "Meetings cron fire · ${TS_DISPLAY}"
  echo "Log: ${LOG}"
  echo "============================================================"
} >> "$LOG"

if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "ERROR: claude binary not found" >> "$LOG"
  exit 1
fi

cd "$HOME"
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

WORKFLOW_PATH="$HOME/code/claude-project-ledger/workflows/build-meetings.workflow.js"

# IMPORTANT: same issue as ledger-cron.sh — the Workflow tool is gated behind
# interactive Claude Code sessions. From headless `claude --print` it isn't
# available, so we can't invoke workflow.js files. The workflow file stays as
# the source of truth for interactive fires; cron uses a natural-language prompt
# that does the same work via skills + MCPs.

"$CLAUDE_BIN" \
  --print \
  --dangerously-skip-permissions \
  "Run a meeting-minutes sweep for $(TZ='Africa/Johannesburg' date '+%Y-%m-%d'). Use the Google Drive MCP to list 'Notes by Gemini' Google Docs in the Meet Recordings folder (id 1HPLhv9AlbIXBe0Ah1BHS2UOWLBUzQh33) modified in the last 24 hours. For each one: read the doc, extract a summary + attendees + action items. Apply the WALL classifier — anything matching board/IC/MNPI keywords (OPA, Optasia private, M-Kopa private, ARC IC, board pack, valuation method) gets saved ONLY to ~/spock-calibration/<counterparty>/meetings/ outside the repo. Non-sensitive meetings get a Notion page in the 'Meeting Minutes' database (create the DB if it doesn't exist via notion-create-database first). Return a JSON summary at the end: {meetings_processed, sensitive_quarantined, notion_pages_created, blockers}." \
  >> "$LOG" 2>&1

EXIT_CODE=$?

{
  echo ""
  echo "--- exit code: ${EXIT_CODE} ---"
  echo "Finished: $(TZ='Africa/Johannesburg' date '+%Y-%m-%d %H:%M:%S SAST')"
  echo "============================================================"
  echo ""
} >> "$LOG"

# Keep last 30 logs
ls -t "$LOG_DIR"/meetings-cron-*.log 2>/dev/null | tail -n +31 | xargs -I {} rm -f {} 2>/dev/null || true

exit $EXIT_CODE
