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

# Fire lock — held for the duration of this fire so the 60s reconcile poller
# (which also edits current.html) skips its ticks and can never collide with a
# mid-build edit. Removed on ANY exit (trap), incl. timeout/kill of the child.
FIRE_LOCK="$HOME/.project_ledger/fire.lock"
mkdir -p "$(dirname "$FIRE_LOCK")"
date +%s > "$FIRE_LOCK"
trap 'rm -f "$FIRE_LOCK"' EXIT

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

WORKER_URL="https://ledger.roger-grobler.workers.dev/"
LIVE_URL="$WORKER_URL"
AUTH_PASS="$(grep -E '^auth_pass' "$HOME/.project_ledger/config.toml" 2>/dev/null | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/')"
CURRENT_HTML="$PROJDIR/current.html"
BASELINE_TMP="$PROJDIR/.baseline.tmp.html"

{
  echo ""
  echo "--- pre-fire structural baseline ---"
  echo "Pulling live edition from $LIVE_URL as the working baseline"
} >> "$LOG"

if curl -fsSL --max-time 20 -u "x:$AUTH_PASS" -o "$BASELINE_TMP" "${LIVE_URL}?cb=$(date +%s)" 2>>"$LOG"; then
  LIVE_SIZE=$(wc -c < "$BASELINE_TMP" | tr -d ' ')
  if [[ "$LIVE_SIZE" -lt 50000 ]]; then
    echo "  WARNING: live fetch only ${LIVE_SIZE} bytes — too small, keeping existing current.html" >> "$LOG"
    rm -f "$BASELINE_TMP"
  else
    # Sanity-check the live HTML has the v1.46+ tab structure before overwriting.
    if grep -q 'class="tab-btn"' "$BASELINE_TMP" && grep -q 'id="tab-bar"' "$BASELINE_TMP"; then
      # Detect & log version
      LIVE_VERSION=$(grep -oE 'id="dateline-edition">v[0-9]+\.[0-9]+(\.[0-9]+)?' "$BASELINE_TMP" | grep -oE 'v[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
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

# Headless auth: load the long-lived OAuth token (minted via `claude setup-token`
# on 1 Jul 2026, valid ~1 year) if the environment doesn't already carry one.
# This is what lets `claude --print` authenticate under launchd after the
# interactive OAuth access-token died (27 Jun) and hard-logged-out (1 Jul).
# Stored 0600 at the path below, OUTSIDE any git repo. When it nears expiry
# (~mid-2027) re-run `claude setup-token` and overwrite that file.
TOKEN_FILE="$HOME/.project_ledger/claude_oauth_token"
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -r "$TOKEN_FILE" ]]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi

# Two-tier auth (31 Jul 2026): the setup-token authenticates MODEL calls but
# claude.ai connectors (Gmail/Calendar/Drive) NEVER attach under token auth —
# that was the builds' chronic "MCP not connected" gap. Keychain OAuth (from an
# interactive /login) DOES bridge connectors, but has died under launchd before
# (27 Jun). So: hold the token aside, probe keychain auth, fire attempt 1 on
# keychain when the probe passes, and fall back to the token on any auth
# failure so the ledger never goes dark. Probe result is logged every fire.
TOKEN_VALUE="${CLAUDE_CODE_OAUTH_TOKEN:-}"
unset CLAUDE_CODE_OAUTH_TOKEN

KEYCHAIN_AUTH_OK=0
{
  echo ""
  echo "--- auth probe: keychain OAuth (no setup-token) ---"
} >> "$LOG"
PROBE_OUT="$("$CLAUDE_BIN" --print --model sonnet --dangerously-skip-permissions \
  "Use ToolSearch to look for MCP tools for Gmail, Google Calendar and Google Drive. Reply with exactly one line: DIAG-CONNECTORS-PRESENT <three example tool names> if any exist, or DIAG-NO-CONNECTORS if none exist." \
  </dev/null 2>&1 | tail -3)"
# Neutralise auth-error phrases so the end-of-run expired-credentials detector
# (which greps this whole log) doesn't false-alarm on a failed PROBE when the
# token-auth build itself succeeded.
echo "$PROBE_OUT" | sed -e 's/Not logged in/Not-logged-in(probe)/g' -e 's/401/4xx(probe)/g' -e 's/authentication_error/auth-error(probe)/g' >> "$LOG"
if echo "$PROBE_OUT" | grep -q "DIAG-CONNECTORS-PRESENT"; then
  KEYCHAIN_AUTH_OK=1
  echo "  → keychain auth OK, connectors present — firing WITHOUT setup-token" >> "$LOG"
else
  echo "  → keychain auth unusable or connector-less — firing WITH setup-token (no Gmail/Cal/Drive this build)" >> "$LOG"
fi

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
FIRE_PROMPT='Build a fresh Stellenbosch Ledger edition now via the /ledger-now skill, but you are in a HEADLESS one-shot session: perform EVERY step yourself synchronously in THIS turn. Do NOT launch a background or async sub-agent and do NOT use the Task tool with run_in_background — a backgrounded agent never completes here and the run will hang. Sweep WhatsApp + Gmail + Calendar + Notion + Drive for the last 24h inline; reconcile done-ledger.json (drop every cleared fp-*/act-* id); advance <body data-compiled-at> to the current SAST time; single-source the summary (full text only in the subtitle, short kicker/dateline); bump the version; CRITICAL: inside HTML tags use ONLY straight ASCII quotes (") — never curly/smart quotes (“ ” ‘ ’), which silently break class, onclick and data-id on the card; keep every card opener as <div class="card fire" data-id="..." ...>; then run `bash scripts/sanity_check.sh current.html "<new-version>"` and publish ONLY if it prints PASS; do NOT git-push and do NOT push to spock-site-build — the wrapper mirrors current.html to the password-protected R2/Worker surface afterward. Just leave current.html updated on disk. Working file: /Users/rogergrobler/spock-data/project_ledger/current.html. Strictly read-only on every message source — never send, reply to, or react to anything.'

