/**
 * build-ledger.workflow.js — Full Stellenbosch Ledger build pipeline.
 *
 * Replaces the hand-curated rebuild flow with a deterministic multi-phase
 * Workflow that runs the same gates every time. This is where dashboard
 * "consistency" actually lives — every refresh, scheduled or manual,
 * follows the same sequence:
 *
 *     1. Sweep (parallel, 6 sources)
 *     2. Synthesize (merge deltas into structured patches)
 *     3. Rotate the Claude Tip of the Day
 *     4. Apply patches + bump 9 timestamp anchors
 *     5. Snapshot + publish + poll for live
 *
 * To run interactively:
 *
 *     Workflow({ scriptPath: "~/code/claude-project-ledger/workflows/build-ledger.workflow.js" })
 *
 * To run from the headless cron (Mac launchd or cloud VM), see the
 * `scripts/ledger-cron.sh` wrapper — it can be updated to invoke
 * `claude --print "Run the build-ledger workflow"` and Claude will route
 * through this script.
 *
 * Designed to be edited. Each phase's prompt + schema is co-located so you
 * can tune one phase without reading the whole file. The published edition
 * always discloses the workflow run-id in its footer, so failures are
 * traceable.
 */

export const meta = {
  name: 'build-ledger',
  description: 'Stellenbosch Ledger end-to-end build pipeline — parallel sweep, synthesize, tip rotation, apply, publish, notify. Replaces the hand-curated rebuild path so every refresh follows the same gates.',
  phases: [
    { title: 'Sweep',         detail: '6 parallel agents across WhatsApp (3 mandatory + self-chat) + Gmail + Calendar + Notion + Drive' },
    { title: 'Synthesize',    detail: 'merge deltas into structured patches for FP cards, NS cards, and the lede' },
    { title: 'ChiefOfStaff',  detail: 'NS-spine state + time-budgeted action list (no artificial cap, load_ratio ~1.15) + optional WhatsApp question' },
    { title: 'RotateTip',     detail: 'query Notion Tips Backlog for next unticked entry' },
    { title: 'Apply',         detail: 're-inject frozen JS (self-heal) + apply patches + bump timestamp anchors; never touch <script> blocks' },
    { title: 'Verify',        detail: 'publish gate — JS parses + core handlers present; abort the run if not' },
    { title: 'Publish',       detail: 'snapshot + git clone spock-site-build + commit + push + poll for live' },
  ],
}

// ── Phase 0: scout the current state + WhatsApp MCP pre-flight ─────────────

phase('Sweep')

const PROJECT_LEDGER_DIR = '~/Documents/Claude/Projects/Project Ledger/project_ledger'
const PLUGIN_DIR = '~/code/claude-project-ledger'  // this plugin repo — holds the frozen JS template + build gate
// Bash-safe, fully-quoted tokens for the node scripts: $HOME expands inside double
// quotes AND the spaces in "Project Ledger" are protected. (Node does NOT expand ~,
// so a quoted "~/..." path fails with ENOENT — use these instead.)
const CURRENT_HTML_SH = '"$HOME/Documents/Claude/Projects/Project Ledger/project_ledger/current.html"'
const PLUGIN_SCRIPTS_SH = '"$HOME/code/claude-project-ledger/scripts"'
const SPOCK_SITE_BUILD_REPO = 'https://github.com/rogergrobler/spock-site-build.git'
const LIVE_URL = 'https://rogergrobler.github.io/spock-site-build/ledger/'

const CONTEXT = `Roger Grobler, Partner at Chronos Capital Advisory in Stellenbosch.
The Stellenbosch Ledger is his personal dashboard, published to ${LIVE_URL}.
This workflow rebuilds it from scratch using fresh sweeps across his integrated
data sources.`

// ── ALABAMA SUPREME PRIORITY (Roger's wife Elca — overrides every other rule) ─
// Origin 2026-06-06: Roger missed an explicit "action. Phone Louisa please"
// message from Elca during the week of 1 Jun, got "in trouble" for it. This
// rule encodes that the pattern cannot recur. Any inbound from Elca that
// matches action-shape triggers THREE simultaneous surfaces:
//   1. The permanent #alabama-band at the top of the dashboard (above tab-bar)
//      shows it as a fire-styled action chip with the WhatsApp deeplink.
//   2. Top of cos.do_this_now with rank=0, importance=3, deadline_today=true,
//      and immune to revealed-preference demotion.
//   3. Front Page gets a `.card.fire` with Family NS tag.
// The sweep agent MUST run an Alabama-first WhatsApp query before any other
// source. If Alabama has nothing new, log that explicitly so Roger can see
// the surface was checked.
const ALABAMA = {
  person: 'Elca Grobler',
  whatsapp_alias: 'Alabama',
  whatsapp_number: '27721818934',
  whatsapp_deeplink: 'https://wa.me/27721818934',
  importance_rating: '3 · Always promote',
  ns: 'family',
  action_keywords: ['action','please','call','phone','fetch','pick up','remember','tell','buy','book','sign','reply','send','drop off','collect','order','organise','organize','sort','fix','arrange'],
  imperative_verbs_sentence_start: ['phone','call','fetch','buy','tell','ask','remember','book','sign','reply','send','order','pick','drop','collect','arrange','organise','organize','sort','fix','check','confirm','do','get','make','take','bring','find','help','please'],
  rule_id: 'rule-alabama-supreme-priority',
  overrides: ['rule-revealed-preference-3-strike-ask', 'rule-irreversible-ask', 'time_budget cap', 'load_ratio cap'],
  sentinel_band_id: 'alabama-band',
}

// ── FABRICATION BLOCKLIST (Roger's standing kill-list) ─────────────────────
// Items the CoS / synthesize phases MUST NOT regenerate. Each entry was
// flagged by Roger as a hallucination during a live fire. The apply phase
// strips any matching item from cos.do_this_now and patch.fp_cards_add
// before rendering, and writes a "blocklist hit" line to the footer audit.
//
// To add an entry: paste the action title (or substring), the data-id if
// known, and a one-line reason with the date Roger called it out. Append-
// only — never delete entries, otherwise the regression returns.
const FABRICATION_BLOCKLIST = [
  {
    id: 'dtn-11',
    title_substrings: ['Rich Shapiro', "Joshua's car", "Joshua's storage", 'car/storage handover', 'EY) on Joshua'],
    reason: 'Fabricated CoS task. Roger killed it 2026-06-05 (v1.42) — "I have no idea what you\'re talking about" — and again 2026-06-06 (v1.46) — "This is a nonsense, fabricated action. Delete everywhere". Recurrence means the CoS is rebuilding it from a sweep echo; never regenerate.',
    flagged: '2026-06-05',
  },
]

// ── STRUCTURAL BASELINE (v1.46+ tabbed layout — FROZEN) ────────────────────
// The dashboard structure as of v1.46 (6 Jun 2026). The apply phase MUST
// preserve this structure. The 06:30 06-Jun fire reverted from the tabbed
// layout back to the v1.40 NS-spine + Do-This-Now-band layout because the
// apply prompt didn't know about the tab structure. This constant is now
// the canonical reference.
const STRUCTURAL_BASELINE = {
  baseline_version: 'v1.69',
  tab_bar_id: 'tab-bar',
  // ⚠ Tab order is significant: front-page is leftmost + default. Do not reorder.
  tabs: [
    { id: 'tab-front-page',     panel: 'panel-front-page',     label: '🔥 Front Page',           count_id: null,                   counted: 'no badge — count shown in #fp-budget chip instead' },
    { id: 'tab-deep-work',      panel: 'panel-deep-work',      label: '🎯 Deep Work',            count_id: 'count-deep-work',      counted: 'manually-curated focus items (rarely changes)' },
    { id: 'tab-isa',            panel: 'panel-isa',            label: '👤 Isa',                 count_id: 'count-isa',            counted: 'open Isa payment + action rows' },
    { id: 'tab-people',         panel: 'panel-people',         label: '📨 People & Bottlenecks', count_id: 'count-people',         counted: 'open signal-item rows' },
    { id: 'tab-north-stars',    panel: 'panel-north-stars',    label: '⭐ North Stars',           count_id: null,                   counted: '7 stars, fixed' },
    { id: 'tab-everything-else',panel: 'panel-everything-else',label: '🗂 Everything else',       count_id: null,                   counted: 'backlog' },
    { id: 'tab-done',           panel: 'panel-done',           label: '✅ Done',                 count_id: 'count-done',           counted: 'last 72h of completed items' },
  ],
  retired_legacy_ids: [
    'ns-spine-band', 'do-this-now-band',   // retired v1.45–v1.46
    'alabama-band',  'alabama-promise',    // retired v1.53
    'tab-do-this-now', 'panel-do-this-now', 'do-this-now-list', 'count-do-this-now',  // retired v1.69
  ],
  retired_reason: 'Roger 5–15 Jun: each retirement removed a surface that duplicated existing components and created state-desync (tick in one place, doesn\'t propagate). The apply phase must STRIP these elements if it finds them, never regenerate them, and never recreate the Do This Now tab. Front Page is now the single action surface — CoS rank is expressed via .fire class + the .card-whynow line under the title, not via a separate panel.',
  fp_card_container: 'priority-grid',         // inside #panel-front-page
  fp_budget_chip: 'fp-budget',                // single-line summary chip at top of #priority-grid
  fp_budget_text: 'fp-budget-text',           // span where workflow writes "{N} cards · {fire} fire · ~{min} min focus left today"
  stale_banner: 'stale-banner',               // hidden div above tab-bar; JS shows when >12h stale
  body_compiled_at: 'data-compiled-at',       // body attribute — set to ISO timestamp on every fire; powers stale-banner JS
  global_question_band: 'cos-question-band',  // ABOVE the tab-bar; not inside any tab-panel
  default_tab: 'front-page',                  // showTab default + TAB_NAMES[0]
}

