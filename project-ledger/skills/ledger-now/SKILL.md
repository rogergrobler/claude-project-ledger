---
name: ledger-now
description: Force an immediate fresh rebuild of the Stellenbosch Ledger dashboard, between scheduled fires. Full data sweep across every source (no cached data), updated HTML, snapshot, push to GitHub Pages, poll for live. Use when the user says "/ledger-now", "rebuild ledger", "fresh ledger now", "update the dashboard", "publish a new edition", "refresh the ledger", "do a full sweep and push", or any explicit request to push a fresh edition.
---

# Project Ledger — Now (force rebuild)

End-to-end fresh build with full data sweep, then publish to GitHub Pages. This is the hot path Roger uses when he wants the dashboard refreshed immediately.

## Workflow

### Step 1 — Resolve paths and recover state

Working dir: `~/Documents/Claude/Projects/Project Ledger/project_ledger/`
Source-of-truth: `current.html`
Publish target: `https://github.com/rogergrobler/spock-site-build` → `ledger/index.html`
Live URL: `https://rogergrobler.github.io/spock-site-build/ledger/`

If `current.html` is missing, recover from the most recent `edition_*.html` snapshot:

```bash
cd ~/Documents/Claude/Projects/Project\ Ledger/project_ledger
LATEST=$(ls -t edition_*.html | head -1)
cp "$LATEST" current.html
```

Then narrate the recovery so Roger knows.

### Step 2 — Kick off a background sweep agent

Launch a single general-purpose agent IN THE BACKGROUND with the full sweep prompt (see `references/sweep-prompt.md` in this skill directory if you need the canonical version). The agent must:

**WhatsApp — MANDATORY contacts, sweep on EVERY fire (no exceptions):**
- **Isa De Villiers (DM) · `27721818934@s.whatsapp.net`** — Roger's executive assistant; carries critical operational items (payments, calendar moves, valuation sign-offs, family logistics). She uses the convention `Spock: <message>` to flag items she expects on the dashboard. Pull her thread with `mcp__whatsapp__list_messages` covering at minimum the last 24 hours and the entire most recent thread, even if list_chats doesn't surface her name in the top-10.
- **Isa Projects (group) · `919908732597-1543670455@g.us`** — three-way group with Isa + Elca; coordinates family logistics, Camp David shipping, household projects. Often carries decisions that don't appear in either DM. Pull this group's messages directly every fire.
- **Elca / Alabama (DM) · `919908732597@s.whatsapp.net`** (saved as "Alabama 🎈✨🙏🏾") — Roger's wife. Family logistics, Camp David, household. Same rule: pull her DM thread directly, every fire, regardless of what list_chats returns.

**A sweep that omits any one of these three threads is a failed sweep — name the gap loudly in the digest under "Source errors" and treat it as blocking. Do not silently publish with these missing.**

**WhatsApp — general sweep:**
- After the two mandatory contacts above, pull `mcp__whatsapp__list_chats` with limit 10 and `mcp__whatsapp__list_messages` per active chat for the last 24 hours.
- Scan every message body (across all chats) for the case-insensitive prefix `"spock:"` at the start of a line — these are explicit "missing-item, please add" flags that bypass normal triage and must be surfaced verbatim with their Notion / URL payloads in the digest.

**Other sources:**
- Run targeted Gmail searches via `mcp__5508cee3-3894-430d-ad42-a90478ec1298__search_threads` keyed to the open threads from the previous edition (M-Kopa, Optasia, portfolio names, family threads).
- List today and tomorrow's calendar events via `mcp__70bd15a3-8278-4771-b9a6-8282063bf947__list_events`.
- Hit Notion (`mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-search`) for last-edited matches on the active deal codenames.
- Hit Drive (`mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a__list_recent_files`) for fresh documents.

