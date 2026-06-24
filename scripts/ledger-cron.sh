#!/usr/bin/env bash
# Headless wrapper that fires the Stellenbosch Ledger rebuild + publish pipeline.
# Invoked by launchd (macOS) at 07:00 / 12:00 / 15:00 SAST, or manually via:
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

# Portable hard timeout — `timeout`/`gtimeout` (GNU coreutils) are NOT installed
# on this Mac, so we roll our own. Runs "$@" with a wall-clock ceiling; on expiry
# it TERMs then KILLs the process so a hung model can NEVER block forever (and can
# never sit on the WhatsApp bridge indefinitely, which is what jammed the 24 Jun
# 07:00 fire). Returns 124 on timeout, else the command's own exit code.
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs"; kill -TERM "$cmd_pid" 2>/dev/null; sleep 15; kill -KILL "$cmd_pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watch_pid=$!
  wait "$cmd_pid" 2>/dev/null
  local rc=$?
  # Stop the watcher no matter how the command ended (it may be mid grace-sleep).
  kill -TERM "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
  # A signal-terminated command (rc >= 128) means our watcher fired → timeout.
  if [[ $rc -ge 128 ]]; then rc=124; fi
  return $rc
}

FIRE_BUDGET=1500   # 25 min hard ceiling per attempt

# Headless-safe prompt. THE key fix: do every step inline in ONE turn and never
# background a sub-agent — backgrounded agents don't complete under `claude
# --print` and the run hangs (24 Jun 07:00). Points at the hardened /ledger-now
# skill so the done-ledger drop, single-source summary and sanity gate all apply.
FIRE_PROMPT='Build a fresh Stellenbosch Ledger edition now via the /ledger-now skill, but you are in a HEADLESS one-shot session: perform EVERY step yourself synchronously in THIS turn. Do NOT launch a background or async sub-agent and do NOT use the Task tool with run_in_background — a backgrounded agent never completes here and the run will hang. Sweep WhatsApp + Gmail + Calendar + Notion + Drive for the last 24h inline; reconcile done-ledger.json (drop every cleared fp-*/act-* id); advance <body data-compiled-at> to the current SAST time; single-source the summary (full text only in the subtitle, short kicker/dateline); bump the version; then run `bash scripts/sanity_check.sh current.html "<new-version>"` and publish ONLY if it prints PASS; commit and push to the spock-site-build repo; poll the live URL until the new version is live. Working file: /Users/rogergrobler/spock-data/project_ledger/current.html. Strictly read-only on every message source — never send, reply to, or react to anything.'

fire_once() {
  run_with_timeout "$FIRE_BUDGET" \
    "$CLAUDE_BIN" --print --dangerously-skip-permissions "$FIRE_PROMPT" \
    >> "$LOG" 2>&1
}

{ echo ""; echo "--- fire (headless-safe, ${FIRE_BUDGET}s ceiling) · attempt 1 ---"; echo ""; } >> "$LOG"

fire_once
EXIT_CODE=$?
[[ $EXIT_CODE -eq 124 ]] && echo "  ERROR: attempt 1 TIMED OUT after ${FIRE_BUDGET}s (model hung) — process killed." >> "$LOG"

# Detect the old silent-failure pattern (model claims it lacks a tool, exits 0).
if grep -qE "I (don'?t|do not) have (a |the )?[\"'\`]?Workflow[\"'\`]? tool|Workflow tool (is not|isn'?t) (available|present)" "$LOG"; then
  EXIT_CODE=2
fi

# One retry on any failure (timeout, crash, or tool-miss).
if [[ $EXIT_CODE -ne 0 ]]; then
  { echo ""; echo "--- attempt 1 failed (exit $EXIT_CODE) — single retry after 15s ---"; echo ""; } >> "$LOG"
  sleep 15
  fire_once
  EXIT_CODE=$?
  [[ $EXIT_CODE -eq 124 ]] && echo "  ERROR: retry TIMED OUT after ${FIRE_BUDGET}s — giving up this fire." >> "$LOG"
fi

# Confirm the fire actually moved the live version; record it in the log.
if curl -fsSL --max-time 20 -o /tmp/ledger-live-check.html "${LIVE_URL}?cb=$(date +%s)" 2>/dev/null; then
  LIVE_NOW=$(grep -oE 'v1\.[0-9]+(\.[0-9]+)?' /tmp/ledger-live-check.html | head -1)
  echo "  post-fire live version: ${LIVE_NOW:-unknown}" >> "$LOG"
  rm -f /tmp/ledger-live-check.html
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
