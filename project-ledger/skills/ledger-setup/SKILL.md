---
name: ledger-setup
description: Run the Project Ledger first-time setup wizard (or re-run it to add/change something). Configures the source directory, publish target, MCP server allowances, and optional 3×/day scheduled rebuild. Use when the user says "/ledger-setup", "set up the ledger", "first-time ledger setup", "configure the dashboard", "wire up scheduled rebuilds", "add a new source to the ledger", or "the ledger needs configuring".
---

# Project Ledger — Setup

Wizard for first-time install or reconfiguration. Idempotent — safe to re-run.

## Workflow

### Step 1 — Survey the existing state

Before asking any questions, check what's already configured:

- `~/Documents/Claude/Projects/Project Ledger/project_ledger/` exists?
- `current.html` exists there?
- `~/code/spock-site-build/` cloned locally? (Optional — the skill clones to `/tmp` per-run by default.)
- `~/.claude/settings.json` has whole-server permissions for `mcp__whatsapp`, `mcp__5508cee3-3894-430d-ad42-a90478ec1298` (Gmail), `mcp__70bd15a3-8278-4771-b9a6-8282063bf947` (Calendar), `mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5` (Notion), `mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a` (Drive)?
- `CronList` has any scheduled jobs?

Report what's present, then proceed to fill gaps.

### Step 2 — Source directory

If the working dir doesn't exist, create it:

```bash
mkdir -p ~/Documents/Claude/Projects/Project\ Ledger/project_ledger/
```

If `current.html` doesn't exist but `edition_*.html` snapshots are present, copy the most recent into `current.html`. If neither exists, prompt Roger: "No edition history found. Want me to generate a v1.0 skeleton, or are you migrating from another machine?"

### Step 3 — Publish target

Confirm `https://github.com/rogergrobler/spock-site-build` is reachable (no auth needed for clone — the repo is public). The push step uses the user's git credentials, so don't try to configure auth in the skill — leave that to the user's normal git setup (gh CLI, SSH keys, or HTTPS token).

### Step 4 — MCP permissions

Read `~/.claude/settings.json`. Verify the `permissions.allow` list contains the five MCP server prefixes:
- `mcp__whatsapp`
- `mcp__5508cee3-3894-430d-ad42-a90478ec1298` (Gmail)
- `mcp__70bd15a3-8278-4771-b9a6-8282063bf947` (Calendar)
- `mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5` (Notion)
- `mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a` (Drive)

If any are missing or are per-tool entries instead of whole-server entries, propose the diff and ask Roger to confirm before editing settings.json. Do not silently edit user settings.

### Step 5 — Optional: 3×/day schedule

Offer Roger a recurring rebuild schedule. Default cadence (in SAST): 06:30, 13:00, 21:00. Implementation: use the `scheduled-tasks` MCP (`mcp__scheduled-tasks__create_scheduled_task`) or `CronCreate` if the harness exposes it.

The scheduled task prompt should be: `/ledger-now`. Each fire triggers a full sweep + publish.

Do NOT create the schedule without asking — Roger may prefer manual fires.

### Step 6 — Portable across machines

This plugin is delivered via marketplace at `github.com/rogergrobler/claude-project-ledger`. On any new machine linked to Roger's account, the install path is:

1. The marketplace is registered in `~/.claude/settings.json` under `extraKnownMarketplaces.project-ledger`.
2. The plugin is enabled in `enabledPlugins`.
3. On launch, Claude Code fetches the latest from GitHub and the four skills become available.

The skills themselves are stateless — they read the local filesystem and the MCP servers. So the only per-machine state is:
- The presence of `~/Documents/Claude/Projects/Project Ledger/project_ledger/` (just edition history — restorable from the GitHub Pages repo if needed).
- The MCP server permissions (settings.json — synced via Roger's normal config flow).
- Git credentials for pushing to `spock-site-build` (gh CLI or SSH).

### Step 7 — Confirm and exit

Print a five-line state summary matching `/ledger-status`. If everything is green, end with: "Setup complete. Run `/ledger-now` for an immediate refresh, or wait for the next scheduled fire."

## Guardrails

- Idempotent. Re-running must never destroy state.
- Never edit `~/.claude/settings.json` without showing the diff and getting explicit confirmation.
- Never push to `spock-site-build` during setup — that's `/ledger-now`'s job.
- If Roger is migrating from another machine, prefer restoring `current.html` from `https://rogergrobler.github.io/spock-site-build/ledger/` (curl into a file) over generating a fresh v1.0 skeleton.