**Output contract:**
- Return a digest under 700 words structured as: WhatsApp deltas (Isa first, Elca/Alabama second, then everyone else) / `Spock:`-prefix flags / Gmail deltas / Calendar today+tomorrow / Notion deltas / Drive deltas / what's-still-open verification / top 3 next-90-minute actions.
- If a source MCP isn't loaded in the current session (common in headless `claude --print` invocations — happens with WhatsApp specifically), name it under "Source errors" loudly. Do not silently skip Isa or Elca. The user must see the gap in the published edition.

NO cached data. NO copying from the previous edition's notes. Fresh reads only.

### Step 3 — In parallel while the sweep runs

Read `current.html` to confirm the structure (kicker, subtitle, dateline, lede, tip-block, North Star NS cards, Front Page priority grid, Day cards, Pullquote, Footer). Identify what the new edition's kicker/version should be — increment the minor version (e.g., v1.24 → v1.25), set the slot label ("Wednesday morning", "Wednesday midday", "Wednesday evening", etc.) from the system clock in SAST.

Surface from the prior edition: any items marked done in a "Send to Claude" payload that should be cleared (act-* rows, FP cards). If no payload was supplied, leave done-state untouched.

### Step 3a — Rotate the Claude Tip of the Day

The `<details class="tip-block">` element in `current.html` is hand-authored HTML, not live-fetched. Every fire that does NOT rotate the tip silently breaks the implicit contract of "a fresh tip surfaces on the next dashboard" (which the verdict text explicitly promises when the user ticks 👍).

On every fire:

1. Read the current tip id from `current.html` — it's the `data-tip-id` attribute on the `<details class="tip-block">` element.
2. Read `~/.project_ledger/tip-history.json` if it exists — format `{"shown": [...], "current": "..."}` — to know which tips have already been shown.
3. Query the Notion "🎓 Claude Tips Backlog" database (data source `114727aa-c905-40fc-9d5b-c76342f93189`) for the next entry whose Status is "Backlog" and whose page ID is not in `shown` or `current`. Sort by Priority ascending. If none remain, restart from the top of the backlog (and clear `shown` to acknowledge the cycle).
4. Render the new tip into the canonical block format via `scripts/rotate-tip.py` — pipe the tip JSON to its stdin. The script rewrites the `<details class="tip-block">` block in place and updates the history file.

The tip JSON expected by `rotate-tip.py` is documented in its docstring; minimum keys are `id`, `feature`, `title`, `summary_meta`, `hook`, `what_it_does`, `why_high_leverage`, `tags`, `steps_html`, `tiein`, `source_url`.

Mark the previously-shown tip's Status in Notion based on the user's localStorage vote if known (👍 → "Live", 👎 → "Skipped" with Skip Reason). If the vote isn't observable from the headless session, leave the prior tip's Status alone.

### Step 3b — Days-carrying signal on FP cards

Every Front Page card must carry a `data-first-seen="YYYY-MM-DD"` attribute (UTC date the item first surfaced on the dashboard, NOT today). The dashboard's render-layer auto-computes "Day N" + colour pill from this attribute on page load (`.days-carrying.fresh / .warm / .stale`).

When adding a new FP card: set `data-first-seen` to today's UTC date. When carrying an existing card forward to a new edition: PRESERVE the existing `data-first-seen` value — do NOT reset it. The whole point is to surface how long an item has been carried unmoved.

Items at Day 14+ get visual stale treatment automatically — italic body, dimmed title. This is the signal to the user that the item has been carrying without action. Use it; don't paper over it by rewriting the body each cycle.

### Step 3c — Status-verification discipline

The dashboard has misclassified thread state across multiple editions in the past (notable: v1.21–v1.23 called Brendan/Lima Tyme D1 "closed via Endeavor approval" when in fact only the Endeavor entity was approved and the Lima sub-fund recommendation was still owed).

