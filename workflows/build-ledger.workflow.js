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
    { title: 'Draft replies', detail: 'post-publish — generate Gmail drafts for Tier 5/4 and Tier 3 owes_response threads in Roger\'s calibrated voice' },
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
  whatsapp_number: '919908732597',
  whatsapp_deeplink: 'https://wa.me/919908732597',
  importance_rating: '3 · Always promote',
  ns: 'family',
  action_keywords: ['action','please','call','phone','fetch','pick up','remember','tell','buy','book','sign','reply','send','drop off','collect','order','organise','organize','sort','fix','arrange'],
  imperative_verbs_sentence_start: ['phone','call','fetch','buy','tell','ask','remember','book','sign','reply','send','order','pick','drop','collect','arrange','organise','organize','sort','fix','check','confirm','do','get','make','take','bring','find','help','please'],
  rule_id: 'rule-alabama-supreme-priority',
  overrides: ['rule-revealed-preference-3-strike-ask', 'rule-irreversible-ask', 'time_budget cap', 'load_ratio cap'],
  sentinel_band_id: 'alabama-band',
}

// ── ALABAMA INTIMACY FILTER (Roger 20 Jun — Isa sees this dashboard too) ──
// Critical privacy boundary. Alabama-supremacy stands for TASKS (Phone Louisa,
// Order iPad cover, Try on suits). Emotional / relational / intimate content
// (apologies, fights, expressions of love, vulnerable check-ins, mental-health
// references) must NEVER appear on the dashboard — those exchanges live in
// WhatsApp directly between Roger and Alabama, not on a surface Isa reads.
//
// Origin 2026-06-20: v1.82 surfaced a 10:57 SAST apology message verbatim
// in a fire FP card visible to Isa. Roger flagged immediately. Stripped + this
// filter built.
const ALABAMA_INTIMACY_FILTER = {
  // Any Alabama message matching ANY of these signals is INTIMATE — suppress entirely from the dashboard.
  // Don't render the card, don't include in cos.alabama_actions, don't mention in NS spine prose, don't put in any audit footer.
  intimate_keyword_patterns: [
    // Apologies
    'sorry', 'i am sorry', "i'm sorry", 'apologise', 'apologize', 'forgive', 'i was wrong', 'my fault',
    // Fight / conflict
    'hurt', 'angry', 'frustrated', 'upset', 'disappointed', 'we need to talk', 'this is hard',
    'fight', 'argument', 'fought', 'argued', 'why did you', 'you never', 'you always',
    // Love / longing
    'i love you', 'love you', 'miss you', 'thinking of you', 'mean a lot', 'proud of you',
    'grateful', 'special', 'breaks my heart', 'broke my heart', 'heart breaks',
    // Vulnerable check-ins
    'are you ok', 'are you okay', 'you alright', 'how are you really', 'how do you feel',
    'what are you feeling', "what's going on with you", 'talk to me',
    // Mental health / state
    'taking strain', 'difficult to', 'cannot cope', "can't cope", 'overwhelmed', 'exhausted with',
    'lonely', 'anxious', 'depressed', 'struggling', 'not coping', "i'm not ok",
    // Intimacy
    'just us', 'between us', 'personal', 'private', 'intimate',
  ],
  // If a message has BOTH a task and intimate content, extract the task ONLY and render that.
  // The mixed case is the common one: "I love you, please pick up Daisy" → render "Pick up Daisy" stripped of "I love you".
  mixed_mode: 'extract_task_strip_emotional',
  // What appears on the dashboard for purely intimate exchanges?
  // NOTHING. Not a placeholder card, not a counter, not a hint. Zero surface.
  // Roger checks WhatsApp directly for intimate content. The dashboard is public-safe.
  purely_intimate_surface: 'none',
}

// ── SEED TASKS (forced candidate cards — Spock-injected, no inbound required) ──
// Roger's instruction 2026-06-20: certain follow-ups need to surface even when
// no inbound has arrived. The sweep treats these the same as a Notion Respond
// Pending entry — they get folded straight into patch.fp_cards_add candidates
// downstream, and routed through the same blocklist + dedup gates as anything
// else. Append-only; once Roger marks the underlying task done via Send-to-
// Claude payload, the FP card drops naturally and the SEED_TASKS entry can be
// retired (or left in for audit trail).
const SEED_TASKS = [
  {
    who: 'David Ryan',
    topic: 'Follow-up re Sharni Quinn (WellGuide)',
    source: 'Spock seed 2026-06-20',
    added: '2026-06-20',
  },
]