// Notion infrastructure IDs (verified to exist on 2026-06-04).
const NOTION_IDS = {
  bucket_signatures:    '33d493ab-3bff-81a1-aecb-c1b998a39e45',  // 📝 Signatures Pending
  bucket_payments:      '33d493ab-3bff-81bc-8927-df11c7deb1ca',  // 💰 Payments Pending
  bucket_reviews:       '33d493ab-3bff-8112-8f04-dec55d9c1d78',  // 👁 Reviews Pending
  bucket_respond:       '33d493ab-3bff-8170-b840-ef21c53d9025',  // 📧 Respond Pending
  bottlenecks_page:     '35f493ab-3bff-813c-bb48-c595787bbd21',  // 🚧 Bottlenecks
  people_db:            '2ef493ab-3bff-802d-981c-e12fec6885c7',  // Shared People DB
  projects_db:          '2ef493ab-3bff-8083-9fb6-d891d53796d4',  // Projects DB
  north_stars_db:       '5fe56ac2-2289-4b1b-b30a-4f589f100634',  // 🎯 North Stars
  active_goals:         '326493ab-3bff-8191-b727-d9cf80d7513a',  // 🎯 Active Goals — Weekly Scorecard
  tips_backlog:         '114727aa-c905-40fc-9d5b-c76342f93189',  // 🎓 Claude Tips Backlog (data source)
  // Chief of Staff infrastructure (created 4 Jun 2026, under "🧠 Claude Context — Roger Private")
  cos_importance_db:    '8bef271818ef4b46b7311eacf1f5c3e5',     // 🌟 Roger's People — Importance Layer (PRIVATE)
  cos_decisions_log:    '375493ab-3bff-8110-a675-fc2821c73e7f', // 🧠 CoS — Specific Decisions (append-only)
  cos_generalised_rules:'375493ab-3bff-818f-b34c-ca3acfca77f1', // 🧠 CoS — Generalised Rules
  cos_design:           '375493ab-3bff-81be-9e61-d399538842ca', // 🧠 CoS — Design (canonical)
  roger_self_chat:      '27663116507@s.whatsapp.net',            // Q&A loop channel
}

// ── Phase 0.5: WhatsApp MCP pre-flight ─────────────────────────────────────
// WhatsApp is Roger's main comms layer. If the MCP/bridge is stuck (auth
// expired, daemon dead, db stale), every WhatsApp sweep silently returns
// empty and the dashboard publishes with invisible-blindness. Pre-flight
// catches this before the sweep wastes 6 agents producing useless output.

const preflight = await agent(
  `Verify the WhatsApp MCP is healthy before the sweep runs.

Step 1: Call mcp__whatsapp__list_chats with limit=1 and sort_by="last_active".
Step 2: Inspect the result. If empty, the MCP is dead. If non-empty, look at
the top chat's last_message_time. If it's older than 6 hours from now (use
TZ=Africa/Johannesburg date '+%s' via Bash to know "now"), the bridge has
stopped syncing and the dashboard would publish with stale WhatsApp data.
Step 3: Return a structured assessment.

If the bridge is stale, ALSO call mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-create-comment
to post a comment on Roger's Spock root page (id 2ef493ab-3bff-803e-91b0-f832778a2dd4)
saying "WhatsApp MCP is stale (last_message_time = X). Bridge likely needs
re-pair. Run: tail -30 ~/spock/logs/bridge.out.log to see the QR." That way
Roger has a clear flag waiting for him next time he opens Notion.

${CONTEXT}`,
  {
    label: 'whatsapp-preflight',
    phase: 'Sweep',
    schema: {
      type: 'object',
      properties: {
        healthy: { type: 'boolean' },
        last_message_time: { type: 'string', description: 'ISO timestamp of newest WhatsApp message visible' },
        staleness_hours: { type: 'number' },
        reason: { type: 'string', description: 'one-line explanation' },
      },
      required: ['healthy', 'reason'],
    },
  }
)

log(preflight.healthy
    ? `WhatsApp MCP healthy (newest msg: ${preflight.last_message_time})`
    : `⚠ WhatsApp MCP STALE — ${preflight.reason}. Sweep will continue but flag the gap in the published edition's footer.`)

const WHATSAPP_HEALTHY = preflight.healthy

// ── Sweep schema: every source returns the same shape ──────────────────────

const SWEEP_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    deltas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          when: { type: 'string', description: 'ISO timestamp or human-readable time' },
          who: { type: 'string' },
          what: { type: 'string', description: 'one-line summary, ≤ 30 words' },
          status: { type: 'string', enum: ['action_owed', 'fyi', 'closed', 'in_flight', 'time_pressured'] },
          notable: { type: 'boolean', description: 'true if this likely belongs on FP grid or NS card' },
          thread_url: { type: 'string', description: 'mail/whatsapp/notion url if known' },
        },
        required: ['who', 'what', 'status', 'notable'],
      },
    },
    still_open: { type: 'array', items: { type: 'string' } },
    source_errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['source', 'deltas', 'still_open', 'source_errors'],
}

// ── Sweep prompts: edit these to add a new source or retune coverage ──────

