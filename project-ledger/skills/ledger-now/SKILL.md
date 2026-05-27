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

- Pull WhatsApp messages from the last 24 hours via `mcp__whatsapp__list_chats` then `mcp__whatsapp__list_messages` per active chat.
- Run targeted Gmail searches via `mcp__5508cee3-3894-430d-ad42-a90478ec1298__search_threads` keyed to the open threads from the previous edition (M-Kopa, Optasia, portfolio names, family threads).
- List today and tomorrow's calendar events via `mcp__70bd15a3-8278-4771-b9a6-8282063bf947__list_events`.
- Hit Notion (`mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-search`) for last-edited matches on the active deal codenames.
- Hit Drive (`mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a__list_recent_files`) for fresh documents.
- Return a digest under 700 words structured as: WhatsApp deltas / Gmail deltas / Calendar today+tomorrow / Notion deltas / Drive deltas / what's-still-open verification / top 3 next-90-minute actions.
- Name source errors but never retry endlessly.

NO cached data. NO copying from the previous edition's notes. Fresh reads only.

### Step 3 — In parallel while the sweep runs

Read `current.html` to confirm the structure (kicker, subtitle, dateline, lede, North Star NS cards, Front Page priority grid, Day cards, Pullquote, Footer). Identify what the new edition's kicker/version should be — increment the minor version (e.g., v1.14 → v1.15), set the slot label ("Wednesday morning", "Wednesday midday", "Wednesday evening", etc.) from the system clock in SAST.

Surface from the prior edition: any items marked done in a "Send to Claude" payload that should be cleared (act-* rows, FP cards). If no payload was supplied, leave done-state untouched.

### Step 4 — Merge sweep findings into `current.html`

When the sweep agent returns, apply edits in parallel where possible (multiple `Edit` calls in one assistant turn). Hard rules:

- Every date in the document must trace to a verified external anchor. No invented deadlines.
- "Kevin Harris" — never "Kevin Hardy" (that was a fabrication caught 2026-05-26; do not regress).
- Use "Partner" not "Founding Partner" for any Chronos colleague.
- No process notes ("v4 Pipeline", "Spock pipeline", "Verifier-pair discipline") in this user-facing dashboard.
- The version, last-calibrated timestamp, and slot label all advance together.

### Step 5 — Snapshot, publish, poll

```bash
cd ~/Documents/Claude/Projects/Project\ Ledger/project_ledger
SAST_DATE=$(TZ='Africa/Johannesburg' date '+%Y-%m-%d')
SLOT=$(TZ='Africa/Johannesburg' date '+%H' | awk '$1<11{print"morning"} $1>=11&&$1<16{print"midday"} $1>=16&&$1<21{print"evening"} $1>=21{print"night"}')
cp current.html "edition_${SAST_DATE}-${SLOT}.html"
rm -rf /tmp/spock-site-build
git clone --depth 1 https://github.com/rogergrobler/spock-site-build.git /tmp/spock-site-build
cp current.html /tmp/spock-site-build/ledger/index.html
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
