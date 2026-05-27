---
name: ledger-status
description: Show Project Ledger health — last edition, live URL, MCP connectivity, scheduled tasks, recent errors. Read-only, no writes. Use when the user says "/ledger-status", "ledger status", "is the ledger healthy", "what's the last edition", "is the dashboard up", "show ledger health", or asks any read-only diagnostic question about the Stellenbosch Ledger.
---

# Project Ledger — Status

Read-only diagnostic. Never edits files, never publishes. Just reports.

## Workflow

### Step 1 — Resolve the working directory

The Ledger source-of-truth lives at:

```
~/Documents/Claude/Projects/Project Ledger/project_ledger/
```

The working HTML file is `current.html`. Snapshots are `edition_YYYY-MM-DD-<slot>.html`. If `current.html` is missing, the most recent `edition_*.html` is the recovery source.

### Step 2 — Report five lines

Produce a concise status report covering exactly these five blocks:

**1. Last edition.** `ls -lt edition_*.html | head -1` — name, size, mtime.

**2. Live URL.** `curl -sI https://rogergrobler.github.io/spock-site-build/ledger/ | head -3` for HTTP status and last-modified. Then `curl -s <url> | grep -oE 'v[0-9]+\.[0-9]+|Last calibrated[^<]*' | head -3` to confirm the version string the page is actually serving. If the version on the live URL is older than the latest `edition_*.html`, flag the gap.

**3. Scheduled tasks.** Call `CronList` (load via ToolSearch if deferred). If "No scheduled jobs", say so plainly. If jobs exist, list their cadence and last fire.

**4. MCP connectivity.** Quick ping each of: WhatsApp (`mcp__whatsapp__list_chats` with limit 1), Gmail (`mcp__5508cee3-3894-430d-ad42-a90478ec1298__search_threads` with limit 1), Calendar (`mcp__70bd15a3-8278-4771-b9a6-8282063bf947__list_calendars`), Notion (`mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-search` for "Roger"), Drive (`mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a__list_recent_files` limit 1). Report green/red per source.

**5. Recent errors.** Look for stale git locks (`~/code/spock/.git/index.lock`), the presence of `preview.html` vs `current.html` divergence, and any "broken" workflow flag (e.g. Spock CI broken since 18 May if referenced in the latest edition). One-line per finding.

### Step 3 — End cleanly

Do NOT offer to fix anything. Do NOT propose a rebuild. This is a status command — Roger asks for a rebuild separately via `/ledger-now`.

## Output format

```
**Last edition** · <name> · <bytes> · <mtime SAST>
**Live URL** · <code> · last-modified <stamp> · version on page: <v>
**Scheduled tasks** · <count> · <cadence summary, or "none">
**MCP connectivity** · WhatsApp ✓/✗ · Gmail ✓/✗ · Calendar ✓/✗ · Notion ✓/✗ · Drive ✓/✗
**Recent errors** · <one-line each, or "none">
```

If everything is green and no errors, the output is five clean lines. If something is off, the affected line carries the flag inline.

## Guardrails

- Read-only. No writes to `current.html`, no git commits, no `gh` commands, no publishes.
- Do not retry failing MCP calls more than once each — that's diagnosis, not recovery.
- If `~/Documents/Claude/Projects/Project Ledger/project_ledger/` doesn't exist, say so and stop. Don't create it. That's `/ledger-setup`'s job.