const SWEEP_SOURCES = [
  {
    key: 'whatsapp-mandatory',
    prompt: `Pull WhatsApp messages since ${args?.since || 'the last published edition'} from THREE mandatory threads:
- Isa De Villiers DM: chat_jid 27721818934@s.whatsapp.net
- Isa Projects group: chat_jid 919908732597-1543670455@g.us
- Elca/Alabama DM: chat_jid 919908732597@s.whatsapp.net
Use mcp__whatsapp__list_messages with after=${args?.since || '<prior_edition_timestamp>'}.
ALSO scan every message body for the case-insensitive prefix "spock:" — flag those verbatim.
${CONTEXT}`,
  },
  {
    key: 'whatsapp-self-chat',
    prompt: `Roger's self-chat. Phone 27663116507. Try chat_jid 27663116507@s.whatsapp.net first.

This source serves TWO purposes per fire — you MUST extract both:

(1) VOICE / TEXT NOTES (existing) — extract substance per note: (a) action, (b) observation, (c) thought to develop, (d) reminder, (e) other. Return verbatim text in 'what' field with status reflecting follow-through implied.

(2) ⚠ SEND-TO-CLAUDE PAYLOADS (NEW · standing instruction from Roger 5 Jun) — any message body whose FIRST line matches the regex \`^# Dashboard Updates · Stellenbosch Ledger\` is a payload Roger sent from the dashboard's "Send to Claude" button. These are NOT freeform notes — they are STRUCTURED commands the apply phase MUST process before publishing.

For each such payload found:
- Return ONE delta with status='action_owed', notable=true, who='Roger (Send to Claude payload)', what='PAYLOAD: <full markdown body verbatim>'
- Set the 'when' field to the message timestamp
- The synthesize + apply phases will parse the markdown sections (Items marked done / New tasks / Inbox handled / Tip feedback / etc.) and route them. Roger never needs to copy-paste the payload manually again.

If MULTIPLE Send-to-Claude payloads have arrived since the prior edition (e.g. Roger sent two from different devices), return them all — the apply phase merges in order.

If NO payload has arrived since the prior edition, that's fine — just return the regular notes deltas.

${CONTEXT}`,
  },
  {
    key: 'gmail',
    prompt: `Pull Gmail threads with newer_than:1d via mcp__5508cee3-3894-430d-ad42-a90478ec1298__search_threads.
Always include targeted queries: "Lima", "Brendan", "Tyme D1", "Coen", "Aditus", "Willem Els", "Eden GP", "Hloni Motsohi", "Optasia", "Salvador", "Bassim", "Yusuf", "Atlax", "WeR1", "Geordie", "Juraj Priciel", "Tjaart", "Pieter".
For each thread return latest message sender, time, and one-line substance.
${CONTEXT}`,
  },
  {
    key: 'calendar',
    prompt: `List events for today and the next 2 days via mcp__70bd15a3-8278-4771-b9a6-8282063bf947__list_events.
Return chronological list with time, title, attendees if visible. Flag any new bookings since yesterday afternoon.
${CONTEXT}`,
  },
  {
    key: 'notion',
    prompt: `Search Notion for pages edited since ${args?.since || 'the last edition'}.
Use mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-search with queries: "M-Kopa", "Aditus", "Optasia", "Tyme D1", "Spock Flow", "Juraj", "Action items", "Roger".
Return only real movement on deal pages or action items.
${CONTEXT}`,
  },
  {
    key: 'drive',
    prompt: `List recent Drive files via mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a__list_recent_files.
Filter to anything modified since ${args?.since || 'the last edition'}. Return new files relevant to active deals (M-Kopa, Optasia, Tyme, Atlax, etc.). Don't include personal admin (invoices, receipts) unless flagged "notable".
${CONTEXT}`,
  },
]

const sweepResults = await parallel(SWEEP_SOURCES.map(s => () =>
  agent(
    s.prompt + `\n\nReturn structured output matching the schema. The 'source' field should be "${s.key}".`,
    { label: `sweep:${s.key}`, phase: 'Sweep', schema: SWEEP_SCHEMA }
  )
))
const sources = sweepResults.filter(Boolean)
log(`Sweep complete: ${sources.length}/${SWEEP_SOURCES.length} sources returned.`)

// ── Phase 2: Synthesize ───────────────────────────────────────────────────

phase('Synthesize')

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    kicker: { type: 'string', description: 'New kicker text — slot + version + 3-clause summary' },
    subtitle: { type: 'string', description: 'New subtitle line — what changed this edition' },
    lede_h2: { type: 'string', description: 'New <h2> in the lede block — substantive frame for this edition' },
    fp_cards_add: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'unique action ID, format: fp-<weekday>-<noun>-<short>' },
          title: { type: 'string' },
          ns: { type: 'string', enum: ['chronos', 'portfolio', 'family', 'inner-life', 'flywheel', 'spock', 'matterhorn'] },
          meta: { type: 'string', description: 'card-meta line' },
          body: { type: 'string' },
          action_url: { type: 'string' },
          is_fire: { type: 'boolean', description: 'true for the .card.fire styling — top-of-stack items' },
        },
        required: ['id', 'title', 'ns', 'meta', 'body', 'action_url', 'is_fire'],
      },
    },
    fp_cards_drop: { type: 'array', items: { type: 'string' }, description: 'data-id values of cards to remove' },
    fp_cards_update_meta: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          new_meta: { type: 'string' },
        },
        required: ['id', 'new_meta'],
      },
      description: 'just update the .card-meta line on existing cards (e.g. to increment Day-N)',
    },
    ns_card_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ns: { type: 'string' },
          body: { type: 'string', description: 'new NS card body HTML' },
          nba: { type: 'string', description: 'new NS card next-best-action line' },
        },
        required: ['ns', 'body', 'nba'],
      },
    },
    pullquote: { type: 'string' },
    footer_audit: { type: 'string', description: 'one-line edition audit for the footer span' },
    open_items_summary: { type: 'string', description: 'one-line summary of what stays open this edition' },
    version_string: { type: 'string', description: 'e.g. v1.28' },
    slot_label: { type: 'string', description: 'e.g. "Thursday Late Afternoon"' },
    // NEW v0.3 sections — produced by the synthesize phase, rendered into a
    // dedicated dashboard band ABOVE the FP grid.
    important_people_owed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          why_important: { type: 'string', description: 'role/relationship grounding the importance call' },
          last_inbound: { type: 'string', description: 'ISO timestamp or human-readable; what they sent and when' },
          days_owed: { type: 'number' },
          channel: { type: 'string', enum: ['gmail', 'whatsapp', 'notion', 'other'] },
          action_url: { type: 'string' },
        },
        required: ['name', 'why_important', 'last_inbound', 'days_owed', 'channel'],
      },
      description: 'People in Roger\'s People DB tagged Portfolio/Investor/Advisor (proxy for "important" until the Important field exists), or who appear in Active Goals/Projects, who sent something Roger has not responded to. Sort by days_owed descending.',
    },
    roger_bottlenecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          who_is_blocked: { type: 'string', description: 'person or team waiting on Roger' },
          on_what: { type: 'string', description: 'specific decision, signature, payment, review, response' },
          north_star: { type: 'string', enum: ['chronos', 'portfolio', 'family', 'inner-life', 'flywheel', 'spock', 'matterhorn'] },
          relevant_project: { type: 'string', description: 'which active project this sits in, if any' },
          days_blocked: { type: 'number' },
          downstream_cost: { type: 'string', description: 'plain-English consequence of the delay (one line)' },
        },
        required: ['who_is_blocked', 'on_what', 'north_star', 'days_blocked'],
      },
      description: 'Bottlenecks Roger is creating right now — items where multiple downstream people/processes are waiting on a Roger decision/action. Derived by cross-referencing the 4 Notion bucket pages (Signatures, Payments, Reviews, Respond) with the North Star spine and the active projects list. Sort by downstream_cost severity, then by days_blocked.',
    },
  },
  required: ['kicker', 'subtitle', 'lede_h2', 'fp_cards_add', 'fp_cards_drop', 'fp_cards_update_meta',
             'ns_card_updates', 'pullquote', 'footer_audit', 'open_items_summary',
             'version_string', 'slot_label', 'important_people_owed', 'roger_bottlenecks'],
}