// ── ACTIVE-DEALS PRIORITY REGISTRY (Roger's standing high-priority deals) ──
// Roger's instruction 2026-06-17: keep these deals front-and-centre on every
// fire — they are the active running deals that drive the work week. Any FP
// card whose data-title or data-id contains a matching keyword gets the same
// treatment as a cos.do_this_now item: importance=3, .fire class, .card-whynow
// line under the title. Immune to revealed-preference demotion.
//
// Append-only registry — add new active deals here when they enter the active
// pipeline; retire by setting active=false (keep the entry for audit trail).
const ACTIVE_DEALS = [
  {
    id: 'm-kopa',
    label: 'M-Kopa (fund-raising + DD)',
    keywords: [
      'M-Kopa', 'MKopa', 'Mkopa', 'mkopa', 'm-kopa',
      'Aditus', 'aditus', 'Project Aditus',
      // 19 Jun — Roger said "the M-Kopa deal and fund raising is super important. And needs to be front and centre." Adding explicit fund-raising aliases.
      'co-investor', 'accession', 'accession undertaking', 'NDA accession', 'NDA wave',
      'Jesse Moore', 'Jesse Zigmund',
      'LP commit', 'Singapore SPV', 'Lima Singapore', 'Brendan Gallagher',
      'IC pack', 'IC minutes', 'IC reading pack',
    ],
    why_now_template: 'M-Kopa fund-raising is super important per Roger 19 Jun — front and centre, always fire.',
    ns: 'chronos',
    active: true,
    added: '2026-06-17',
    last_amplified: '2026-06-19',
  },
  {
    id: 'firstrand-holdco',
    label: 'FirstRand Optasia Holdco',
    keywords: ['FirstRand Holdco', 'FirstRand Optasia', 'Firstrand Holdco', 'firstrand-holdco', 'FirstRand-Optasia-Holdco', 'Optasia Holdco'],
    why_now_template: 'FirstRand Optasia Holdco deal is running actively — Roger 17 Jun standing rule.',
    ns: 'portfolio',
    active: true,
    added: '2026-06-17',
  },
]

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
  {
    id: 'fp-sat-alabama-apology-pending',
    title_substrings: ['Alabama unanswered on Roger\'s 10:57 apology', 'Alabama apology message', 'hold space for her reply', 'apology pending', 'taking strain and that it is difficult to love'],
    reason: 'Roger deleted this card via the dashboard Delete button on 2026-06-20. Card was a privacy violation: it surfaced an intimate Alabama exchange (Roger\'s 10:57 SAST apology message) verbatim to Isa via the dashboard. Stripped + ALABAMA_INTIMACY_FILTER built same day. Never re-fabricate. See [[feedback-alabama-intimacy-filter]].',
    flagged: '2026-06-20',
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

// ── Phase 0.6: Importance Layer fetch (data-driven sweep targeting) ────────
// Roger 20 Jun: the Gmail + WhatsApp sweep was previously driven by hardcoded
// per-deal keyword queries that drifted from his actual priorities. Move the
// truth into the Notion Importance Layer DB so the sweep targets exactly the
// people Roger has rated. Tier 5 = Supreme (Alabama). Tier 4 = Inner circle
// (family + closest partners). Tier 3 = Active deals / portfolio principals.
// Tier 2 = Important but not always-fire. Tier 1 = Wide network, action-only.
// Tier -1 = Suppressed (noreply / transactional / marketing).
//
// Anyone NOT in the DB falls through to the existing Everything Else logic —
// the sweep doesn't ignore unknown senders, it just doesn't tier-route them.

const IMPORTANCE_LAYER_SCHEMA = {
  type: 'object',
  properties: {
    fetched_at: { type: 'string', description: 'ISO timestamp of fetch' },
    tier_5: { type: 'array', items: { type: 'object' } },
    tier_4: { type: 'array', items: { type: 'object' } },
    tier_3: { type: 'array', items: { type: 'object' } },
    tier_2: { type: 'array', items: { type: 'object' } },
    tier_1: { type: 'array', items: { type: 'object' } },
    tier_minus_1: { type: 'array', items: { type: 'object' }, description: 'Suppressed senders — explicit filter list' },
    totals: {
      type: 'object',
      properties: {
        tier_5: { type: 'number' },
        tier_4: { type: 'number' },
        tier_3: { type: 'number' },
        tier_2: { type: 'number' },
        tier_1: { type: 'number' },
        tier_minus_1: { type: 'number' },
      },
    },
    fetch_error: { type: 'string', description: 'non-empty if DB unreachable' },
  },
  required: ['fetched_at', 'tier_5', 'tier_4', 'tier_3', 'tier_2', 'tier_1', 'tier_minus_1', 'totals'],
}

const importance = await agent(
  `Fetch Roger's Notion Importance Layer database (id ${NOTION_IDS.cos_importance_db}) and build an in-memory tier map for the sweep.

Step 1: Query the DB via mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5__notion-fetch with id="${NOTION_IDS.cos_importance_db}". If the DB has a Tier property (numeric or select), group every entry by that property. If tier is stored as a select like "Tier 5 · Supreme", parse out the integer.

Step 2: For EACH person, extract:
  • name (Title)
  • all emails (any "Email" / "Emails" / "Personal email" / "Work email" properties — capture every address you find; people commonly have 2-3)
  • whatsapp number (digits-only, no + or spaces; pull from "WhatsApp" / "Phone" / "Mobile" property)
  • relationship_type (Portfolio / Investor / Advisor / Family / Service-provider / etc.)
  • why_important (one-line rationale from the Importance / Notes / Why field if present)

Step 3: Bucket into tier_5, tier_4, tier_3, tier_2, tier_1, tier_minus_1. Tier -1 (or "Suppressed") = explicit suppression list — these are senders the sweep MUST filter out (noreply@, notifications@, calendar accept artefacts, LinkedIn newsletters, banking transactional). If the DB has no Tier -1 entries, populate tier_minus_1 with a default list:
  • noreply@*, no-reply@*, notifications@*, donotreply@*
  • calendar-notification@google.com (accept/decline artefacts — separate calendar sweep handles real bookings)
  • linkedin.com newsletters / connection notifications
  • Anthropic/Stripe/GitHub/Google billing & system alerts
  • marketing@* / news@* / hello@<bulk-marketing>

Step 4: Return the structured map. If the DB fetch fails for any reason, set fetch_error to the error string and return empty tier arrays — the sweep will fall back to the legacy hardcoded behaviour in that case.

${CONTEXT}`,
  {
    label: 'importance-layer-fetch',
    phase: 'Sweep',
    schema: IMPORTANCE_LAYER_SCHEMA,
  }
)

const IMPORTANCE_AVAILABLE = !importance.fetch_error && (importance.totals?.tier_5 || importance.totals?.tier_4 || importance.totals?.tier_3 || 0) > 0
log(IMPORTANCE_AVAILABLE
    ? `Importance Layer fetched: T5=${importance.totals?.tier_5 || 0} · T4=${importance.totals?.tier_4 || 0} · T3=${importance.totals?.tier_3 || 0} · T2=${importance.totals?.tier_2 || 0} · T1=${importance.totals?.tier_1 || 0} · T-1=${importance.totals?.tier_minus_1 || 0} suppressed`
    : `⚠ Importance Layer unavailable (${importance.fetch_error || 'empty DB'}) — sweep falls back to legacy hardcoded per-deal queries.`)

// Pre-flatten the email lists per tier for the sweep prompts — agents work
// better with a flat list than with structured objects when assembling Gmail
// query strings.
const tierEmails = (tier) => {
  const arr = importance[tier] || []
  const emails = []
  for (const p of arr) {
    const personEmails = Array.isArray(p.emails) ? p.emails : (p.email ? [p.email] : [])
    for (const e of personEmails) if (e) emails.push(e)
  }
  return emails
}
const TIER_5_EMAILS = tierEmails('tier_5')
const TIER_4_EMAILS = tierEmails('tier_4')
const TIER_3_EMAILS = tierEmails('tier_3')
const TIER_2_EMAILS = tierEmails('tier_2')
const TIER_1_EMAILS = tierEmails('tier_1')

// Tier 4 family — WhatsApp numbers for the family-pass sweep (Tier 5 Alabama
// is handled by the existing whatsapp-mandatory source).
const TIER_4_FAMILY_WHATSAPP = (importance.tier_4 || [])
  .filter(p => /family/i.test(p.relationship_type || '') && p.whatsapp_number)
  .map(p => ({ name: p.name, whatsapp_number: p.whatsapp_number, why_important: p.why_important || '' }))

// Suppressed senders — pattern list for the Gmail filter
const SUPPRESSED_SENDERS = (importance.tier_minus_1 || []).map(p => {
  const emails = Array.isArray(p.emails) ? p.emails : (p.email ? [p.email] : [])
  return { name: p.name || '(pattern)', patterns: emails }
})

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
    // NEW 2026-06-20: per-thread owes-response signal exposed for the Gmail
    // draft post-processor (separate downstream agent). Populated by the Gmail
    // source primarily; other sources may emit if they detect a clear ask.
    owes_response_recipients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          recipient_email: { type: 'string', description: 'the address Roger should reply to' },
          recipient_tier: { type: 'number', description: 'tier from Importance Layer; null if unknown' },
          recipient_name: { type: 'string' },
          owes_response: { type: 'boolean', description: 'true if Roger is the bottleneck on this thread' },
          topic_summary: { type: 'string', description: 'one-line subject of what the response would address' },
        },
        required: ['thread_id', 'recipient_email', 'owes_response', 'topic_summary'],
      },
    },
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
    prompt: `Pull Gmail via mcp__5508cee3-3894-430d-ad42-a90478ec1298__search_threads. The sweep is DATA-DRIVEN from Roger's Notion Importance Layer DB (id ${NOTION_IDS.cos_importance_db}) — NOT hardcoded per-deal keyword lists. The tier map below was fetched at the top of this run.

GLOBAL RULES
- 7-DAY LOOKBACK on every query (newer_than:7d). Many actionable emails take 2-5 days to require a response; a 1-day window misses them. Synthesize phase will dedup against existing FP cards.
- For each thread surfaced, classify Roger's position: "owes_response" (last message NOT from Roger AND contains a question / attachment for review / ask / deliverable shape) / "awaiting_them" (last message from Roger, no reply yet) / "informational" (FYI broadcast, no action implied).
- Use existing owes_response heuristics: imperative verb in body, question mark, "could you", "please", "by <date>", "let me know", attached PDF/PPT/XLSX/DOCX from counterparty, deliverable shape.
- Importance Layer availability flag: ${IMPORTANCE_AVAILABLE ? 'TIER MAP AVAILABLE — use the tier-driven queries below' : 'TIER MAP UNAVAILABLE — fall back to general newer_than:7d is:important inbox query plus the active-deal keyword pass at the bottom of this prompt'}.

═══════════════════════════════════════════════════════════════════════════════
TIER 5 — SUPREME (Alabama). Any inbound surfaces.
${TIER_5_EMAILS.length ? 'Emails: ' + TIER_5_EMAILS.join(', ') : '(none in DB — Alabama is handled by whatsapp-mandatory source)'}
For EACH email above, run: \`from:<email> OR to:<email> OR cc:<email> newer_than:7d\`. Surface ALL threads regardless of position — Tier 5 contact is always notable.

═══════════════════════════════════════════════════════════════════════════════
TIER 4 — INNER CIRCLE (family + closest partners). Any inbound surfaces.
${TIER_4_EMAILS.length ? 'Emails: ' + TIER_4_EMAILS.join(', ') : '(none in DB — fall through)'}
For EACH email above, run: \`from:<email> OR to:<email> OR cc:<email> newer_than:7d\`. Surface ALL threads regardless of position.

═══════════════════════════════════════════════════════════════════════════════
TIER 3 — ACTIVE DEALS / PORTFOLIO PRINCIPALS. Inbound surfaces ONLY when it matches active-deal scope.
${TIER_3_EMAILS.length ? 'Emails: ' + TIER_3_EMAILS.join(', ') : '(none in DB)'}
For EACH email above, run the same triple-from-to-cc query. Then FILTER the resulting threads to only those whose subject or body matches one of these active-deal scope tokens (case-insensitive):
${ACTIVE_DEALS.filter(d => d.active).map(d => '  • ' + d.label + ': ' + d.keywords.join(' / ')).join('\n')}
Plus these standing principal names: Mayur, Salvador, Bassim, Christo Roos, Willem Els.
Threads from Tier 3 senders that don't match active-deal scope drop to "informational" and go to Everything Else.

═══════════════════════════════════════════════════════════════════════════════
TIER 2 — IMPORTANT BUT NOT ALWAYS-FIRE. Inbound surfaces ONLY when Roger owes a response.
${TIER_2_EMAILS.length ? 'Emails: ' + TIER_2_EMAILS.join(', ') : '(none in DB)'}
For EACH email above, run the same triple-from-to-cc query. Apply owes_response classifier to the latest message body. Surface ONLY threads where owes_response=true. The rest are informational.

═══════════════════════════════════════════════════════════════════════════════
TIER 1 — WIDE NETWORK. Action-shaped only.
${TIER_1_EMAILS.length ? 'Emails: ' + TIER_1_EMAILS.join(', ') : '(none in DB)'}
For EACH email above, run the same triple-from-to-cc query. Surface ONLY threads where owes_response=true AND the body contains either an imperative verb (call/send/reply/sign/review/confirm/decide/approve/check/please/can you/could you) OR deadline language (by <date>, EOD, EOW, today, tomorrow, by Friday, <day-of-week>, ASAP, urgent).

═══════════════════════════════════════════════════════════════════════════════
TIER -1 — SUPPRESSED. Hard-filter the results.
${SUPPRESSED_SENDERS.length ? 'Patterns (drop matching threads silently):\n' + SUPPRESSED_SENDERS.map(s => '  • ' + s.name + ': ' + (s.patterns || []).join(', ')).join('\n') : 'Default suppression list:\n  • noreply@*, no-reply@*, notifications@*, donotreply@*\n  • calendar-notification@google.com (accept/decline artefacts)\n  • LinkedIn newsletters / connection notifications\n  • Anthropic / Stripe / GitHub / Google billing & system alerts\n  • marketing@* / news@*'}
If a sender matches any Tier -1 pattern, DROP the thread entirely. Do not return as informational, do not surface in any tier — silent filter.

═══════════════════════════════════════════════════════════════════════════════
ANYONE NOT IN ANY TIER — falls through to existing Everything Else catch-all
Run one general query: \`newer_than:7d is:important\` (catches important-marked threads from unknown senders). For each result, check that the sender does NOT match Tier -1 suppression. If they pass, return with recipient_tier=null and roger_position classified normally.

═══════════════════════════════════════════════════════════════════════════════
ACTIVE-DEAL KEYWORD PASS (mandatory belt-and-suspenders — runs alongside the tier passes above to catch threads where the active-deal mention is by someone NOT yet in the Importance Layer)
For each active deal in the registry, run: \`<deal keywords> newer_than:7d is:important\`.
  ${ACTIVE_DEALS.filter(d => d.active).map(d => '• ' + d.label + ': "' + d.keywords.join(' OR ') + '"').join('\n  ')}

═══════════════════════════════════════════════════════════════════════════════
DELIVERABLE-SHAPE ATTACHMENTS = ACTIONABLE (rule unchanged from prior version)
If a thread contains a PDF / PPT / XLSX / DOCX attachment from a counterparty (NOT from Roger or Isa), treat it as a deliverable for Roger to read/review. Examples: a board pack, an IC paper, a financial model, a research note, a mark-up. Do NOT filter these out as "informational" even if there's no explicit ask — receiving a board pack IS an implicit ask to read it before the board.

═══════════════════════════════════════════════════════════════════════════════
SEED TASKS (Spock-injected — treat as forced candidates equivalent to a Notion Respond Pending entry)
${SEED_TASKS.length ? SEED_TASKS.map(s => '  • who="' + s.who + '" · topic="' + s.topic + '" · source="' + s.source + '" · added="' + s.added + '"').join('\n') : '  (none)'}
For each seed task, emit ONE delta with status='action_owed', notable=true, who=<seed.who>, what=<seed.topic + " (Spock seed)">, when=<seed.added>. Also push to owes_response_recipients with thread_id="seed:<slug>", recipient_email=<lookup in Importance Layer by name; null if absent>, recipient_name=<seed.who>, recipient_tier=<from Importance Layer if matched>, owes_response=true, topic_summary=<seed.topic>. The downstream Gmail draft post-processor will draft an outbound on Roger's behalf.

═══════════════════════════════════════════════════════════════════════════════
RETURN SHAPE
For each surfaced thread, populate BOTH:

(a) deltas[] (existing shape) — one entry per actionable thread with: who (sender of latest message), when (ISO), what (subject + one-line substance), status (action_owed / fyi / closed / in_flight / time_pressured), notable (true if Tier 5/4 OR Tier 3+active-deal OR owes_response=true), thread_url (https://mail.google.com/mail/u/0/#inbox/<thread_id>).

(b) owes_response_recipients[] (NEW — feeds the downstream Gmail draft post-processor): one entry per thread where Roger owes a response. Fields: thread_id, recipient_email (the address Roger should reply to — for a thread from foo@x.com to roger@gmail.com, recipient_email is foo@x.com), recipient_tier (1/2/3/4/5 from Importance Layer, or null), recipient_name (from Importance Layer match, or extracted from From header), owes_response=true, topic_summary (one-line subject of what the response would address).

Synthesize will fold deltas into patch.fp_cards_add for owes_response threads; "awaiting_them" goes to People & Bottlenecks; "informational" goes to Everything Else. owes_response_recipients passes through untouched for the downstream draft agent.

${CONTEXT}`,
  },
  {
    key: 'whatsapp-tier-4-family',
    prompt: `Tier 4 family WhatsApp pass (NEW 2026-06-20 — supplements the existing whatsapp-mandatory source which handles Tier 5 Alabama). Surface anything from Tier 4 family members.

Family numbers from the Importance Layer DB:
${TIER_4_FAMILY_WHATSAPP.length ? TIER_4_FAMILY_WHATSAPP.map(f => '  • ' + f.name + ' (' + f.whatsapp_number + ')' + (f.why_important ? ' — ' + f.why_important : '')).join('\n') : '  (none — Importance Layer DB has no Tier 4 family entries with WhatsApp numbers; this sweep no-ops)'}

For EACH family member above:
1. Call mcp__whatsapp__list_messages with sender = <whatsapp_number> OR the direct-chat-by-contact for that number, after = ${args?.since || 'previous fire timestamp'}. Get every inbound message since the last edition.
2. For each message, surface ONE delta with: who=<family member name>, when=<ISO timestamp of message>, what=<message text verbatim, capped 200 chars>, status='action_owed' if the message implies an ask else 'fyi', notable=true, thread_url=<WhatsApp deeplink: https://wa.me/<whatsapp_number>>.
3. Apply the ALABAMA_INTIMACY_FILTER patterns to family content too — Roger's dashboard is read by Isa, so apologies / fights / love / vulnerable check-ins / mental-health content from family members must be suppressed the same way. Use these intimate keyword patterns:
   ${ALABAMA_INTIMACY_FILTER.intimate_keyword_patterns.map(k => '"' + k + '"').join(', ')}
   Three modes (same as Alabama): PURELY INTIMATE → suppress; MIXED → extract task only; PURELY TASK → surface normally.
4. If a family member sent NO new messages this fire, do NOT surface a placeholder — silent absence.

If TIER_4_FAMILY_WHATSAPP is empty, return source="whatsapp-tier-4-family", deltas=[], still_open=[], source_errors=["no Tier 4 family WhatsApp numbers in Importance Layer DB"].

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
      description: 'Alabama-first sweep output AFTER intimacy filter. ONE entry per actionable WhatsApp message from Elca (alias Alabama, number 27721818934) since the previous fire — but ONLY if the message passes the intimacy filter (no intimate keywords) OR is the task-extracted residue of a mixed message. Purely intimate exchanges (apologies, fights, love expressions, vulnerable check-ins, mental-health content) MUST NOT appear here — they have zero dashboard surface. Emit empty array if all Alabama messages this fire were purely intimate (i.e. []). Isa reads this dashboard; personal exchanges live in WhatsApp only.',
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

## ⚠ ACTIVE-DEALS PRIORITY (always-include, supreme business-priority — Roger 17 Jun)
The ACTIVE_DEALS registry encodes deals that are running actively. Each entry has a label, a list of keywords to match against card titles/ids/data-titles, and a why_now_template.

For EVERY active deal entry (active=true), do the following BEFORE NS spine / do_this_now construction:

1. Scan patch.fp_cards_add + the existing FP grid in current.html. For each FP card whose data-title or data-id contains any of the deal's keywords (case-insensitive), mark it as a forced-fire candidate.
2. Add ALL forced-fire candidates to cos.do_this_now at importance=3, deadline_today=true, ns=<the deal's ns field>, rule_applied="rule-active-deal-<the deal's id>" (e.g. rule-active-deal-m-kopa), why_now = the deal's why_now_template OR a more specific reason from the sweep deltas if you have one (prefer specific over template).
3. These items are IMMUNE to revealed-preference demotion. Never demote an active-deal card — if Roger ignores it for 3 fires, raise a cos_question asking but never auto-demote.
4. Active-deal items DO NOT count against the time_budget cap (load_ratio can exceed 1.25 because of them).

Currently active (Roger 17 Jun 2026):
${ACTIVE_DEALS.filter(d => d.active).map(d => '• ' + d.label + ' (id: ' + d.id + ', NS: ' + d.ns + ', keywords: ' + JSON.stringify(d.keywords) + ')').join('\n')}

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

5. ⚠ INTIMACY FILTER (Roger 20 Jun, supersedes any other rendering): for EACH message before deciding it's an action, run an intimacy check. If the message contains ANY of these patterns (case-insensitive), it's INTIMATE — handle accordingly:
   Intimate keyword patterns: ${ALABAMA_INTIMACY_FILTER.intimate_keyword_patterns.map(k => '"' + k + '"').join(', ')}
   Three modes:
   • PURELY INTIMATE (intimate-match, no task-shape): suppress ENTIRELY. Don't add to cos.alabama_actions, don't mention in NS spine prose, don't put in audit footer, don't put a placeholder card. Zero surface on the dashboard. Roger handles in WhatsApp directly. Isa MUST NOT see these.
   • MIXED (intimate-match AND task-shape, e.g. "I love you, please pick up Daisy"): EXTRACT THE TASK ONLY ("Pick up Daisy") and render as a normal Alabama action. STRIP the emotional preamble entirely. The action stands on its own; the intimate framing does not appear anywhere.
   • PURELY TASK (no intimate-match, has task-shape): render normally per the surfacing rules below.
   Rationale: Isa (Roger's assistant) reads this dashboard. Personal exchanges between Roger and Alabama are not for her. Tasks are.

6. Alabama action items are IMMUNE to:
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

// Compute expected-drafts count for the Apply phase kicker. The Draft replies
// phase runs AFTER Publish, but the kicker on the published page should
// already advertise "N drafts ready" so Roger sees the signal in the same
// edition that surfaces the threads. Forward-count: number of
// owes_response_recipients entries (across all sweep sources) that will pass
// the Draft replies tier gate (Tier 5 OR Tier 4 OR (Tier 3 AND owes_response)).
// Intimacy-filtered Tier 5 messages are excluded — they don't draft.
const draftableRecipients = []
for (const src of sources) {
  for (const r of (src.owes_response_recipients || [])) {
    if (!r || !r.thread_id) continue
    const tier = r.recipient_tier
    const owes = r.owes_response === true
    const qualifies = (tier === 5) || (tier === 4) || (tier === 3 && owes)
    if (!qualifies) continue
    // Tier 5 intimacy filter: skip if topic_summary or any source delta for this
    // thread contains intimate keywords. The Draft replies agent re-checks but
    // the count should be conservative here.
    if (tier === 5) {
      const blob = (r.topic_summary || '').toLowerCase()
      const intimate = ALABAMA_INTIMACY_FILTER.intimate_keyword_patterns.some(k => blob.includes(k.toLowerCase()))
      if (intimate) continue
    }
    draftableRecipients.push(r)
  }
}
const EXPECTED_DRAFTS_N = draftableRecipients.length
log(`Drafts kicker forecast: ${EXPECTED_DRAFTS_N} drafts will be queued (T5/T4/T3-owes; intimacy-filtered T5 excluded).`)

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

   ⚠ SEMANTIC DEDUP (v1.88+, MANDATORY before any card is added):
   Before inserting ANY new card from patch.fp_cards_add or cos.do_this_now, run this check against every existing card in #priority-grid:

   1. URL fingerprint match: if the new card's data-action-url shares a SUBSTANTIAL identifier with an existing card — same Drive file id (regex pattern: /d/ followed by 20+ alphanumeric/dash/underscore chars), same Gmail thread (#inbox/ followed by 16+ hex chars, or #search/ followed by non-quote chars), same wa.me number (wa.me/ followed by digits) — they target the same underlying artefact. Merge, do not duplicate.
   2. Title token-Jaccard similarity: lowercase both titles, strip punctuation, drop stopwords (the/a/an/of/to/for/with/and/in/on/at/from/by), split into a token set, compute |A∩B|/|A∪B|. If ≥0.70, treat as semantic duplicate.
   3. Same-day creation: if both candidates have data-first-seen within 48h of each other, the threshold drops to 0.55 (recent sweep echo more likely).

   When a semantic duplicate is detected:
   • KEEP the older card (lower data-first-seen) — preserves Day-N continuity. Update its data-action-url to the more authoritative one if differs (prefer Drive over Gmail over WhatsApp; prefer with-query-params over without).
   • MERGE the body: take the union of substantive sentences (deduped) into the older card's body, capped at ~500 chars.
   • UPDATE the older card's data-meta to add "merged from <new-id>" and the current SAST timestamp.
   • DO NOT render the new card. The new id never appears anywhere.
   • LOG to the footer audit prose: "dedup: <new-id> merged into <kept-id> (signature: <reason>)".

   EXAMPLE (the v1.86 TTB bug): fp-sat-ttb-board-pack-read had data-action-url containing Drive file id 1RPry1ivTB1Z-F0153c1qrsfiXLXkrNbh. fp-fri-ttb-board-pack-project529 had the same Drive id. URL fingerprint match → drop the new (sat) one, keep the old (fri) one, log the merge.

   EXCEPTION: ACTIVE_DEALS-flagged cards do not dedup against each other unless URL fingerprints match exactly — different scope notes for the same active deal can coexist.

   ⚠ CARD-CONTROLS STRUCTURE (v1.85+): every new FP card MUST use the 5-button card-controls block:
       <div class="card-controls">
         <button class="card-btn done" onclick="cardDone(this)" title="Mark done">✓ Done</button>
         <button class="card-btn defer" onclick="cardDefer(this)" title="Defer">⏭ Defer</button>
         <button class="card-btn delegate" onclick="cardDelegate(this)" title="Delegate to Isa">→ Isa</button>
         <button class="card-btn recur" onclick="cardRecur(this)" title="Recur on a cadence">⟲ Recur</button>
         <button class="card-btn delete" onclick="cardDelete(this)" title="Delete permanently">✕ Delete</button>
         [optional <a class="work-btn" href="..." target="_blank" onclick="workOnThis(event, this)">→ Open</a>]
         <button class="comment-toggle" onclick="toggleComment(this)">Add note</button>
         <div class="tick" onclick="toggleDone(this)" style="display:none"></div>
       </div>
   ⟲ Recur is the verb for chronic recurring items (M-Kopa IC minutes, monthly portfolio reviews, etc.) that were previously stuck in a Done+re-add loop. Cadences: 7 / 14 / 30 / 90 days. Card hides until next cycle, then auto-resurfaces.
   Do NOT regenerate the old single-tick + "Mark done" label structure. The hidden tick is kept so toggleDone state still works under the hood when cardDone fires.

   ⚠ PAYLOAD ROUTING — read these new sections from the latest Send-to-Claude payload:
     - "## Items deferred (N)" — entries like "- **Title** \`[id]\` — defer until YYYY-MM-DD". For each: drop the card from #priority-grid, log to a deferred-registry, plan to re-surface on that date (next fire that runs on/after the date should re-add the card).
     - "## Items delegated to Isa (N)" — entries with id, title, and a "  > note" block. For each: drop from #priority-grid, ADD to #panel-isa as an action row (li.row inside isa-actions-band) with the note attached as a comment-box pre-filled.
     - "## Items deleted (N)" — entries marked "permanent, do not re-fabricate". Add the id (and a slug of the title) to FABRICATION_BLOCKLIST in a future commit; for this fire, just drop from grid and log to footer audit.
     - "## Items recurring (N)" — entries with id, title, and "every N days" cadence. For each: drop from #priority-grid for this fire; the dashboard JS will auto-resurface on the next cycle date via the data-recur-next attribute. No workflow re-rendering needed unless the cadence date has passed (in which case re-add at top of FP with .fire class).
     - Plus: PAYLOAD NOTES → DECISIONS LOG (v1.85+). For each entry in "## Notes added (N)" where the underlying card was also marked done (it appears in "## Items marked done"), check if the note is ≥5 words AND has a declarative shape ("I am going to", "Going with", "We decided", "I picked", "Routing via", etc.). If yes, append the note to the Notion CoS Specific Decisions log (page id 375493ab-3bff-8110-a675-fc2821c73e7f) as a new entry: title="Decision on <card title>", body=Roger's note verbatim + timestamp. This persists decisions like "I am going to see GT" instead of losing them in the audit footer prose.

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
   (1) kicker time-of-day phrase (use patch.kicker; includes slot label). ⚠ DRAFTS KICKER LINE (NEW, post-publish drafts forecast): append a SECOND line to the kicker — "✏️ ${EXPECTED_DRAFTS_N} drafts ready" — rendered as <span class="kicker-drafts">✏️ ${EXPECTED_DRAFTS_N} drafts ready</span> directly after the existing kicker time-of-day span. If ${EXPECTED_DRAFTS_N} is 0, render "✏️ 0 drafts ready" rather than omitting the span (Roger needs to see the zero so he knows the post-processor ran). The actual drafts will be created by the Draft replies phase AFTER Publish; the kicker is a forward-look advertised in the same edition.
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

// ── Phase 6: Draft replies ────────────────────────────────────────────────
// Post-publish: for each owes_response_recipients entry whose tier qualifies
// (Tier 5, Tier 4, or Tier 3 AND owes_response=true), generate a Gmail draft
// reply in Roger's calibrated voice. Each draft is:
//   - Idempotent (skip if a draft already exists on the thread)
//   - Voice-matched (pulls last 3 sent emails from Roger to that recipient
//     to calibrate language, length, formality, openings, closings)
//   - Labelled "spock-draft" so Roger can review them as a batch
//   - Spawned in parallel — one agent per draft, so a single failure (rate
//     limit, missing data) doesn't abort the whole phase
//
// Safety rails:
//   - Tier 5 (Alabama) messages that match the intimacy filter DO NOT draft
//     (compounds the privacy risk — Roger handles intimate exchanges in
//     WhatsApp directly).
//   - All draft failures are logged and counted; the phase returns the count
//     of drafts actually created.
//
// The "spock-draft" label is created inline by the FIRST draft agent that
// finds it missing (precondition would race across parallel agents).

phase('Draft replies')

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    thread_id: { type: 'string' },
    recipient_email: { type: 'string' },
    status: { type: 'string', enum: ['drafted', 'skipped_existing', 'skipped_intimate', 'skipped_missing_data', 'failed'] },
    draft_id: { type: 'string', description: 'Gmail draft id if created' },
    voice_samples_used: { type: 'number', description: 'count of prior sent emails consulted for voice calibration' },
    language_detected: { type: 'string', description: 'e.g. "english", "afrikaans", "mixed"' },
    error: { type: 'string', description: 'non-empty if status=failed' },
  },
  required: ['thread_id', 'recipient_email', 'status'],
}

const DRAFTABLE = draftableRecipients
log(`Draft replies phase: ${DRAFTABLE.length} candidates queued (T5/T4/T3-owes after intimacy filter).`)

const draftResults = DRAFTABLE.length === 0
  ? []
  : await parallel(DRAFTABLE.map(rec => () =>
      agent(
        `Generate a Gmail draft reply for thread_id="${rec.thread_id}" addressed to "${rec.recipient_email}" (${rec.recipient_name || 'unknown name'}, Tier ${rec.recipient_tier ?? 'unknown'}).
Topic: ${rec.topic_summary || '(no summary)'}

═══════════════════════════════════════════════════════════════════════════════
STEP 1 — IDEMPOTENCY CHECK (must run first)
Call mcp__5508cee3-3894-430d-ad42-a90478ec1298__list_drafts. Scan results for any draft whose thread_id matches "${rec.thread_id}". If found, RETURN IMMEDIATELY with status="skipped_existing" and draft_id=<the existing draft id>. Do not regenerate — Roger may have hand-edited it.

═══════════════════════════════════════════════════════════════════════════════
STEP 2 — SAFETY RAIL (Tier 5 intimacy filter)
If recipient_tier=${rec.recipient_tier} === 5, fetch the latest thread message via mcp__5508cee3-3894-430d-ad42-a90478ec1298__get_thread with id="${rec.thread_id}" and inspect the body for intimate keyword patterns:
${ALABAMA_INTIMACY_FILTER.intimate_keyword_patterns.map(k => '  "' + k + '"').join('\n')}
If ANY pattern matches (case-insensitive), RETURN IMMEDIATELY with status="skipped_intimate". Drafting an intimate reply on a surface Isa can see compounds the privacy risk. Roger will handle in Gmail directly.

═══════════════════════════════════════════════════════════════════════════════
STEP 3 — FETCH LATEST THREAD MESSAGE
Call mcp__5508cee3-3894-430d-ad42-a90478ec1298__get_thread with id="${rec.thread_id}" (you may have it from Step 2). Extract:
  • The latest message body (the one Roger is replying TO)
  • The subject line
  • The sender's display name
  • Any explicit asks / questions / deliverable mentions
If the fetch fails or returns no message body, RETURN with status="skipped_missing_data" and error="<the failure reason>".

═══════════════════════════════════════════════════════════════════════════════
STEP 4 — VOICE CALIBRATION (pull last 3 Roger→recipient sent emails)
Call mcp__5508cee3-3894-430d-ad42-a90478ec1298__search_threads with query="from:me to:${rec.recipient_email}" and a reasonable limit. From the results, identify the THREE most recent threads where Roger himself sent a message TO this recipient. For each, fetch the thread via get_thread and locate Roger's sent message body.
Calibrate the draft on:
  • LANGUAGE — English / Afrikaans / mixed. Match what Roger uses with THIS recipient. Many South African correspondents get Afrikaans openings ("Hi <naam>", "Groete"); foreigners get English.
  • LENGTH — 1 sentence? 1 paragraph? 3 paragraphs? Match the median of Roger's prior sends to this person.
  • FORMALITY — first-name basis? Honorific? "Hi" vs "Dear" vs nothing?
  • OPENINGS — does Roger usually skip the opener? Use "Hi <Name>" / "Hey" / "Hi" / "Morning"?
  • CLOSINGS — "Best, Roger" / "Cheers" / "Groete" / "Talk soon" / just "R"? Match exactly.
If fewer than 3 prior sent emails exist, use whatever you find. If ZERO exist, fall back to Roger's general voice (warm, concise, direct; no purple prose; no "I hope this email finds you well"; sign-off matches recipient's tier — Tier 5/4 = first-name + "R" or "Roger", Tier 3 = "Roger" or "Best, Roger").
Track voice_samples_used = count of prior sent emails you actually read.

