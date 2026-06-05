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
const SPOCK_SITE_BUILD_REPO = 'https://github.com/rogergrobler/spock-site-build.git'
const LIVE_URL = 'https://rogergrobler.github.io/spock-site-build/ledger/'

const CONTEXT = `Roger Grobler, Partner at Chronos Capital Advisory in Stellenbosch.
The Stellenbosch Ledger is his personal dashboard, published to ${LIVE_URL}.
This workflow rebuilds it from scratch using fresh sweeps across his integrated
data sources.`

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

0. **Restore the frozen JS FIRST (self-heal):** run
   \`node ${PLUGIN_DIR}/scripts/inject-core.mjs "${PROJECT_LEDGER_DIR}/current.html"\`
   This overwrites all four inline <script> blocks with the canonical, gate-passing copy in templates/dashboard-core.json — so even if current.html inherited a corrupted block, the page starts from known-good JS. Do this before any other edit.

1. Read current.html (now with healed JS).

2. Apply fp_cards_drop (from patch) + cos.demotions: remove each card by data-id.

3. Apply fp_cards_update_meta: replace .card-meta line for each id.

4. Apply fp_cards_add: insert new cards at top of priority-grid (fire cards above non-fire). Set data-first-seen to today's UTC date.

5. Apply ns_card_updates: rewrite each NS card's body + NBA. ⚠ ENFORCE THE 3-LINE LIMIT — if a body or NBA exceeds 3 lines, COMPRESS IT before writing. Roger's call: NS cards must be glanceable.

6. **CoS output rendering — top section above the FP grid (v0.5, updated 5 Jun for interactive Do This Now):**
   - HTML scaffolding for #ns-spine-band, #do-this-now-band, #cos-question-band, .everything-else exists in current.html.
   - For each cos.ns_spine[7], write to #ns-spine-rows ONE row HTML: a div.ns-spine-row containing span.ns-tag.ns-NS NS · span.ns-status.status-STATUS STATUS · CURRENT_FOCUS arrow em NEXT_MOVE. HARD CAP 1 line per row.
   - For #do-this-now-list, render EACH cos.do_this_now item as an INTERACTIVE LI (NOT a plain li). The exact HTML pattern is in current.html as of v1.33 — read one existing dtn-item from the live file and pattern-match for the rest. Structure overview: li.dtn-item with data-id/data-title/data-north-star, containing div.dtn-row with [div.dtn-tick.tick onclick=toggleDone + div.dtn-body containing div.dtn-title with span.effort + div.why-now + button.comment-toggle.dtn-comment-btn onclick=toggleComment] AND div.comment-box.dtn-comment-box containing textarea.comment-input oninput=saveComment.
     The tick + comment + saveComment handlers already exist in the dashboard JS. Roger ticking these counts toward Send-to-Claude payload like FP cards.
   - For #cos-question-band: if cos.cos_question exists, populate #cos-q-topic, #cos-q-situation, #cos-q-options (as <button class="q-option">{opt}</button>), set band display=block. If null, set display=none.
   - DO NOT add the old inbox-strip or the old <details class="north-star"> back if they're missing — Roger explicitly removed them as non-functional. The compressed NS spine band at top REPLACES the old long NS section.
   - DO NOT touch the existing details.everything-else wrap around the FP grid + day cards + all-actions — that structure works for Roger.

7. ${tipRotated ? 'Rewrite the tip block using rotate-tip.py (pipe the tip JSON to its stdin).' : 'Skip tip block.'}

8. Bump ALL timestamp anchors with TZ='Africa/Johannesburg' date queried NOW (re-query IMMEDIATELY before the snapshot, not at agent-start). Anchors that still exist after the 5 Jun cleanup:
   (1) kicker time-of-day phrase (use patch.kicker; includes slot label)
   (2) subtitle "Compiled HH:MM SAST..." (prepend time to patch.subtitle)
   (3) dateline-edition slot
   (4) ns-last-calibrated
   (5) footer-text Compiled line
   (6) pullquote opening clock
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
  `Run the Ledger build gate and report the result. Use the Bash tool:

  node ${PLUGIN_DIR}/scripts/verify-build.mjs "${PROJECT_LEDGER_DIR}/current.html"

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
0. FINAL GATE (belt-and-suspenders): run \`node ${PLUGIN_DIR}/scripts/verify-build.mjs "${PROJECT_LEDGER_DIR}/current.html"\`. If it exits non-zero, STOP — do not clone, commit, or push. Print the gate output and return {aborted:true}. The live page must keep its last-good edition.
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