const synthPrompt = `Synthesize the sweep digest below into a structured patch for the dashboard.

You have full sweep results from 6 sources. The current dashboard state is in
${PROJECT_LEDGER_DIR}/current.html — Read it to know what's there.

Apply these disciplines (from the /ledger-now SKILL.md):
- Status verification: don't inherit a "closed" status from the prior edition uncritically. Did this fire's sweep produce evidence the thread is still open? If ambiguous, the card stays open and gets a "⚠ verify" flag in its meta.
- Day-N count: every carried FP card has data-first-seen — render the day count from that, do not regenerate it.
- Drop done items only if the prior "Send to Claude" payload listed them (passed via args.payload_done). If no payload supplied, leave them alone.
- Hard rules: every date traces to a verified anchor; "Kevin Harris" not "Kevin Hardy"; "Partner" not "Founding Partner"; no process notes in user-facing copy.

Sweep digest (all 6 sources):
${JSON.stringify(sources, null, 2)}

Optional "Send to Claude" payload from Roger (apply these as drops/updates):
${args?.payload_done ? JSON.stringify(args.payload_done, null, 2) : '(args.payload_done not supplied — but ALSO check the whatsapp-self-chat sweep output: any delta whose what field begins with "PAYLOAD:" is an auto-detected Send-to-Claude submission from the dashboard. Parse the markdown body, extract Items marked done / New tasks added / Inbox marked handled / Tip feedback / North Star changes sections, apply each. Roger\'s standing instruction 5 Jun 2026: payloads in self-chat are AUTO-PROCESSED — no manual paste needed from him.)'}

WhatsApp MCP health check:
${JSON.stringify(preflight, null, 2)}
${WHATSAPP_HEALTHY ? '' : '⚠ Disclose the WhatsApp staleness in the footer_audit — Roger needs to see when his sweeps are partial.'}

## NEW v0.3 sections — important_people_owed + roger_bottlenecks

### important_people_owed

Cross-reference the Gmail + WhatsApp sweep deltas against Roger's Notion People DB
(${NOTION_IDS.people_db}) to surface PEOPLE WHO HAVE SENT SOMETHING ROGER HAS NOT RESPONDED TO.

The People DB does NOT yet have an explicit "Important" field. Use this proxy
until one is added:
1. People tagged with Relationship Type ∈ {Portfolio, Investor, Advisor} are
   important by default.
2. People who appear in Active Goals (${NOTION_IDS.active_goals}) or in current
   project relations are important.
3. People who have a Last Interaction within the last 30 days are likely active
   relationships — these are weighted higher.
4. SERVICE_PROVIDER and stale (Last Interaction > 90 days) people are NOT
   important by default, unless they're escalating.

For each important person with unanswered inbound (Gmail thread where Roger
hasn't sent the latest message, or WhatsApp where Roger hasn't replied):
- Pull their Name, Role/Organisation from the People DB
- Note when they last contacted Roger and through which channel
- Compute days_owed = now − last_inbound_time

Sort by days_owed descending. Cap at 8 entries (the top 8 longest-overdue
important-people responses). If fewer than 8 exist, that's fine.

### roger_bottlenecks

A bottleneck is something where MULTIPLE DOWNSTREAM PEOPLE/PROCESSES are
waiting on Roger to do one specific thing — sign, pay, review, decide,
respond.

Source the candidates from:
- The 4 Notion bucket pages (Signatures: ${NOTION_IDS.bucket_signatures},
  Payments: ${NOTION_IDS.bucket_payments}, Reviews: ${NOTION_IDS.bucket_reviews},
  Respond: ${NOTION_IDS.bucket_respond}) — fetch their Open sections via
  mcp__7cf2ebb5...__notion-fetch.
- The existing Bottlenecks page (${NOTION_IDS.bottlenecks_page}) for entries
  already noted there.
- This sweep's deltas where status=action_owed or time_pressured.

For each candidate, check the North Star spine (${NOTION_IDS.north_stars_db})
and current project lists to ground:
- Which NS does this serve?
- What project does it sit in?
- What's the downstream cost — what stops if Roger keeps not doing this?

Sort by downstream_cost severity (catastrophic > significant > moderate >
minor), then by days_blocked. Cap at 5 entries — anything beyond 5 is noise.

These two sections will render as a dedicated band ABOVE the FP grid on the
dashboard. The synthesize phase produces them; the apply phase materialises
them.

## Standard patch fields (kicker, subtitle, lede_h2, etc.)

Return a structured patch matching the schema. The patch must specify:
- The new kicker, subtitle, lede_h2, pullquote, footer_audit lines (these are 4 of the 9 timestamp anchors — they'll be rendered with the current SAST clock in Phase 4).
- fp_cards_add: NEW cards from this sweep (substance: from the deltas array; urgency: from the status field)
- fp_cards_drop: card IDs to remove (from payload_done if supplied, plus any whose underlying thread the sweep verified as closed)
- fp_cards_update_meta: meta-line updates for cards being carried forward (typically Day-N increments)
- ns_card_updates: NS card body + NBA refresh for any NS whose state changed
- version_string + slot_label: derive from current SAST clock — increment minor version from current.html's existing version
${CONTEXT}`

const patch = await agent(synthPrompt, {
  label: 'synthesize',
  phase: 'Synthesize',
  schema: PATCH_SCHEMA,
})

log(`Patch synthesized: ${patch.fp_cards_add?.length || 0} new FP cards, ${patch.fp_cards_drop?.length || 0} dropped, ${patch.ns_card_updates?.length || 0} NS updates.`)

// ── Phase 2.5: Chief of Staff ──────────────────────────────────────────────
// Roger's call (4 Jun 2026): the dashboard had become a laundry list.
// The CoS sits above the synthesize patch and decides what actually surfaces
// at the TOP of the dashboard. Hard constraints:
//   - NS spine: 3 lines per star, no more (status + current focus + next move)
//   - Top-N today: variable N, calibrated to ~75% completion confidence
//     given today's calendar density. Plus revealed-preference learning —
//     items repeatedly ignored get demoted.
//   - At most one question per fire — using the bundled framing pattern
//     (meta-priority Q first, drill-down via Roger's answer). Sent to
//     WhatsApp self-chat. Inbound answer parsed by next fire's sweep.
//   - Two-layer memory: specific decisions log (append-only) + generalised
//     rules (extracted weekly by a meta-agent).
//
// See ${NOTION_IDS.cos_design} for the canonical design.

phase('ChiefOfStaff')

const COS_SCHEMA = {
  type: 'object',
  properties: {
    ns_spine: {
      type: 'array',
      description: '7 entries, one per North Star. Hard cap of 3 lines per star — keeps the dashboard glanceable.',
      items: {
        type: 'object',
        properties: {
          ns: { type: 'string', enum: ['family', 'matterhorn', 'chronos', 'spock', 'portfolio', 'inner-life', 'flywheel'] },
          status: { type: 'string', enum: ['on-track', 'drifting', 'at-risk'] },
          current_focus: { type: 'string', description: 'one line — what the principal frame is doing this season' },
          next_move: { type: 'string', description: 'one line — the next specific action that moves this NS forward' },
        },
        required: ['ns', 'status', 'current_focus', 'next_move'],
      },
    },
    do_this_now: {
      type: 'array',
      description: 'The balanced action list for today. NO artificial item cap (Roger\'s explicit instruction 5 Jun 2026 — "limited to an artificial three or five items is not going to work"). Length is driven by the TIME BUDGET below: fill in priority order until committed effort lightly exceeds remaining work time (load_ratio ~1.1–1.25). A slightly-longer-than-completable list is desired; a count-capped list is not.',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number' },
          action: { type: 'string', description: 'one line, imperative voice — "Reply Willem Els on FinDev confirm"' },
          ns: { type: 'string', enum: ['family', 'matterhorn', 'chronos', 'spock', 'portfolio', 'inner-life', 'flywheel'] },
          effort_min: { type: 'number', description: 'estimated minutes of focused work (small ≤15, medium ≤45, large ≥60)' },
          importance: { type: 'number', description: '1–3, from the People-Importance layer / project priority / consequence-if-skipped. 3 = highest.' },
          deadline_today: { type: 'boolean', description: 'true if this item has a hard same-day deadline or blocks something time-critical today' },
          why_now: { type: 'string', description: 'one line — why this specific item earns a slot today given the time budget' },
          rule_applied: { type: 'string', description: 'rule_id if a generalised rule fired, else null' },
        },
        required: ['rank', 'action', 'ns', 'effort_min', 'importance', 'deadline_today', 'why_now'],
      },
    },
    time_budget: {
      type: 'object',
      description: 'The day-shape calculation that SIZES the list. Compute it explicitly — do not eyeball a number.',
      properties: {
        now_sast: { type: 'string', description: 'current time HH:MM SAST at fire (query TZ=Africa/Johannesburg)' },
        productive_end_sast: { type: 'string', description: 'when Roger\'s focused work day realistically winds down (default ~18:00 SAST; later only if calendar/evening items justify it)' },
        remaining_meetings_min: { type: 'number', description: 'sum of minutes of meetings/commitments still AHEAD of now_sast today' },
        remaining_work_min: { type: 'number', description: '(productive_end − now) − remaining_meetings_min. The focused minutes Roger actually has left today. Can be small on a heavy afternoon.' },
      },
      required: ['now_sast', 'productive_end_sast', 'remaining_meetings_min', 'remaining_work_min'],
    },
    committed_effort_min: {
      type: 'number',
      description: 'Sum of effort_min across do_this_now. Should land at ~1.1–1.25× remaining_work_min — a touch over capacity, never a hard count.',
    },
    load_ratio: {
      type: 'number',
      description: 'committed_effort_min / remaining_work_min. Target 1.1–1.25. If <1.0 the list is too thin; if >1.4 it is overwhelming — re-balance.',
    },
    target_n: {
      type: 'number',
      description: 'do_this_now.length — a REPORTED OUTCOME of the time-budget fill, not a target you choose up front.',
    },
    calendar_density: {
      type: 'string',
      enum: ['light', 'medium', 'heavy'],
      description: 'How packed the REMAINDER of today is. Informs remaining_work_min; does not cap the list directly.',
    },
    cos_question: {
      type: 'object',
      description: 'At most ONE question per fire, only if uncertainty is high AND consequence is high. Use the bundled framing (meta-priority first, drill-down via Roger\'s answer).',
      properties: {
        q_id: { type: 'string', description: 'e.g. "Q-13" — must increment from the highest q_id in the decisions log' },
        topic: { type: 'string', description: 'short topic line' },
        situation: { type: 'string', description: '2 lines max — recent context grounding the question' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2-3 concrete options Roger can pick from. Last option should be "other / explain" for open answers.',
        },
        send_to_whatsapp: { type: 'boolean', description: 'true if this should fire as a WhatsApp message to roger_self_chat NOW' },
      },
      required: ['q_id', 'topic', 'situation', 'options', 'send_to_whatsapp'],
    },
    demotions: {
      type: 'array',
      description: 'FP cards or carry-forward items that REVEALED-PREFERENCE data suggests Roger doesn\'t actually want surfaced (appeared in top-N for 3+ fires without being marked done).',
      items: {
        type: 'object',
        properties: {
          card_id: { type: 'string' },
          reason: { type: 'string', description: 'one line — why we\'re demoting' },
          fires_ignored: { type: 'number' },
        },
        required: ['card_id', 'reason'],
      },
    },
    rules_applied_this_fire: {
      type: 'array',
      items: { type: 'string' },
      description: 'rule_ids of generalised rules that fired this run. Used to populate the apply phase\'s "rule trace" so Roger can audit.',
    },
    alabama_actions: {
      type: 'array',
      description: 'Alabama-first sweep output. ONE entry per actionable WhatsApp message from Elca (alias Alabama, number 27721818934) since the previous fire. Emit even if empty (i.e. []). Every entry here also appears in do_this_now at rank 0 and in patch.fp_cards_add as a .card.fire — this array is the SOURCE OF TRUTH for the #alabama-band render in the apply phase.',
      items: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'WhatsApp message id for traceability' },
          message_text: { type: 'string', description: 'Verbatim message text from Elca — render as she wrote it' },
          received_at_sast: { type: 'string', description: 'HH:MM SAST when she sent it' },
          detected_action: { type: 'string', description: 'one line — the action distilled, e.g. "Phone Louisa"' },
          trigger_keywords: { type: 'array', items: { type: 'string' }, description: 'which detection rule(s) matched (keyword names or "imperative-verb-start")' },
        },
        required: ['message_text', 'received_at_sast', 'detected_action'],
      },
    },
  },
  required: ['ns_spine', 'do_this_now', 'time_budget', 'committed_effort_min', 'load_ratio', 'target_n', 'calendar_density', 'demotions', 'rules_applied_this_fire'],
}

