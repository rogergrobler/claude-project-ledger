# project-ledger

Stellenbosch Ledger — Roger Grobler's personal dashboard, refreshed across WhatsApp, Gmail, Calendar, Notion, and Drive, published to GitHub Pages.

## Install

On any machine linked to Roger's Claude account:

1. Add this repo as a marketplace in `~/.claude/settings.json`:

   ```json
   "extraKnownMarketplaces": {
     "project-ledger": {
       "source": {
         "source": "github",
         "repo": "rogergrobler/claude-project-ledger"
       }
     }
   }
   ```

2. Enable the `project-ledger` plugin in `enabledPlugins`.

3. Restart Claude Code. The four skills become available:

   - `/ledger-status` — read-only health check
   - `/ledger-now` — force fresh rebuild + publish
   - `/ledger-rebuild` — heavyweight from-scratch regeneration
   - `/ledger-setup` — first-time wizard or reconfiguration

## What lives where

- **Working files** — `~/Documents/Claude/Projects/Project Ledger/project_ledger/` (`current.html` + `edition_*.html` snapshots)
- **Publish target** — `github.com/rogergrobler/spock-site-build` → `ledger/index.html`
- **Live URL** — `https://rogergrobler.github.io/spock-site-build/ledger/`
- **Plugin source** — this repo

## Data sources

| Source | MCP server prefix |
| --- | --- |
| WhatsApp | `mcp__whatsapp` |
| Gmail | `mcp__5508cee3-3894-430d-ad42-a90478ec1298` |
| Calendar | `mcp__70bd15a3-8278-4771-b9a6-8282063bf947` |
| Notion | `mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5` |
| Drive | `mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a` |

Each needs to be in the `permissions.allow` list of `~/.claude/settings.json`. `/ledger-setup` checks this.

## Scheduled rebuilds (macOS launchd)

A launchd job fires the rebuild three times a day in SAST:

| Time (SAST) | Slot |
| --- | --- |
| 06:30 | morning |
| 13:00 | midday |
| 21:00 | evening |

Each fire runs `claude --print --dangerously-skip-permissions "/ledger-now"` headlessly, logs to `~/Documents/Claude/Projects/Project Ledger/project_ledger/cron-logs/`, and rotates the last 30 fires.

### Install on a new machine

```bash
bash ~/code/claude-project-ledger/scripts/install-launchd.sh
```

Idempotent — unloads any existing job before re-installing. Requires:
- `claude` CLI at `~/.local/bin/claude` (logged in to your account)
- `gh` CLI authenticated (`gh auth status` green) for the `spock-site-build` push
- The `project-ledger` plugin enabled in `~/.claude/settings.json` (this repo's marketplace registered)

### Inspect / debug

```bash
# Is the job loaded?
launchctl list | grep ledger

# Recent fires
ls -lt ~/Documents/Claude/Projects/Project\ Ledger/project_ledger/cron-logs/

# Fire one manually
bash ~/code/claude-project-ledger/scripts/ledger-cron.sh

# Uninstall
launchctl unload ~/Library/LaunchAgents/com.rogergrobler.ledger.plist
rm ~/Library/LaunchAgents/com.rogergrobler.ledger.plist
```

### Linux / other OS

The plist + launchctl path is macOS-specific. For Linux, port to systemd (`~/.config/systemd/user/ledger.timer` + `ledger.service`) or cron — the `ledger-cron.sh` script is portable.

## Author

Roger Grobler · roger.grobler@gmail.com
