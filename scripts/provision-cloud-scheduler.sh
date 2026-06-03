#!/usr/bin/env bash
# Provision the Stellenbosch Ledger scheduler on a fresh DigitalOcean droplet.
#
# Goal: get the 3×/day /ledger-now headless fires running on an always-on box
# instead of a Mac that sleeps.
#
# Run this ON the droplet (Ubuntu 22.04 LTS or later) after SSHing in.
# Prerequisites:
#   - Droplet exists and you can ssh as a sudo user (call them "ledger").
#   - You have a GitHub personal access token (PAT) with repo write to spock-site-build.
#   - You have an Anthropic Console account with credit + the API key handy
#     OR are willing to interactively `claude login` via SSH (one-time browser flow).
#
# What this script does:
#   1. Installs apt prerequisites (git, curl, jq, cron, build-essential).
#   2. Installs uv (for the WhatsApp MCP server — optional, see CAVEAT below).
#   3. Installs the Claude Code CLI (the same `claude` binary the Mac uses).
#   4. Clones the project-ledger plugin repo + the spock-site-build repo.
#   5. Bootstraps ~/.claude.json with the project-ledger marketplace + plugin enabled.
#   6. Installs a crontab that fires /ledger-now at 06:30, 13:00, 21:00 SAST.
#   7. Verifies cron with a dry-run.
#
# After this script: run `claude login` ONCE to authenticate. The cron will
# pick up the credential and start firing on schedule.
#
# CAVEAT — WhatsApp MCP: the local whatsapp-mcp-server is bound to a Beeper
# session that lives on the Mac. Running it on the droplet requires either
# (a) a second Beeper bridge for that account on the VM (operationally messy),
# or (b) accepting that headless cron fires from the cloud cannot sweep
# WhatsApp. This script DEFAULTS to (b) — cron fires from the cloud sweep
# Gmail/Calendar/Drive/Notion; the Mac's launchd remains as a "when home"
# supplement that adds WhatsApp coverage when awake. The SKILL.md is already
# wired to fail loudly when WhatsApp MCP isn't available, so cloud fires will
# disclose the gap in each published edition's footer.
#
# Usage:
#   bash provision-cloud-scheduler.sh
#
# Idempotent: safe to re-run.

set -euo pipefail

USER_HOME="${HOME}"
REPO_ROOT="${USER_HOME}/code/claude-project-ledger"
PLUGIN_MARKETPLACE_REPO="rogergrobler/claude-project-ledger"
SITE_BUILD_REPO="rogergrobler/spock-site-build"
PROJECT_LEDGER_DIR="${USER_HOME}/Documents/Claude/Projects/Project Ledger/project_ledger"

# Choose a fixed UTC offset for SAST (UTC+2, no DST).
# Cron times below are in UTC.
SAST_UTC_OFFSET=2

log() { printf "\033[1;34m[scheduler-provision]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[scheduler-provision ERROR]\033[0m %s\n" "$*" >&2; }

# 1. apt prerequisites
log "Installing apt prerequisites..."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq cron build-essential ca-certificates

# 2. uv (only if you plan to run a WhatsApp MCP locally — left here for option (a))
if ! command -v uv >/dev/null 2>&1; then
  log "Installing uv (Python package manager for MCP servers)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 3. Claude Code CLI
if ! command -v claude >/dev/null 2>&1; then
  log "Installing Claude Code CLI..."
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
log "Claude CLI version: $(claude --version 2>/dev/null || echo 'NOT INSTALLED')"

# 4. Clone repos
mkdir -p "${USER_HOME}/code"
if [[ ! -d "${REPO_ROOT}" ]]; then
  log "Cloning plugin repo..."
  git clone "https://github.com/${PLUGIN_MARKETPLACE_REPO}.git" "${REPO_ROOT}"
else
  log "Plugin repo exists; pulling latest..."
  git -C "${REPO_ROOT}" pull --quiet
fi

# Working dir for the ledger HTML
mkdir -p "${PROJECT_LEDGER_DIR}"
mkdir -p "${PROJECT_LEDGER_DIR}/cron-logs"

# Seed current.html from the live site if we don't have one
if [[ ! -f "${PROJECT_LEDGER_DIR}/current.html" ]]; then
  log "Seeding current.html from live site..."
  curl -fsSL "https://rogergrobler.github.io/spock-site-build/ledger/" -o "${PROJECT_LEDGER_DIR}/current.html"
fi

# 5. Bootstrap ~/.claude.json so the marketplace + plugin are enabled on first run.
CLAUDE_JSON="${USER_HOME}/.claude.json"
if [[ ! -f "${CLAUDE_JSON}" ]]; then
  log "Initialising ~/.claude.json..."
  cat > "${CLAUDE_JSON}" <<EOF
{
  "extraKnownMarketplaces": {
    "project-ledger": {
      "source": {
        "source": "github",
        "repo": "${PLUGIN_MARKETPLACE_REPO}"
      }
    }
  },
  "enabledPlugins": {
    "project-ledger@project-ledger": true
  }
}
EOF
else
  log "~/.claude.json exists; manual merge required if marketplace not present."
  log "Confirm with: jq '.extraKnownMarketplaces, .enabledPlugins' ${CLAUDE_JSON}"
fi

# 6. Install cron wrapper + crontab
WRAPPER="${REPO_ROOT}/scripts/ledger-cron.sh"
if [[ ! -x "${WRAPPER}" ]]; then
  chmod +x "${WRAPPER}"
fi

# Convert 06:30 / 13:00 / 21:00 SAST to UTC for cron (subtract 2h)
# 06:30 SAST = 04:30 UTC
# 13:00 SAST = 11:00 UTC
# 21:00 SAST = 19:00 UTC
CRON_LINES=(
  "30 4 * * * ${WRAPPER} > /dev/null 2>&1   # ledger-now morning (06:30 SAST)"
  "0 11 * * * ${WRAPPER} > /dev/null 2>&1   # ledger-now midday (13:00 SAST)"
  "0 19 * * * ${WRAPPER} > /dev/null 2>&1   # ledger-now evening (21:00 SAST)"
)

CRON_TAG="# project-ledger scheduler"
CRON_CURRENT="$(crontab -l 2>/dev/null || true)"
CRON_NEW="$(printf "%s\n" "${CRON_CURRENT}" | grep -v "${CRON_TAG}" | grep -v "ledger-now" || true)"
{
  printf "%s\n" "${CRON_NEW}"
  printf "%s\n" "${CRON_TAG}"
  for line in "${CRON_LINES[@]}"; do printf "%s\n" "${line}"; done
} | crontab -

log "Installed crontab:"
crontab -l

# 7. Verify
log ""
log "✓ Provisioning complete."
log ""
log "NEXT STEPS:"
log "  1. Run: claude login    (one-time browser OAuth — opens a URL you visit on any device)"
log "  2. Verify: cd ${REPO_ROOT} && ./scripts/ledger-cron.sh"
log "     This fires /ledger-now once; check ${PROJECT_LEDGER_DIR}/cron-logs/"
log "  3. Confirm the live URL bumps: curl -sI https://rogergrobler.github.io/spock-site-build/ledger/"
log ""
log "Cron will fire at 04:30 / 11:00 / 19:00 UTC = 06:30 / 13:00 / 21:00 SAST."
log ""
log "Caveat: cloud fires sweep Gmail/Calendar/Drive/Notion but NOT WhatsApp"
log "(WhatsApp MCP server is local to the Mac). Footer will disclose the gap."
log "Mac's launchd remains as a 'when home' WhatsApp supplement."