const cosPrompt = `You are Roger's Chief of Staff. The dashboard has become a laundry list — your job is to fix that by deciding what actually surfaces at the top.

You read the following inputs:
1. Sweep deltas (today's inbound across 6 sources)
2. The synthesize patch produced this fire
3. North Stars database: ${NOTION_IDS.north_stars_db}
4. Projects database (filter to Project Status = Active): ${NOTION_IDS.projects_db}
5. Roger's private People-Importance Layer: ${NOTION_IDS.cos_importance_db} (his PRIVATE rating; do not consult the shared People DB for importance, only for facts)
6. Four bucket pages: Signatures (${NOTION_IDS.bucket_signatures}), Payments (${NOTION_IDS.bucket_payments}), Reviews (${NOTION_IDS.bucket_reviews}), Respond (${NOTION_IDS.bucket_respond})
7. Specific Decisions log: ${NOTION_IDS.cos_decisions_log} (every past Q&A Roger has answered)
8. Generalised Rules: ${NOTION_IDS.cos_generalised_rules} (rules extracted from the decisions log; apply rules with status="active" and high confidence)
9. Today's calendar (via mcp__70bd15a3-8278-4771-b9a6-8282063bf947__list_events)
10. Yesterday's dashboard state (what was in top-N, what got done vs ignored)

You produce:

## ⚠ ALABAMA-FIRST PASS (must run BEFORE NS spine / do_this_now construction)
${ALABAMA.person} (alias "${ALABAMA.whatsapp_alias}" on WhatsApp, number ${ALABAMA.whatsapp_number}) is Roger's wife. The rule **${ALABAMA.rule_id}** (status=active, supreme) overrides every other rule including: ${ALABAMA.overrides.join(', ')}.

Before constructing ns_spine and do_this_now, do this:

1. Query mcp__whatsapp__list_messages with sender = ${ALABAMA.whatsapp_number} OR the direct-chat-by-contact for that number, since the previous fire's timestamp. Get every message Roger has not yet ticked done.

2. For each message, run action-shape detection:
   • Contains any of these keywords (case-insensitive): ${ALABAMA.action_keywords.join(', ')}
   • Starts with an imperative verb (sentence-initial, case-insensitive): ${ALABAMA.imperative_verbs_sentence_start.join(', ')}
   • Mentions a name + a verb (e.g. "Phone Louisa", "tell Markus") even without an action keyword
   If ANY of these match, treat as an Alabama action.

3. For each Alabama action message:
   • Inject into cos.do_this_now at rank=0, importance=3, deadline_today=true, ns="family", rule_applied="${ALABAMA.rule_id}".
   • Add a parallel item to patch.fp_cards_add as a .card.fire with data-north-star="family" and data-action-url="${ALABAMA.whatsapp_deeplink}".
   • Carry the original WhatsApp message text verbatim so Roger sees her exact words.
   • Add to cos.alabama_actions array (new field — emit even if empty).

4. If Alabama sent NO new actionable messages this fire:
   • cos.alabama_actions = []
   • The apply phase will render "No new action messages from Alabama since last fire" in the band.

5. Alabama action items are IMMUNE to:
   • revealed-preference 3-strike-ask (they don't accrue ignore-strikes)
   • time_budget cap (they're always-include overrides)
   • load_ratio cap (committed_effort_min sum can exceed 1.25× for Alabama items)
   • demotions (never demote an Alabama action; if Roger ignores, raise a cos_question explicitly asking but never auto-demote)

## NS spine
7 entries, one per North Star. HARD CAP: status + 1-line current focus + 1-line next move. Total 3 lines per star. No essay bodies.

## do_this_now (TIME-BUDGETED, not count-capped)
Roger's explicit instruction (5 Jun 2026): "Look at what today looks like, how much time I've got, what the time is now, how much work time I've got left in today, what the workload is of every one of those tasks, how important they are, and then create a balanced list. I am happy the list is a little bit longer than is realistically possible to get through, but limiting to an artificial three or five items is not going to work."

So DO NOT pick a number. Build the list from the day's shape, in four steps:

1. **Size the day (time_budget).** Query now in SAST (TZ=Africa/Johannesburg). Set productive_end ≈ 18:00 SAST (later only if calendar/evening commitments clearly justify it). Sum the minutes of meetings/commitments still AHEAD of now. remaining_work_min = (productive_end − now) − remaining_meetings_min. On a heavy late afternoon this may be 60–90 min; on a clear morning it may be 5+ hours. This number sizes the list — not a fixed N.

2. **Score every candidate** on importance (1–3 from the People-Importance layer / active-project priority / cascade-consequence) and urgency (deadline_today, blocks-others, decaying-warmth). Estimate effort_min per candidate (small ≤15 / medium ≤45 / large ≥60).

3. **Fill in priority order** (importance × urgency, deadline_today first) accumulating effort_min until committed_effort_min reaches ~1.1–1.25× remaining_work_min — i.e. a list that is intentionally a touch longer than Roger can realistically finish, so he always has the next-best thing teed up, but never an overwhelming wall. Compute load_ratio and sanity-check it sits in 1.1–1.25 (re-balance if <1.0 or >1.4).

4. **Always-include overrides** (these bypass the budget): same-day family items (Importance-3 family per rule-importance-3-family-same-day), money decisions that need Roger, and signatures with a deadline TODAY (rule-signatures-deadline-driven). Matterhorn training items appear ONLY on scheduled training days (rule-matterhorn-scheduled-days-only).

REVEALED-PREFERENCE RULE: if a card has been surfaced ≥3 consecutive fires without being marked done, DON'T silently drop it — add it to demotions with fires_ignored, and (per rule-revealed-preference-3-strike-ask) raise a cos_question proposing the demotion before it disappears. Don't surface stale items unchanged — that's the laundry-list trap Roger is reacting to.

Use the importance layer + active projects + buckets to ground priority. People with Importance 3 trump everyone else. Items in active projects beat orphan items. Bucket items where consequences cascade (multiple people blocked) beat solo items.

## cos_question (at most one)
A 2×2:
                    | Low uncertainty | High uncertainty
High consequence    | Act, mention    | ASK
Low consequence     | Act silently    | Pick default, log for review

Only ask when: high uncertainty + high consequence. Default: do NOT ask (this is Roger's stated preference — quality of questions over quantity).

If you ask:
- q_id = "Q-{N}" where N = highest q_id in cos_decisions_log + 1
- Use the bundled framing pattern (Q6c from Roger's design): one meta-priority question that drills down based on the answer. NOT three parallel questions.
- Set send_to_whatsapp=true; the apply phase will fire mcp__whatsapp__send_message to ${NOTION_IDS.roger_self_chat}.

## rules_applied_this_fire
For each generalised rule (status="active") whose trigger_shape matches a candidate today, list the rule_id. The apply phase will note these in the dashboard footer so Roger can audit which rules are firing.

## demotions
Per the revealed-preference rule above.

## FABRICATION BLOCKLIST — DO NOT regenerate these items
Roger's standing kill-list of items the CoS has fabricated in past fires. If your candidate list contains any item matching one of these blocklist entries by id OR by title-substring, OMIT it from do_this_now and OMIT it from any FP card proposal. The apply phase will also filter (defense in depth) but the right behaviour is to not generate them in the first place. Append-only registry:

${FABRICATION_BLOCKLIST.map(b => '• id="' + b.id + '" · title substrings: ' + JSON.stringify(b.title_substrings) + '\n  reason: ' + b.reason).join('\n')}

If you encounter input data (sweep deltas, decisions log entries, even prior current.html state) that mentions one of these items, treat it as STALE NOISE and do not propagate. The recurrence pattern is: a sweep echo re-introduces the item → CoS treats it as new → Roger has to delete it again. Break the loop here.

Sweep digest:
${JSON.stringify(sources, null, 2).slice(0, 4000)}...

Synthesize patch:
${JSON.stringify(patch, null, 2).slice(0, 4000)}...

Return the structured output. Stay disciplined: NS spine 3 lines per star, do_this_now sized by the TIME BUDGET (load_ratio 1.1–1.25, NO artificial item cap), at most one question, demote stale items via the ask-first rule.

${CONTEXT}`