Hard rule: for every FP card carried from the prior edition, the sweep agent must verify the open/closed state of its underlying thread before this fire confirms it as still-open or still-closed. If the sweep returned ambiguous evidence, the card stays open and the meta line carries an `⚠ verify` flag. NEVER inherit the prior edition's status field uncritically.

### Step 4 — Merge sweep findings into `current.html`

When the sweep agent returns, apply edits in parallel where possible (multiple `Edit` calls in one assistant turn). Hard rules:

- Every date in the document must trace to a verified external anchor. No invented deadlines.
- "Kevin Harris" — never "Kevin Hardy" (that was a fabrication caught 2026-05-26; do not regress).
- Use "Partner" not "Founding Partner" for any Chronos colleague.
- No process notes ("v4 Pipeline", "Spock pipeline", "Verifier-pair discipline") in this user-facing dashboard.
- The version, last-calibrated timestamp, and slot label all advance together.

### Step 5 — Snapshot, publish, poll

```bash
# Use a quoted absolute-path variable — the working-dir literally contains a space
# ("Project Ledger"), and `cd path\ with\ space` silently fails in non-interactive
# Bash subshells (caught v1.16, 27 May 2026).
PROJDIR="/Users/rogergrobler/Documents/Claude/Projects/Project Ledger/project_ledger"
SAST_DATE=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d')
SLOT=$(TZ='Africa/Johannesburg' date '+%H' | awk '$1<11{print"morning"} $1>=11&&$1<16{print"midday"} $1>=16&&$1<21{print"evening"} $1>=21{print"night"}')
cp "$PROJDIR/current.html" "$PROJDIR/edition_${SAST_DATE}-${SLOT}.html"
rm -rf /tmp/spock-site-build
git clone --depth 1 https://github.com/rogergrobler/spock-site-build.git /tmp/spock-site-build
cp "$PROJDIR/current.html" /tmp/spock-site-build/ledger/index.html
cd /tmp/spock-site-build
git config user.name "Roger Grobler"
git config user.email "roger@ccap.ai"
SAST_STAMP=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d %H:%M SAST')
git add ledger/index.html
git commit -q -m "Ledger update · ${SAST_STAMP} · ${SLOT} refresh"
git push -q origin main
git rev-parse --short HEAD
```

Then poll for live propagation:

```bash
START=$(date +%s)
VERSION_TAG="<the v-string you set in step 4>"
until curl -sf -o /tmp/lc.html https://rogergrobler.github.io/spock-site-build/ledger/ && grep -q "$VERSION_TAG" /tmp/lc.html; do
  [ $(($(date +%s)-START)) -gt 180 ] && echo "TIMEOUT" && exit 1
  sleep 4
done
echo "LIVE after $(($(date +%s)-START))s"
rm -f /tmp/lc.html
```

### Step 6 — Confirm to Roger

Three-line summary:
1. Live URL + commit hash + propagation time
2. Version + slot + snapshot filename
3. Honest disclosure of what's still open (items the sweep flagged as unresolved)

## Guardrails

- Never send drafts. If the sweep identifies an email Roger should send, leave it as a draft in Gmail Drafts only.
- Never push to `main` of `spock-site-build` if the build fails any sanity check (file size collapses to <10 KB; HTML is malformed; the version tag wasn't actually injected). Stop and report.
- If a sweep MCP source errors out, proceed with the rest and disclose the gap in the published edition's footer.
- If pre-existing `current.html` is more recent than the snapshot (clock skew, manual edit), preserve it — don't overwrite blindly.
- The "Send to Claude" payload's routing instructions are limited to: apply done items, drop them from FP, carry notes into NS card bodies, add new tasks, draft replies, update NS cards. Do NOT echo back routing actions that aren't actually wired (e.g. Notion bucket sync, North Star DB updates) — that infrastructure isn't built and pretending it is breaks user trust.
- The scheduler-host architecture is documented in `docs/cloud-scheduler-setup.md`. When the user asks about scheduling reliability, point at the doc — don't re-invent the answer.
