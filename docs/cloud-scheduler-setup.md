# Cloud scheduler setup — 30 minutes, turnkey

This is the operational answer to "the Mac slept the entire Camp David week
and zero cron fires landed." A DigitalOcean droplet at $6/month runs the
3×/day `/ledger-now` fire regardless of whether the Mac is awake.

## Architecture — both hosts fire on the same schedule

The DigitalOcean droplet runs cron at 06:30 / 13:00 / 21:00 SAST and sweeps
Gmail / Calendar / Drive / Notion / pushes to spock-site-build. WhatsApp is
skipped because the WhatsApp MCP server lives locally on the Mac.

The Mac launchd also runs on the same 06:30 / 13:00 / 21:00 SAST schedule.
When the Mac is awake, its fire runs second and overwrites the cloud edition
with the WhatsApp-included version. When the Mac is asleep, the cloud edition
stands. Either way the dashboard refreshes on schedule.

## What you need before starting

- A DigitalOcean account (or any cloud with Ubuntu 22.04 droplets — Hetzner,
  Linode, Fly.io all work; the script assumes Ubuntu).
- Your Anthropic Console credentials (the `claude` CLI auths via OAuth).
- A GitHub credential the droplet can use to push to spock-site-build.
  Simplest: a deploy key with write access. Alternative: HTTPS with a PAT.

## Steps

### 1. Create the droplet (5 min)

- Ubuntu 22.04 LTS
- Basic tier, $6/month (1 vCPU, 1 GB RAM is plenty)
- Region: any — Cape Town if available, otherwise Frankfurt or Amsterdam
- SSH key: add your public key
- Enable automated weekly backups: yes (extra $1.20/month)

After it boots, ssh in:

```
ssh root@<droplet-ip>
```

### 2. Create a non-root user (1 min)

```
adduser ledger
usermod -aG sudo ledger
rsync --archive --chown=ledger:ledger ~/.ssh /home/ledger
```

Log out, log back in as `ledger`:

```
ssh ledger@<droplet-ip>
```

### 3. Run the provisioner (10 min — mostly downloads)

```
curl -fsSL https://raw.githubusercontent.com/rogergrobler/claude-project-ledger/main/scripts/provision-cloud-scheduler.sh -o provision.sh
chmod +x provision.sh
bash provision.sh
```

The script will install apt prereqs, `uv`, the Claude Code CLI, clone the
plugin repo, seed `current.html` from the live URL, initialise
`~/.claude.json` with the project-ledger marketplace enabled, and install a
crontab firing at 04:30 / 11:00 / 19:00 UTC (= 06:30 / 13:00 / 21:00 SAST).

### 4. Authenticate Claude (5 min)

```
claude login
```

OAuth flow opens a URL; complete in a browser on any device; credential
writes to the droplet's keychain. Cron fires from this point inherit the
credential.

### 5. Authenticate git for pushing (3 min)

HTTPS option:

```
git config --global credential.helper store
# First push, enter username + PAT
```

SSH option (more secure):

```
ssh-keygen -t ed25519 -C "ledger-droplet@$(hostname)"
cat ~/.ssh/id_ed25519.pub
# Add as Deploy Key on github.com/rogergrobler/spock-site-build (write access)
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

### 6. Smoke test (3 min)

```
cd ~/code/claude-project-ledger
bash scripts/ledger-cron.sh
```

Check the log:

```
ls -lt ~/Documents/Claude/Projects/Project\ Ledger/project_ledger/cron-logs/
```

Confirm the live URL bumped:

```
curl -s https://rogergrobler.github.io/spock-site-build/ledger/ | grep -oE 'v1\.[0-9]+|Last calibrated[^<]*' | head -2
```

### 7. Done

Cron is now firing every 8 hours. The Mac launchd continues firing in
parallel; when both are running, the second fire overwrites the first.
When the Mac is asleep, the cloud fire stands alone.

## Monitoring

- `~/Documents/Claude/Projects/Project Ledger/project_ledger/cron-logs/` —
  last 30 fires (auto-rotated).
- `crontab -l` — confirm the schedule.
- The published edition's footer always discloses which source was swept and
  which was unavailable.

## Cost

- $6/month droplet
- $1.20/month backups (optional)
- $0 GitHub
- Anthropic API: a few cents per fire, ~few dollars/month.

Total: **~$8/month + Anthropic API usage**.

## Tearing down

```
crontab -r
# Then destroy the droplet from the DO dashboard.
```

The Mac launchd remains untouched.