const cos = await agent(cosPrompt, {
  label: 'chief-of-staff',
  phase: 'ChiefOfStaff',
  schema: COS_SCHEMA,
})

log(`CoS produced: ${cos.do_this_now?.length || 0} actions · ${cos.committed_effort_min}min committed / ${cos.time_budget?.remaining_work_min}min available (load ${cos.load_ratio}) · density=${cos.calendar_density} · question=${cos.cos_question ? cos.cos_question.q_id : 'none'} · demotions=${cos.demotions?.length || 0} · rules=${cos.rules_applied_this_fire?.length || 0}`)

// ── Phase 3: Rotate the Claude Tip of the Day ─────────────────────────────

phase('RotateTip')

const TIP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    feature: { type: 'string' },
    title: { type: 'string' },
    summary_meta: { type: 'string', description: 'e.g. "#4 · Evaluate next month · click to expand"' },
    hook: { type: 'string' },
    what_it_does: { type: 'string' },
    why_high_leverage: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    steps_html: { type: 'string', description: 'HTML for the steps block — typically "<strong>Try it...</strong><br>1.&nbsp; ..."' },
    tiein: { type: 'string', description: '"↳ ..." closing connection line' },
    source_url: { type: 'string' },
    prior_tip_id_to_close: { type: 'string', description: 'the previous tip id; rotate-tip.py will mark its status appropriately' },
  },
  required: ['id', 'feature', 'title', 'summary_meta', 'hook', 'what_it_does',
             'why_high_leverage', 'tags', 'steps_html', 'tiein', 'source_url'],
}

const tipPrompt = `Rotate the Claude Tip of the Day on the dashboard.

The current tip is in ${PROJECT_LEDGER_DIR}/current.html as the
<details class="tip-block"> block — read its data-tip-id to know which tip
is currently shown.

Step 1: Query the Notion "🎓 Claude Tips Backlog" data source (collection id
114727aa-c905-40fc-9d5b-c76342f93189) for the next unticked entry. Use
mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-search. Filter by
Status = "Backlog" and ID != current. Sort by Priority ascending.

Step 2: Fetch its content via mcp__...__notion-fetch.

Step 3: Read ~/.project_ledger/tip-history.json if it exists; pick a tip whose
id is not in shown[] or current.

Step 4: Render the tip's properties into the schema below. The summary_meta
should follow the pattern "#N · <Band> · click to expand" where N is the
position in the rotation (you'll need to count shown tips +1).

If the backlog is exhausted (everything Status != "Backlog"), pick the first
"Backlog" entry regardless of repeat — and clear shown[] in the history file
to acknowledge the cycle.

If you can't reach Notion at all, return id="" and feature="" and the rest
empty — the Apply phase will detect this and skip the tip rotation rather
than break the build.

${CONTEXT}`

const tip = await agent(tipPrompt, {
  label: 'rotate-tip',
  phase: 'RotateTip',
  schema: TIP_SCHEMA,
})

const tipRotated = !!(tip && tip.id)
log(tipRotated
    ? `Tip rotated to: ${tip.feature} (${tip.id})`
    : `Tip rotation skipped (Notion unavailable or backlog exhausted).`)

// ── Phase 4: Apply the patch ──────────────────────────────────────────────

phase('Apply')

