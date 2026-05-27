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

## Author

Roger Grobler · roger.grobler@gmail.com
