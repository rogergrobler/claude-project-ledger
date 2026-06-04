# Run the scheduler on the Mac Studio (not a cloud VM)

Roger's call: the Mac Studio is on 24/7, so use it as the scheduler host
instead of paying $6/month for a DigitalOcean droplet. Same end result —
the 3×/day fires run regardless of whether the laptop is asleep.

The Mac Studio needs:
1. The `claude` CLI binary (logged in to Roger's account)
2. A clone of `~/code/claude-project-ledger`
3. The `whatsapp-mcp` bridge + server (so WhatsApp coverage isn't lost when
   the Mac Studio runs the fires)
4. The launchd plist `com.spock.ledger.plist` (copy from this repo)
5. Git credentials for pushing to `spock-site-build`

## What's different vs the laptop launchd

Today the laptop runs the launchd at 06:30/13:00/21:00 SAST. We want the
Mac Studio to do the same — but to AVOID DOUBLE-PUBLISHES, only one host
should fire at a time. Easiest rule:

- **Mac Studio fires always.** Authoritative.
- **Laptop launchd is unloaded** (we can re-load it manually when Roger
  wants a manual ad-hoc refresh from the laptop).

If you want belt-and-suspenders later, we can add a presence check: the
laptop fires only if it can SSH-reach the Mac Studio and find no recent
publish (i.e. the Mac Studio missed its window for some reason). For now,
single-host is simpler.

## One-time setup (assuming you have SSH access to the Mac Studio)

From your laptop:

```bash
# 1. Confirm SSH works
ssh studio.local        # or whatever hostname/IP you use

# 2. From inside the Mac Studio SSH session:
mkdir -p ~/code ~/spock/logs

# Install claude CLI (one-line installer)
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc

# Auth (opens browser flow on the Mac Studio's local user session — needs
# a screen + keyboard or VNC; if SSH-only, see fallback below)
claude login

# Clone the plugin repo
git clone https://github.com/rogergrobler/claude-project-ledger.git ~/code/claude-project-ledger

# Bootstrap ~/.claude.json so the marketplace + plugin are enabled
cat > ~/.claude.json <<'EOF'
{
  "extraKnownMarketplaces": {
    "project-ledger": {
      "source": { "source": "github", "repo": "rogergrobler/claude-project-ledger" }
    }
  },
  "enabledPlugins": { "project-ledger@project-ledger": true }
}
EOF

# Install WhatsApp MCP (mirror of the laptop install)
mkdir -p ~/spock
git clone https://github.com/lharries/whatsapp-mcp.git ~/spock/whatsapp-mcp
cd ~/spock/whatsapp-mcp/whatsapp-bridge && go build -o ~/spock/bin/whatsapp-bridge ./...
# First run will print a QR — scan with phone to pair.

# Install the launchd plist
mkdir -p ~/Library/LaunchAgents
cp ~/code/claude-project-ledger/launchd/com.rogergrobler.ledger.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.rogergrobler.ledger.plist

# Confirm
launchctl list | grep ledger
crontab -l                        # (the plist is launchd, not cron — this should be empty)
```

## Fallback if `claude login` can't open a browser via SSH

Run `claude login --auth-mode device-code` and follow the printed URL on
any device — same OAuth flow, no local browser needed.

## Tear down the laptop launchd

```bash
launchctl unload ~/Library/LaunchAgents/com.rogergrobler.ledger.plist
# (leaves the plist file in place — re-load anytime with `launchctl load`)
```

## Monitoring

- Mac Studio logs: `~/Documents/Claude/Projects/Project Ledger/project_ledger/cron-logs/`
- Last fire status visible in dashboard footer
- WhatsApp pre-flight (added in `build-ledger.workflow.js`) will post a
  Notion comment if the bridge goes stale, so you'll see the flag next
  time you open Notion

## Cost

$0/month. Mac Studio is already on 24/7.

## Why not a cloud VM after all?

Pros of the Mac Studio: no extra cost, same machine that already runs Spock,
WhatsApp MCP can live there too.

Cons: home power outage / ISP outage = no fires. If trip-resilience is the
only concern, the cloud VM is more robust. If household-uptime is fine,
Mac Studio is the right choice.