const applyPrompt = `Apply the structured patch to ${PROJECT_LEDGER_DIR}/current.html.

Patch:
${JSON.stringify(patch, null, 2)}

Chief of Staff output (THIS DRIVES THE TOP-OF-DASHBOARD REDESIGN):
${JSON.stringify(cos, null, 2)}

${tipRotated ? `New tip block to insert (rewrite the existing <details class="tip-block">):
${JSON.stringify(tip, null, 2)}` : '(Tip rotation skipped — leave the existing tip block alone.)'}

⚠️ HARD RULE — THE JAVASCRIPT IS FROZEN. You must NEVER hand-edit anything between a \`<script>\` and \`</script>\` tag. All dashboard interactivity (toggleDone, toggleComment, saveComment, sendToClaude, the NS spine, drag/drop, the payload modal) lives there and is identical every fire. A single stray character there silently kills every button (this is the v1.34 regression that broke the dashboard for 24h). You only ever edit HTML content and CSS.

Steps:

0. **Restore the frozen JS FIRST (self-heal):** run this EXACT command (the $HOME form matters — node does not expand ~):
   \`node ${PLUGIN_SCRIPTS_SH}/inject-core.mjs ${CURRENT_HTML_SH}\`
   This overwrites all four inline <script> blocks with the canonical, gate-passing copy in templates/dashboard-core.json — so even if current.html inherited a corrupted block, the page starts from known-good JS. Do this before any other edit.

1. Read current.html (now with healed JS).

2. Apply fp_cards_drop (from patch) + cos.demotions: remove each card by data-id.

3. Apply fp_cards_update_meta: replace .card-meta line for each id.

4. Apply fp_cards_add: insert new cards at top of priority-grid (fire cards above non-fire). Set data-first-seen to today's UTC date.

5. Apply ns_card_updates: rewrite each NS card's body + NBA. ⚠ ENFORCE THE 3-LINE LIMIT — if a body or NBA exceeds 3 lines, COMPRESS IT before writing. Roger's call: NS cards must be glanceable.

6. **CoS output rendering — v0.7, TAB-AWARE (Roger 6 Jun 2026 — v1.46 baseline):**

   ⚠ STRUCTURAL FREEZE: as of v1.46 the dashboard uses an 8-tab layout. The tab-bar (#tab-bar) and the 8 tab-panels are PERMANENT and you must not add, remove, rename, or reorder them. The 8 tabs in fixed order:
     ${STRUCTURAL_BASELINE.tabs.map(t => '• ' + t.label + ' → div#' + t.panel + (t.count_id ? ' (badge #' + t.count_id + ': ' + t.counted + ')' : ' (' + t.counted + ')')).join('\n     ')}

   ⚠ RETIRED LEGACY ELEMENTS — if current.html still contains these at the TOP (outside any tab-panel), DELETE the entire <div class="cos-band"> block for each:
     ${STRUCTURAL_BASELINE.retired_legacy_ids.map(id => '• div#' + id + ' — REMOVE if present').join('\n     ')}
     Reason: ${STRUCTURAL_BASELINE.retired_reason}
     The 06:30 06-Jun fire recreated #ns-spine-band and #do-this-now-band because the v0.6 apply prompt told it to. v0.7 retires both. If you find them at the top of current.html, strip them in a single regex pass before doing anything else, then continue with the tab-aware render below.

   ⚠ FABRICATION BLOCKLIST — Roger's standing kill-list. Before rendering, FILTER both cos.do_this_now and patch.fp_cards_add through the blocklist below. Any item whose data-id OR action text matches a blocklist entry must be dropped, NOT rendered, NOT added — and you must append one line to the footer audit naming the blocked entry + the trigger ("blocklist hit: dtn-11 — Rich Shapiro/Joshua car-storage").
     Blocklist (append-only):
     ${FABRICATION_BLOCKLIST.map(b => '• id="' + b.id + '" · titles match any of: ' + JSON.stringify(b.title_substrings) + ' · reason: ' + b.reason).join('\n     ')}

   --- ⚠ ALABAMA RENDERING — FOLDED INTO EXISTING COMPONENTS (Roger 7 Jun) ---
   The dedicated #alabama-band has been RETIRED (v1.53). Roger's call: "perform the Alabama priorities within the other infrastructure we built. Not as its own block." The supreme-priority enforcement is unchanged at the logic layer — only the visual changes.

   ⚠ DELETE-IF-PRESENT: if current.html contains <div class="alabama-band" id="alabama-band">, REMOVE the entire div block. Do not regenerate it under any circumstances. Same for the .alabama-band / .alabama-head / .alabama-action / .alabama-promise CSS rules.

   For EACH item in cos.alabama_actions, render it on the existing components with a SUBTLE marker:

   1. ⚡ Do This Now (existing #do-this-now-list):
      Insert at the TOP of the list as a normal li.dtn-item with TWO additions:
      • Add class "from-alabama" to the li
      • Prepend a heart marker INSIDE the .dtn-title: <span class="alabama-mark">♥</span>
      Resulting structure:
        <li class="dtn-item from-alabama" data-id="dtn-alabama-{shortid}" data-title="{detected_action}" data-north-star="family">
          <div class="dtn-row">
            <div class="dtn-tick tick" onclick="toggleDone(this)"></div>
            <div class="dtn-body">
              <div class="dtn-title"><span class="alabama-mark">♥</span>{detected_action} <span class="effort">· 5 min · family</span></div>
              <div class="why-now">from Alabama · {received_at_sast} SAST — "{first 70 chars of message_text}"</div>
            </div>
            <button class="comment-toggle dtn-comment-btn" onclick="toggleComment(this)">Add note</button>
          </div>
          <div class="comment-box dtn-comment-box"><textarea class="comment-input" placeholder="Note for Claude…" oninput="saveComment(this)"></textarea></div>
        </li>

   2. 🔥 Front Page (existing #priority-grid):
      Insert at the TOP of the grid as a normal div.card.fire WITH two additions:
      • Add class "from-alabama" to the card (gives accent left edge via CSS)
      • Prepend ♥ marker INSIDE .card-title
      Resulting structure:
        <div class="card fire from-alabama" data-id="fp-alabama-{shortid}" data-title="{detected_action}" data-action-url="${ALABAMA.whatsapp_deeplink}" data-north-star="family" data-first-seen="{today UTC date}">
          <div class="card-head"><div class="card-title"><span class="alabama-mark">♥</span>{detected_action}</div><span class="ns-tag" title="Serves: Family">Family</span></div>
          <div class="card-meta">from Alabama · {received_at_sast} SAST</div>
          <div class="card-body">"{message_text verbatim}"</div>
          <div class="card-controls"><div class="tick" onclick="toggleDone(this)"></div><span class="control-label">Mark done</span><a class="work-btn" href="${ALABAMA.whatsapp_deeplink}" target="_blank" onclick="workOnThis(event, this)">→ WhatsApp Alabama</a><button class="comment-toggle" onclick="toggleComment(this)">Add note</button></div>
          <div class="comment-box"><textarea class="comment-input" placeholder="Note for Claude…" oninput="saveComment(this)"></textarea></div>
        </div>

   3. 📨 People & Bottlenecks signal-band (#signal-people-list, inside the people tab):
      Insert at the TOP of the signal-people-list as a normal li.signal-item WITH:
      • class "from-alabama" added
      • ♥ prepended to the body line
      Resulting structure:
        <li class="signal-item from-alabama" data-id="ppl-alabama-{shortid}" data-title="{detected_action}" data-north-star="family">
          <div class="si-body"><span class="alabama-mark">♥</span>Alabama · 0d · {detected_action}</div>
        </li>

   IF cos.alabama_actions IS EMPTY:
     Do nothing. Render nothing. Silent = absent — no "no actions from Alabama" reminder noise on the dashboard. The sweep still ran and the rule still fired; it just had no actions to surface this fire.

   IF EXISTING ALABAMA ITEMS FROM PREVIOUS FIRE ARE NOT TICKED:
     Carry them forward unchanged (do NOT auto-demote — rule-alabama-supreme-priority makes them immune). They keep the from-alabama class and ♥ marker.

   COUNT IMPLICATIONS: the tab badges (count-do-this-now, count-people) should include Alabama items in their counts — they're regular dtn-items / signal-items, just with one extra class and one extra span.

   --- TAB-BY-TAB RENDER (v1.69 — Do This Now retired; Front Page is the only action surface) ---

   ⚠ NO LONGER A SEPARATE DO-THIS-NOW TAB. Roger 15 Jun: "The Do This Now tab has big overlaps with Front Page. And when I mark things as done, it is not done on the Front Page." Retired entirely. CoS rank is now expressed THROUGH the Front Page cards (via .fire class + .card-whynow line), not as a separate panel. If you find any tab-do-this-now button or panel-do-this-now panel or do-this-now-list ol or count-do-this-now span in current.html, REMOVE them on sight.

   🔥 Front Page → div#priority-grid inside div#panel-front-page (THIS IS THE PRIMARY SURFACE):

   For each cos.do_this_now item (AFTER blocklist filter), order by rank, then:
     1. Try to find an existing FP card whose data-title matches the action OR whose data-id matches a stable id pattern.
     2. If MATCHED — escalate that card:
        a. Add class "fire" if not already present (className: "card fire ...others")
        b. Add a <div class="card-whynow">🔥 Why now: {item.why_now}</div> as the FIRST child after .card-head (overwrite any existing .card-whynow line). Period at end.
        c. If item.is_alabama OR data-north-star="family" with Alabama trigger → also add "from-alabama" class and prepend <span class="alabama-mark">♥</span> to the .card-title.
        d. Move the escalated card to the top of #priority-grid (preserve order of escalations by rank).
     3. If NOT MATCHED — create a NEW card.fire at the top of #priority-grid using the same structure (card-head with title + ns-tag, card-whynow with reason, card-meta with effort_min, card-body with verbatim message context or "Carried from CoS rank N", card-controls with tick + work-btn + comment-toggle, comment-box).

   patch.fp_cards_add (AFTER blocklist filter): insert as <div class="card fire" ...> blocks at the top. Set data-first-seen to today's UTC date.
   patch.fp_cards_drop + cos.demotions: remove matching <div class="card" data-id="..."> blocks.
   patch.fp_cards_update_meta: replace .card-meta line for each id.

   ⚠ EVERY FIRE CARD MUST HAVE A .card-whynow LINE. That is the CoS reasoning made visible (Roger 15 Jun: "this is fire because Stephen needs the credit list by EOD" is more useful than just a red border). Style: italic accent color, accent-left border. CSS already in current.html. Format: "🔥 Why now: {single sentence ending in period}."

   ⚠ TIME-BUDGET CHIP — populate #fp-budget at top of #priority-grid:
     - Update <strong id="fp-budget-cards">N</strong> with N = count of .card.fire elements in #priority-grid after all rendering.
     - Update <span class="fp-budget-text" id="fp-budget-text">...</span> with: "{cos.do_this_now.length} CoS-prioritised · ~{cos.committed_effort_min} min committed vs {cos.time_budget.remaining_work_min} min focus left today · {calendar_density} calendar"
     - Do not delete the chip — populate it every fire.

   DO NOT collapse #priority-grid behind <details class="everything-else">. The FP grid is THE primary surface, visible by default on page load.

   ⭐ North Stars → div#panel-north-stars only:
   - Render cos.ns_spine into the spine-rows container INSIDE #panel-north-stars (look for div#ns-spine-rows or equivalent; if missing, create one inside #panel-north-stars). Hard cap 3 lines per star.
   - Apply patch.ns_card_updates to the per-NS card bodies inside #panel-north-stars (each NS card has its own data-ns="family" / "chronos" / etc.).
   - DO NOT render cos.ns_spine at the top of the dashboard. If you find any <div class="cos-band" id="ns-spine-band"> at the top, DELETE it (see retired-legacy rule above).

   👤 Isa / 📨 People & Bottlenecks / 🗂 Everything else / ✅ Done:
   - You do not regenerate these tabs from the patch. They are carried forward fire-to-fire and only mutate via Send-to-Claude payloads. Touch them ONLY to update the tab badge counts:
     • count-isa = number of open .row inside #panel-isa that are not class="done"
     • count-people = number of .signal-item inside #panel-people
     • count-done = number of .row inside #panel-done

   🎯 Deep Work → div#panel-deep-work:
   - Static list curated by Roger. Do not modify unless the patch explicitly contains a deep_work_change. Just count and badge.

   --- ABOVE-THE-TABS (GLOBAL) ---

   ❓ Question band → div#cos-question-band (this sits ABOVE the tab-bar; it is NOT in any tab-panel):
   - If cos.cos_question exists: populate #cos-q-topic, #cos-q-situation, #cos-q-options (as <button class="q-option">{opt}</button>); set the band style="display:block".
   - If cos.cos_question is null: set style="display:none".

   📡 Signal band → div#signal-band (also above the tab-bar; kept per Roger 5 Jun — important people + bottlenecks). Update the inner lists from this fire's deltas; do not duplicate into the People tab.

   --- WHAT YOU MUST NOT DO ---
   - DO NOT create div#ns-spine-band anywhere — retired.
   - DO NOT create div#do-this-now-band anywhere — retired.
   - DO NOT add/remove/reorder tabs in #tab-bar.
   - DO NOT wrap #priority-grid in <details class="everything-else">.
   - DO NOT touch any <script> blocks (frozen — handled by Step 0's inject-core.mjs).
   - DO NOT rebuild the document from scratch. Always edit in place against the existing v1.46+ structure.

7. ${tipRotated ? 'Rewrite the tip block using rotate-tip.py (pipe the tip JSON to its stdin).' : 'Skip tip block.'}

8. Bump ALL timestamp anchors with TZ='Africa/Johannesburg' date queried NOW (re-query IMMEDIATELY before the snapshot, not at agent-start). Anchors that still exist after the 5–15 Jun cleanups:
   (1) kicker time-of-day phrase (use patch.kicker; includes slot label)
   (2) subtitle "Compiled HH:MM SAST..." (prepend time to patch.subtitle)
   (3) dateline-edition slot
   (4) ns-last-calibrated
   (5) footer-text Compiled line
   (6) pullquote opening clock
   (7) ⚠ NEW v1.69 — <body data-compiled-at="..."> attribute. Set to the current SAST instant in ISO format with timezone, e.g. data-compiled-at="2026-06-15T10:18:19+02:00". This powers the stale-data banner JS; without it the banner never shows even when the page is days old. Use the same Bash query for SAST as the other anchors.
   (Anchors REMOVED 5 Jun by Roger: inbox-strip-hed [section deleted], old lede h2 [section deleted], old day-card week-banner [in collapsed Everything Else but unused].)

9. **WhatsApp Q&A loop — send the CoS question if any:**
   If cos.cos_question?.send_to_whatsapp is true, call mcp__whatsapp__send_message to ${NOTION_IDS.roger_self_chat} with this message body:
   "🤔 ${cos.cos_question?.q_id || 'Q-?'} · ${cos.cos_question?.topic || ''}\\n${cos.cos_question?.situation || ''}\\n\\n${(cos.cos_question?.options || []).map((opt, i) => '(' + String.fromCharCode(97 + i) + ') ' + opt).join('\\n')}\\n\\nReply 'a' / 'b' / 'c {your thoughts}'."
   Also append a new entry to the Specific Decisions Notion page (${NOTION_IDS.cos_decisions_log}) recording the question as "open, awaiting answer".

10. Verify: file size > 50KB; no "Kevin Hardy"; version string updated. Abort if any check fails.

Use the Bash tool for the publish chain (don't use cd "path\\ with\\ space" — use absolute-path variables; that pattern silently fails).

${CONTEXT}`