fire_once() {
  if [[ $KEYCHAIN_AUTH_OK -eq 1 ]]; then
    run_with_timeout "$FIRE_BUDGET" \
      "$CLAUDE_BIN" --print --dangerously-skip-permissions "$FIRE_PROMPT" \
      >> "$LOG" 2>&1
  else
    CLAUDE_CODE_OAUTH_TOKEN="$TOKEN_VALUE" run_with_timeout "$FIRE_BUDGET" \
      "$CLAUDE_BIN" --print --dangerously-skip-permissions "$FIRE_PROMPT" \
      >> "$LOG" 2>&1
  fi
}

{ echo ""; echo "--- fire (headless-safe, ${FIRE_BUDGET}s ceiling) · attempt 1 ---"; echo ""; } >> "$LOG"

fire_once
EXIT_CODE=$?
[[ $EXIT_CODE -eq 124 ]] && echo "  ERROR: attempt 1 TIMED OUT after ${FIRE_BUDGET}s (model hung) — process killed." >> "$LOG"

# Detect the old silent-failure pattern (model claims it lacks a tool, exits 0).
if grep -qE "I (don'?t|do not) have (a |the )?[\"'\`]?Workflow[\"'\`]? tool|Workflow tool (is not|isn'?t) (available|present)" "$LOG"; then
  EXIT_CODE=2
fi

# One retry on any failure (timeout, crash, or tool-miss). If attempt 1 ran on
# keychain auth, retry on the setup-token instead — a mid-run auth death is the
# most likely keychain failure mode and the token path is the proven-reliable one.
if [[ $EXIT_CODE -ne 0 ]]; then
  if [[ $KEYCHAIN_AUTH_OK -eq 1 ]]; then
    KEYCHAIN_AUTH_OK=0
    echo "  (retry will use the setup-token, not keychain auth)" >> "$LOG"
  fi
  { echo ""; echo "--- attempt 1 failed (exit $EXIT_CODE) — single retry after 15s ---"; echo ""; } >> "$LOG"
  sleep 15
  fire_once
  EXIT_CODE=$?
  [[ $EXIT_CODE -eq 124 ]] && echo "  ERROR: retry TIMED OUT after ${FIRE_BUDGET}s — giving up this fire." >> "$LOG"
fi

# Expired-credentials detector. The headless CLI reads ~/.claude/.credentials.json;
# its OAuth access token expires (and silently fails to refresh if another device
# rotated the refresh token out from under this machine). When that happens every
# fire 401s and the dashboard silently freezes — exactly what bit us 27 Jun–30 Jun.
# Surface it LOUDLY and actionably instead of burying a 401 in the fire output.
if grep -qE '401|authentication_error|Invalid authentication credentials|Failed to authenticate|Not logged in|Please run /login|Please run .?claude setup-token' "$LOG"; then
  {
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════════════╗"
    echo "  ║ AUTH EXPIRED — headless 'claude' got a 401. Dashboard NOT rebuilt. ║"
    echo "  ║ FIX: on this Mac run  ->  claude setup-token                       ║"
    echo "  ║ (long-lived token; survives the daily OAuth-access-token expiry).  ║"
    echo "  ╚══════════════════════════════════════════════════════════════════╝"
  } >> "$LOG"
  # macOS desktop notification so a frozen dashboard can't go unnoticed for days.
  command -v osascript >/dev/null 2>&1 && \
    osascript -e 'display notification "Run: claude setup-token" with title "Ledger cron — AUTH EXPIRED" sound name "Basso"' >/dev/null 2>&1 || true
  [[ $EXIT_CODE -eq 0 ]] && EXIT_CODE=3
fi

# Confirm the fire actually moved the live version; record it in the log.
if curl -fsSL --max-time 20 -u "x:$AUTH_PASS" -o /tmp/ledger-live-check.html "${LIVE_URL}?cb=$(date +%s)" 2>/dev/null; then
  LIVE_NOW=$(grep -oE 'id="dateline-edition">v[0-9]+\.[0-9]+(\.[0-9]+)?' /tmp/ledger-live-check.html | grep -oE 'v[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
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

# --- mirror to R2 (the Cloudflare Worker's live surface) --------------------
# The fire pushes to GitHub Pages; also publish to R2 so the Worker (which is
# where the auto-write dashboard is served + POSTs from) never serves a stale
# edition after a scheduled fire.
{
  echo ""
  echo "--- mirror current.html to R2 ---"
  python3 "$HOME/code/claude-project-ledger/scripts/publish-r2.py" 2>&1 || echo "  ⚠ R2 mirror failed (non-fatal)"
} >> "$LOG" 2>&1

# --- backup runtime state to the private repo (spock-ledger-data) -----------
# Keep done-ledger.json + the edition archive off-Mac. Runs 3x/day with the fire;
# non-fatal on failure. Secrets live outside this dir and are .gitignored.
{
  echo ""
  echo "--- backup runtime state to private repo ---"
  if git -C "$PROJDIR" add -A && git -C "$PROJDIR" commit -q -m "auto-backup $(TZ='Africa/Johannesburg' date '+%F %H:%M SAST')" 2>/dev/null; then
    git -C "$PROJDIR" push -q origin main && echo "  ✓ pushed to spock-ledger-data" || echo "  ⚠ backup push failed (non-fatal)"
  else
    echo "  (no runtime changes to back up)"
  fi
} >> "$LOG" 2>&1

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
