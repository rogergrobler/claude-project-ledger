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

# Resolve the claude binary robustly. The install location has moved before
# (was ~/.local/bin/claude; the npm/homebrew global puts it at
# /opt/homebrew/bin/claude). Hardcoding one path means a future relocation
# silently kills every fire. Prefer PATH lookup, then fall back to known
# install locations, so the job survives the CLI moving.
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

# --- pre-fire structural baseline ---------------------------------------------
# The workflow's apply phase edits current.html in place. If current.html got
# corrupted or carried a deprecated structure, the next fire would propagate
# the bad shape (this is exactly what bit us 6 Jun: the 06:30 fire reverted
# the tabbed layout back to the v1.40 NS-spine + Do-This-Now-band layout
# because that's what current.html happened to hold). The cleanest guarantee
# is to ALWAYS rebase current.html from the live published edition before
# firing — that's the canonical "what Roger sees right now" state.

LIVE_URL="https://rogergrobler.github.io/spock-site-build/ledger/"
CURRENT_HTML="$PROJDIR/current.html"
BASELINE_TMP="$PROJDIR/.baseline.tmp.html"

{
  echo ""
  echo "--- pre-fire structural baseline ---"
  echo "Pulling live edition from $LIVE_URL as the working baseline"
} >> "$LOG"

if curl -fsSL --max-time 20 -o "$BASELINE_TMP" "${LIVE_URL}?cb=$(date +%s)" 2>>"$LOG"; then
  LIVE_SIZE=$(wc -c < "$BASELINE_TMP" | tr -d ' ')
  if [[ "$LIVE_SIZE" -lt 50000 ]]; then
    echo "  WARNING: live fetch only ${LIVE_SIZE} bytes — too small, keeping existing current.html" >> "$LOG"
    rm -f "$BASELINE_TMP"
  else
    # Sanity-check the live HTML has the v1.46+ tab structure before overwriting.
    if grep -q 'class="tab-btn"' "$BASELINE_TMP" && grep -q 'id="tab-bar"' "$BASELINE_TMP"; then
      # Detect & log version
      LIVE_VERSION=$(grep -oE 'v1\.[0-9]+(\.[0-9]+)?' "$BASELINE_TMP" | head -1)
      mv "$BASELINE_TMP" "$CURRENT_HTML"
      echo "  ✓ rebased current.html from live (${LIVE_VERSION:-unknown}, ${LIVE_SIZE} bytes — has tab-bar + tab-btn structure)" >> "$LOG"
    else
      echo "  WARNING: live edition is missing tab-bar / tab-btn — NOT rebasing. The previous fire may have published a regression. Keeping existing current.html." >> "$LOG"
      rm -f "$BASELINE_TMP"
    fi
  fi
else
  echo "  WARNING: could not fetch live edition (curl failed) — keeping existing current.html" >> "$LOG"
  rm -f "$BASELINE_TMP"
fi

# --- fire --------------------------------------------------------------------

# Strategy: prefer the build-ledger Workflow (deterministic 5-phase pipeline),
# fall back to the /ledger-now slash command if the workflow path is unavailable
# or exits non-zero. The fallback exists so a workflow-script bug doesn't leave
# Roger with a stale dashboard for hours.
#
# `--print` runs a single non-interactive turn and exits.
# `--dangerously-skip-permissions` is required because the workflow/skill
#   writes files, shells out to git, pushes to origin, and curls the live URL.
# We cd to $HOME so the session's cwd is stable and predictable.

cd "$HOME"

# Drop the CLAUDECODE marker so this works whether we're launched from a fresh
# launchd process (var not set — no-op) or as a smoke-test from inside an
# existing Claude Code session (var set, would otherwise trigger Claude Code's
# nested-session refusal).
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

WORKFLOW_PATH="$HOME/code/claude-project-ledger/workflows/build-ledger.workflow.js"

# IMPORTANT: the build-ledger workflow file CANNOT be invoked from `claude --print`
# headless mode — the Workflow tool is gated behind interactive sessions and the
# headless model responds "I don't have a Workflow tool available" and exits 0.
# That silently fails: post-fire gate passes (current.html still parses) but no
# actual rebuild happens. We were silently broken from ~16 Jun until this fix.
#
# So cron always uses Path A = /ledger-now skill (works in headless). Manual fires
# from interactive Claude Code can still use the Workflow tool via:
#   Workflow({scriptPath: "$WORKFLOW_PATH"})
# The workflow.js stays as the source of truth for the interactive deep build.

{
  echo ""
  echo "--- Path A: /ledger-now skill (headless-safe) ---"
  echo "Workflow file present at: $WORKFLOW_PATH (used for interactive Workflow fires only)"
  echo ""
} >> "$LOG"

"$CLAUDE_BIN" \
  --print \
  --dangerously-skip-permissions \
  "/ledger-now" \
  >> "$LOG" 2>&1

EXIT_CODE=$?

# Detect the silent-failure pattern: model said it lacked a tool but exited 0.
# Treat that as a hard failure and try a more explicit invocation as Path B.
if grep -qE "I (don'?t|do not) have (a |the )?[\"'\`]?Workflow[\"'\`]? tool|Workflow tool (is not|isn'?t) (available|present)" "$LOG"; then
  EXIT_CODE=2
fi

if [[ $EXIT_CODE -ne 0 ]]; then
  {
    echo ""
    echo "--- Path A failed (exit $EXIT_CODE) — falling back to explicit rebuild prompt ---"
    echo ""
  } >> "$LOG"

  "$CLAUDE_BIN" \
    --print \
    --dangerously-skip-permissions \
    "Generate a fresh Stellenbosch Ledger edition right now: sweep WhatsApp + Gmail + Calendar + Notion for the last 24h, synthesize into the standard 7-tab dashboard, replace current.html at /Users/rogergrobler/spock-data/project_ledger/current.html, commit and push to the spock-site-build GitHub Pages repo, then poll the live URL until the new version propagates. This is the same job /ledger-now would run." \
    >> "$LOG" 2>&1

  EXIT_CODE=$?
  {
    echo ""
    echo "--- Path B (fallback) exit: $EXIT_CODE ---"
  } >> "$LOG"
fi

# --- post-fire self-heal + gate ----------------------------------------------
# The dashboard's JS is frozen (templates/dashboard-core.json). current.html is
# carried forward fire-to-fire, so if any path left a corrupted <script> block
# we re-inject the canonical JS NOW — that guarantees the NEXT fire starts from
# known-good code and corruption can't compound across runs. Then we run the
# build gate and log the verdict loudly.

INJECT="$HOME/code/claude-project-ledger/scripts/inject-core.mjs"
GATE="$HOME/code/claude-project-ledger/scripts/verify-build.mjs"
CURRENT_HTML="$PROJDIR/current.html"

if command -v node >/dev/null 2>&1 && [[ -f "$INJECT" && -f "$CURRENT_HTML" ]]; then
  {
    echo ""
    echo "--- post-fire self-heal + build gate ---"
    node "$INJECT" "$CURRENT_HTML"
    if node "$GATE" "$CURRENT_HTML"; then
      echo "POST-FIRE GATE: PASS"
    else
      echo "POST-FIRE GATE: FAIL — source still broken after heal; investigate templates/dashboard-core.json"
    fi
  } >> "$LOG" 2>&1
fi

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