await agent(applyPrompt, {
  label: 'apply-patch',
  phase: 'Apply',
})

// ── Phase 4b: Verify (publish gate) ───────────────────────────────────────
// Hard gate: the JS must parse and the core handlers must exist BEFORE we touch
// the live repo. If this fails we abort the whole run — the live page keeps its
// last-good edition rather than being overwritten with a dead one. This is the
// backstop for the v1.34-class regression (a broken <script> block silently
// killing every button).

phase('Verify')

const verify = await agent(
  `Run the Ledger build gate and report the result. Use the Bash tool with this EXACT command (the $HOME form matters — node does not expand ~):

  node ${PLUGIN_SCRIPTS_SH}/verify-build.mjs ${CURRENT_HTML_SH}

Return {passed, output} where passed = (exit code 0) and output = the script's stdout+stderr verbatim. Do not fix anything; just run and report.`,
  {
    label: 'build-gate',
    phase: 'Verify',
    schema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean', description: 'true iff verify-build.mjs exited 0' },
        output: { type: 'string', description: 'verbatim stdout+stderr from the gate' },
      },
      required: ['passed', 'output'],
    },
  },
)

if (!verify.passed) {
  log(`❌ BUILD GATE FAILED — aborting before publish. Live page keeps last-good edition.\n${verify.output}`)
  throw new Error(`Ledger build gate failed; refusing to publish. Gate output:\n${verify.output}`)
}
log(`✅ Build gate passed — safe to publish. ${verify.output}`)

// ── Phase 5: Publish ──────────────────────────────────────────────────────

phase('Publish')

const publishPrompt = `Publish ${PROJECT_LEDGER_DIR}/current.html to ${SPOCK_SITE_BUILD_REPO}.

Steps (use Bash):
0. FINAL GATE (belt-and-suspenders): run \`node ${PLUGIN_SCRIPTS_SH}/verify-build.mjs ${CURRENT_HTML_SH}\` (the $HOME form matters — node does not expand ~). If it exits non-zero, STOP — do not clone, commit, or push. Print the gate output and return {aborted:true}. The live page must keep its last-good edition.
1. Re-query SAST: TZ='Africa/Johannesburg' date '+%Y-%m-%d %H:%M SAST'
2. cp current.html to a dated snapshot in the same dir.
3. Clone spock-site-build to /tmp; copy current.html to its ledger/index.html.
4. git config user.name "Roger Grobler" and email "roger@ccap.ai".
5. Commit with message: "Ledger ${patch.version_string} · <SAST> · ${patch.slot_label} · ${patch.open_items_summary}".
6. git push origin main.
7. Print the short commit hash.
8. Poll ${LIVE_URL} every 4s until it serves the new ${patch.version_string} or 180s elapse. Print "LIVE after Ns" or "TIMEOUT".

Return the commit hash + propagation time.

${CONTEXT}`

const publishResult = await agent(publishPrompt, {
  label: 'publish',
  phase: 'Publish',
})

return {
  version: patch.version_string,
  slot: patch.slot_label,
  fp_cards_added: patch.fp_cards_add?.length || 0,
  fp_cards_dropped: patch.fp_cards_drop?.length || 0,
  ns_cards_updated: patch.ns_card_updates?.length || 0,
  tip_rotated: tipRotated,
  tip_id: tip?.id || null,
  sources_swept: sources.length,
  publish_result: publishResult,
}