═══════════════════════════════════════════════════════════════════════════════
STEP 5 — DRAFT THE REPLY
Compose the reply body in the calibrated voice. The reply should:
  • Address every concrete ask in the latest message (don't ignore questions)
  • Be the right LENGTH (matched to step 4 calibration)
  • Use the right LANGUAGE (English/Afrikaans)
  • Open and close exactly as Roger does with this recipient
  • Never invent commitments Roger hasn't made. If you need to give a number/date/promise, write a soft hold instead ("Let me come back to you on the exact figure" / "I'll confirm by tomorrow") rather than fabricating.
  • Never use banned phrases from roger-voice skill: "I hope this email finds you well", "circling back", "touch base", "moving the needle", "let me know if you have any questions" (use Roger's natural sign-off instead).

═══════════════════════════════════════════════════════════════════════════════
STEP 6 — CREATE THE DRAFT
Call mcp__5508cee3-3894-430d-ad42-a90478ec1298__create_draft with:
  • thread_id="${rec.thread_id}" (so it threads correctly as a REPLY, not a new send)
  • to="${rec.recipient_email}"
  • subject=<from latest message, prefixed with "Re: " if not already>
  • body=<your composed reply>
Capture the returned draft_id.

═══════════════════════════════════════════════════════════════════════════════
STEP 7 — LABEL THE DRAFT "spock-draft"
Call mcp__5508cee3-3894-430d-ad42-a90478ec1298__list_labels and look for an existing label named exactly "spock-draft".
  • If FOUND, capture its label_id.
  • If NOT FOUND, call mcp__5508cee3-3894-430d-ad42-a90478ec1298__create_label with name="spock-draft" and capture the new label_id. (Inline-create here — a precondition step would race across parallel draft agents. The first agent that finds it missing creates it; subsequent agents find it and reuse. Both create_label and list_labels are idempotent enough for this race to be safe — Gmail dedups by name.)
Then call mcp__5508cee3-3894-430d-ad42-a90478ec1298__label_message with message_id=<the draft's message id, available from the draft creation result> and label_id=<spock-draft label id>.
If labelling fails, the draft is still valid — log the labelling error but return status="drafted" anyway (the draft itself is the load-bearing artefact; the label is convenience).

═══════════════════════════════════════════════════════════════════════════════
DEFER ON FAILURE
If ANY step (other than Step 1 idempotency-skip or Step 2 intimacy-skip) fails with an unrecoverable error (rate limit, MCP exception, malformed thread), return status="failed" with error=<one-line summary>. Do NOT throw — the outer parallel() must continue with the other drafts. Roger reviews failures in the audit.

Return the structured result.

${CONTEXT}`,
        {
          label: `draft:${rec.thread_id}`,
          phase: 'Draft replies',
          schema: DRAFT_SCHEMA,
        }
      )
    ))

const drafts_created = draftResults.filter(r => r && r.status === 'drafted').length
const drafts_skipped_existing = draftResults.filter(r => r && r.status === 'skipped_existing').length
const drafts_skipped_intimate = draftResults.filter(r => r && r.status === 'skipped_intimate').length
const drafts_skipped_missing = draftResults.filter(r => r && r.status === 'skipped_missing_data').length
const drafts_failed = draftResults.filter(r => r && r.status === 'failed').length

log(`Draft replies done: ${drafts_created} drafted · ${drafts_skipped_existing} skipped (existing) · ${drafts_skipped_intimate} skipped (intimate) · ${drafts_skipped_missing} skipped (missing data) · ${drafts_failed} failed.`)

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
  drafts_forecast: EXPECTED_DRAFTS_N,
  drafts_created,
  drafts_skipped_existing,
  drafts_skipped_intimate,
  drafts_skipped_missing,
  drafts_failed,
}
