/**
 * build-meetings.workflow.js — Daily meeting harvester.
 *
 * Runs ~21:30 SAST. Discovers yesterday's meeting recordings + transcripts
 * from Google Meet (Drive auto-transcripts) and — eventually — Plaud.ai;
 * summarises each meeting, extracts action items, and writes a Notion
 * "Meeting Minutes" entry. The build-ledger workflow reads that DB on its
 * next fire and surfaces unresolved actions on the Front Page.
 *
 * Phases:
 *
 *   A. Discover     — list yesterday's Meet recordings + transcripts (Drive
 *                     MCP). Plaud DEFERRED — see PHASE-0 note below.
 *   B. Transcripts  — fetch the transcript body for each discovered meeting.
 *   C. Summarise    — one agent per meeting (parallel) producing {summary,
 *                     attendees, action_items, counterparty, sensitive_classification}.
 *   D. WALL classify — sensitive meetings (board / IC / MNPI keywords) get
 *                     written ONLY to ~/spock-calibration/<counterparty>/meetings/
 *                     outside any repo. Non-sensitive flow on to Notion.
 *   E. Write Notion — create the "Meeting Minutes" DB if it doesn't exist,
 *                     then create one page per non-sensitive meeting.
 *
 * Watermark: ~/spock/.meetings-watermark.json — meetings whose Drive/Plaud
 * id is already in the watermark are skipped without an agent call. This
 * makes the workflow safe to re-fire multiple times per day.
 *
 * PHASE 0 — Plaud.ai API status (as of 2026-06-20):
 *   Plaud has no documented public REST API for third-party access. Their
 *   official integrations (Notion / Obsidian / cloud sync) run inside the
 *   Plaud mobile/desktop app and there is no OAuth-style endpoint we can
 *   poll from a headless workflow. Two non-API paths exist but neither is
 *   worth wiring in v1:
 *     • Plaud already syncs cleaned notes into Notion via their built-in
 *       Notion connector — those pages will land in Roger's workspace
 *       directly and the build-ledger workflow already sweeps Notion.
 *     • A Drive "Plaud Cloud Sync" folder is possible but requires Roger
 *       to enable it manually per recording.
 *   → Plaud is DEFERRED to a Phase 2 of this workflow. v1 ships Google
 *     Meet only. If Plaud ships an API or Roger enables Drive sync we
 *     extend `discoverPlaud()` below.
 *
 * Designed for the same harness as build-ledger.workflow.js — exports `meta`,
 * uses phase() / agent() / parallel() / log(), structured outputs against
 * JSON schemas.
 */

export const meta = {
  name: 'spock-meetings',
  description: 'Daily harvest of yesterday\'s Google Meet (and eventually Plaud) recordings → transcripts → summaries → action items → Notion "Meeting Minutes" DB (or, for sensitive meetings, to the wall-side spock-calibration directory). Read by build-ledger on its next fire.',
  phases: [
    { title: 'Discover',     detail: 'List yesterday\'s Drive Meet recordings/transcripts; Plaud deferred (no public API as of 2026-06).' },
    { title: 'Transcripts',  detail: 'Fetch the transcript text for each discovered meeting (per-meeting, no barrier).' },
    { title: 'Summarise',    detail: 'One agent per meeting (parallel) — produces summary, attendees, action items, counterparty, sensitive_classification.' },
    { title: 'WALLClassify', detail: 'Sensitive meetings (board / IC / MNPI / OPA private / M-Kopa private / valuation, etc.) → wall-side ~/spock-calibration; never the repo, never Notion.' },
    { title: 'WriteNotion',  detail: 'Non-sensitive meetings → create or upsert "Meeting Minutes" Notion DB and write one page per meeting.' },
  ],
}

// ── Constants ─────────────────────────────────────────────────────────────

// MCP server prefixes (mirror those used by build-ledger.workflow.js).
const MCP_DRIVE  = 'mcp__0b1096ba-68e1-4341-8b2e-69c4b381de5a'
const MCP_NOTION = 'mcp__7cf2ebb5-ae5a-4a10-9ec8-1272580794b5'

const WATERMARK_PATH = '~/spock/.meetings-watermark.json'
const WATERMARK_SH   = '"$HOME/spock/.meetings-watermark.json"'  // bash-quoted, $HOME-expanded
const WALL_BASE_SH   = '"$HOME/spock-calibration"'               // never inside any repo
const WALL_BASE      = '~/spock-calibration'

// Notion DB title for the public-facing meeting minutes DB. The workflow
// will create it if it doesn't already exist (searched by title).
const NOTION_DB_TITLE = 'Meeting Minutes'

// Roger's identifiers for the "owner_is_roger" detection layer in the
// summarise phase. Action items where the owner is Roger get the
// owner_is_roger=true flag so the build-ledger workflow can prioritise
// them on the Front Page.
const ROGER_IDS = {
  name_aliases: ['Roger', 'Roger Grobler', 'RG', 'rgrobler', 'roger.grobler'],
  email_aliases: ['roger.grobler@gmail.com', 'roger@ccap.ai', 'rgrobler@chronos.capital'],
}

// ── SENSITIVE KEYWORDS (WALL discipline — never let MNPI into the repo) ───
// The summarise phase emits a sensitive_classification flag, but we also do
// a server-side belt-and-suspenders match on the keyword list before any
// Notion write. ANY hit on the title, attendee counterparty, or transcript
// keyword scan routes the meeting to the wall-side directory instead.
//
// Lesson: OPA private calibration (~/spock-calibration/opa/) is wall-side
// for a reason — Roger is on Optasia's board, the board-pack MNPI calibrates
// VALUATION METHOD only, and it never enters the repo or Notion. Same
// discipline applies to every other portfolio-board meeting.
const SENSITIVE_KEYWORDS = [
  // Generic governance / MNPI
  'board meeting', 'board pack', 'board update', 'board minutes',
  'MNPI', 'material non-public', 'material nonpublic',
  'IC meeting', 'IC pack', 'IC minutes', 'IC paper', 'IC recommendation',
  'investment committee',
  'valuation', 'fair value', 'mark to market', 'mark-to-market',
  'closed period', 'inside information', 'trading window',

  // Specific portfolio-company contexts that are board / inside lane for Roger
  'OPA', 'Optasia', 'Optasia private', 'Optasia board', 'Optasia Reduced Board',
  'M-Kopa private', 'M-Kopa board', 'M-Kopa IC', 'Aditus private',
  'ARC IC', 'ARC board', 'ARC investments private',
  'Tyme board', 'Tyme private', 'Tyme IC',
  'FirstRand Holdco board',

  // Reduced-board / sub-committee patterns
  'Reduced Board', 'Audit Committee', 'Risk Committee', 'Remco', 'Remuneration Committee',

  // Lawyer-client privileged
  'Werksmans privileged', 'legal privileged', 'legal advice',

  // Hard MNPI-flavoured terms
  'earnings preview', 'pre-announcement', 'price sensitive',
  'rights issue', 'capital raise (private)', 'secondary placing',
]

// Counterparty inference table — when the summariser identifies a meeting
// is with one of these parties, the wall-side directory under
// ~/spock-calibration/<slug>/meetings/ is the file destination for the
// sensitive lane. Slugs are stable + short.
const WALL_COUNTERPARTY_SLUGS = {
  'optasia':        'opa',
  'opa':            'opa',
  'm-kopa':         'mkopa',
  'mkopa':          'mkopa',
  'aditus':         'mkopa',          // codename for M-Kopa
  'arc':            'arc',
  'arc investments':'arc',
  'tyme':           'tyme',
  'tyme group':     'tyme',
  'firstrand':      'firstrand',
  'chronos':        'chronos-internal',
}

// ── Context for every agent prompt ────────────────────────────────────────

const CONTEXT = `Roger Grobler, Partner at Chronos Capital Advisory in Stellenbosch.
This workflow harvests yesterday's meeting recordings and writes structured
minutes either to the Notion "Meeting Minutes" database (non-sensitive) or
to the wall-side ~/spock-calibration directory (board / IC / MNPI). The
build-ledger workflow reads the Notion DB on its next fire and surfaces
unresolved action items on the dashboard Front Page.`

// ── Yesterday's window (SAST) ─────────────────────────────────────────────
// Compute once and pass into every prompt so all phases agree on the
// harvest window regardless of when within the 21:30 fire each phase runs.

phase('Discover')

const windowProbe = await agent(
  `Compute yesterday's harvest window in SAST (Africa/Johannesburg).
Run:  TZ='Africa/Johannesburg' date -v-1d '+%Y-%m-%dT00:00:00+02:00'
and:  TZ='Africa/Johannesburg' date -v-1d '+%Y-%m-%dT23:59:59+02:00'
(falling back to GNU date '-d "yesterday"' if BSD date flags fail).
Return {since, until, date_label} where date_label is the human-readable
"DD MMM YYYY" of yesterday in SAST.`,
  {
    label: 'window-probe',
    phase: 'Discover',
    schema: {
      type: 'object',
      properties: {
        since:      { type: 'string', description: 'ISO8601 SAST start of yesterday' },
        until:      { type: 'string', description: 'ISO8601 SAST end of yesterday' },
        date_label: { type: 'string', description: 'human-readable yesterday in SAST' },
      },
      required: ['since', 'until', 'date_label'],
    },
  },
)

const HARVEST_SINCE = args?.since || windowProbe.since
const HARVEST_UNTIL = args?.until || windowProbe.until
const HARVEST_DATE  = windowProbe.date_label
log(`Harvest window: ${HARVEST_SINCE} → ${HARVEST_UNTIL} (${HARVEST_DATE})`)

// ── Watermark — read what's already processed ─────────────────────────────

const watermarkProbe = await agent(
  `Read the meetings watermark file at ${WATERMARK_SH} if it exists.
Use Bash:  mkdir -p "$HOME/spock" && [ -f ${WATERMARK_SH} ] && cat ${WATERMARK_SH} || echo '{"processed_ids":[]}'
Parse the JSON. Return {processed_ids} where processed_ids is the array of
already-processed meeting source ids (Drive file ids, Plaud recording ids,
etc.). If the file doesn't exist or is malformed, return {processed_ids:[]}.`,
  {
    label: 'watermark-probe',
    phase: 'Discover',
    schema: {
      type: 'object',
      properties: {
        processed_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['processed_ids'],
    },
  },
)
const ALREADY_PROCESSED = new Set(watermarkProbe.processed_ids || [])
log(`Watermark: ${ALREADY_PROCESSED.size} meeting(s) already processed.`)

// ── Phase A: Discover ─────────────────────────────────────────────────────
// Drive auto-creates two artefacts per Meet recording: a video MP4 and a
// "Notes by Gemini" Google Doc transcript. We index on the transcript Doc
// because the body is text we can read directly via the Drive MCP. The MP4
// is logged but not fetched (saves bandwidth; transcript is sufficient).

const DISCOVER_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', enum: ['drive_meet', 'plaud'] },
    meetings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_id:        { type: 'string', description: 'stable id — Drive file id for Meet, Plaud recording id otherwise' },
          source:           { type: 'string', enum: ['drive_meet', 'plaud'] },
          title:            { type: 'string', description: 'event title or filename' },
          modified_iso:     { type: 'string', description: 'last-modified ISO8601 with TZ' },
          transcript_ref:   { type: 'string', description: 'Drive file id of the auto-transcript Doc, or Plaud transcript id' },
          recording_ref:    { type: 'string', description: 'Drive file id of the MP4 if known, blank otherwise' },
          drive_url:        { type: 'string', description: 'web URL to view the artefact' },
        },
        required: ['source_id', 'source', 'title', 'modified_iso', 'transcript_ref'],
      },
    },
  },
  required: ['source', 'meetings'],
}

const DRIVE_DISCOVER_PROMPT = `List yesterday's Google Meet meeting transcripts on Drive.

Window: ${HARVEST_SINCE} → ${HARVEST_UNTIL} (${HARVEST_DATE}).

Google Meet auto-generates two artefacts per recorded call, both filed in the
"Meet Recordings" folder of the host's My Drive:
  1. A video file:        "<event title> (YYYY-MM-DD at HH:MM AM/PM GMT+2) - Recording.mp4"
  2. A "Gemini notes" doc: "Notes by Gemini" or "<event title> - Transcript"
     — filename varies; the indicator is mimeType=application/vnd.google-apps.document
     and the parent folder is "Meet Recordings".

Procedure:

1. Call ${MCP_DRIVE}__list_recent_files with a reasonable page size (50 is
   plenty for one day). Filter the result to files whose modifiedTime falls
   within the harvest window.

2. If list_recent_files doesn't expose folder filtering, fall back to
   ${MCP_DRIVE}__search_files with a query like
     name contains 'Recording' OR name contains 'Notes by Gemini' OR name contains 'Transcript'
   in the modified window.

3. For each candidate transcript Doc, capture:
   - source_id      = Drive file id
   - source         = "drive_meet"
   - title          = best guess at the event title (strip the date/time suffix)
   - modified_iso   = file modifiedTime
   - transcript_ref = the Doc's file id (this is what Phase B fetches)
   - recording_ref  = the sibling MP4 file id if you can resolve it, else ""
   - drive_url      = webViewLink

4. If no candidates exist, return meetings: []. That's a valid day.

5. EXCLUDE any file whose Drive id is in this already-processed list — they
   were handled by a previous fire:
   ${JSON.stringify([...ALREADY_PROCESSED])}

${CONTEXT}`

const PLAUD_DISCOVER_PROMPT = `Plaud.ai discovery.

As of 2026-06-20 Plaud does not expose a public API; their integrations run
inside the Plaud app and push directly to Notion / Obsidian. Therefore THIS
PHASE IS A NO-OP placeholder until either (a) Plaud ships a public API, or
(b) Roger enables Plaud Drive Cloud Sync (which would surface recordings in
a "Plaud Cloud Sync" Drive folder discoverable by ${MCP_DRIVE}__search_files).

Procedure for v1: return meetings: [] and source: "plaud". Do not call any
MCP tool. Log only.

If/when Plaud Drive sync is enabled, swap this prompt to mirror the Drive
discovery prompt but filter on parent folder "Plaud Cloud Sync".

${CONTEXT}`

const DISCOVER_SOURCES = [
  { key: 'drive_meet', prompt: DRIVE_DISCOVER_PROMPT },
  { key: 'plaud',      prompt: PLAUD_DISCOVER_PROMPT },
]

const discoverResults = await parallel(DISCOVER_SOURCES.map(s => () =>
  agent(s.prompt, { label: `discover:${s.key}`, phase: 'Discover', schema: DISCOVER_SCHEMA })
))

const allMeetings = []
for (const r of discoverResults) {
  if (!r || !Array.isArray(r.meetings)) continue
  for (const m of r.meetings) {
    if (!m || !m.source_id) continue
    if (ALREADY_PROCESSED.has(m.source_id)) continue        // belt-and-suspenders
    allMeetings.push(m)
  }
}
log(`Discover: ${allMeetings.length} new meeting(s) (Drive Meet + Plaud combined).`)

if (allMeetings.length === 0) {
  log('Nothing to process. Exiting cleanly — watermark unchanged.')
  return {
    harvest_window: { since: HARVEST_SINCE, until: HARVEST_UNTIL, date_label: HARVEST_DATE },
    meetings_discovered: 0,
    notion_pages_created: 0,
    wall_files_written: 0,
    plaud_status: 'deferred',
  }
}

// ── Phase B + C combined per-meeting (no barrier) ─────────────────────────
// Roger's instruction: use a pipeline pattern between Discover→Transcripts→
// Summarise so individual meetings don't block on the slowest peer. We
// implement that by mapping each meeting to an async function that runs
// (B) fetch transcript → (C) summarise back-to-back, then `parallel()` the
// whole set. Each meeting flows through B+C independently.

phase('Transcripts')

const TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    source_id:    { type: 'string' },
    text:         { type: 'string', description: 'the transcript body, plain text or close to it' },
    fetched_ok:   { type: 'boolean' },
    fetch_error:  { type: 'string', description: 'error message if fetched_ok=false' },
  },
  required: ['source_id', 'text', 'fetched_ok'],
}

const SUMMARISE_SCHEMA = {
  type: 'object',
  properties: {
    source_id:    { type: 'string' },
    title:        { type: 'string', description: 'cleaned meeting title' },
    summary:      { type: 'string', description: '3-6 sentence executive summary' },
    attendees: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:     { type: 'string' },
          org:      { type: 'string', description: 'organisation if inferable, else ""' },
          is_roger: { type: 'boolean' },
        },
        required: ['name', 'is_roger'],
      },
    },
    counterparty: { type: 'string', description: 'the primary external party (company or person), or "internal" if this is a Chronos-internal meeting' },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          who:            { type: 'string', description: 'attendee name responsible' },
          what:           { type: 'string', description: 'one-sentence action' },
          due:            { type: 'string', description: 'ISO date if specified in the transcript, else ""' },
          owner_is_roger: { type: 'boolean', description: 'true if Roger owns this action — drives Front Page priority' },
        },
        required: ['who', 'what', 'owner_is_roger'],
      },
    },
    sensitive_classification: {
      type: 'object',
      properties: {
        is_sensitive: { type: 'boolean', description: 'true → wall lane only' },
        reason:       { type: 'string', description: 'why (board/IC/MNPI/etc.) or "" if not sensitive' },
        keywords_hit: { type: 'array', items: { type: 'string' }, description: 'specific sensitive-keyword matches from SENSITIVE_KEYWORDS' },
      },
      required: ['is_sensitive', 'reason', 'keywords_hit'],
    },
  },
  required: ['source_id', 'title', 'summary', 'attendees', 'counterparty', 'action_items', 'sensitive_classification'],
}

function fetchTranscriptPrompt(m) {
  return `Fetch the transcript body for one meeting.

Meeting:
  source_id:      ${m.source_id}
  source:         ${m.source}
  title:          ${JSON.stringify(m.title)}
  transcript_ref: ${m.transcript_ref}
  modified_iso:   ${m.modified_iso}

If source === "drive_meet":
  1. Call ${MCP_DRIVE}__read_file_content with the transcript_ref file id.
  2. If that returns Google-Docs structured content, flatten to plain text
     (paragraphs joined by newlines, speaker labels preserved).
  3. If the file is empty or refuses, fall back to
     ${MCP_DRIVE}__download_file_content to grab it as plain text.

If source === "plaud":
  (DEFERRED — should not appear in v1; return fetched_ok:false with
   fetch_error: "plaud deferred — no public API as of 2026-06".)

Return {source_id: "${m.source_id}", text, fetched_ok, fetch_error}.
Truncate text to 80k characters maximum — anything longer should be
summarised in chunks downstream, but for v1 truncation is acceptable.

${CONTEXT}`
}

function summarisePrompt(m, transcript) {
  return `Summarise one meeting and extract action items.

Meeting: ${JSON.stringify({ source_id: m.source_id, source: m.source, title: m.title, modified_iso: m.modified_iso })}

Transcript (verbatim, may include Gemini-generated speaker labels):
---
${transcript.text || '(transcript empty — likely fetch failure; emit best-effort placeholder)'}
---

Produce a structured summary. Apply these rules:

1. ATTENDEES — detect everyone who spoke or was @-mentioned. Mark Roger
   based on any of these aliases: ${JSON.stringify(ROGER_IDS.name_aliases.concat(ROGER_IDS.email_aliases))}.

2. COUNTERPARTY — the primary external party. If the meeting is internal
   (only Chronos people) return "internal". If it's a board / IC meeting
   for a portfolio company, the counterparty is that company.

3. ACTION ITEMS — extract every commitment. For each, who/what/due. Set
   owner_is_roger=true when the owner matches a Roger alias. Be generous:
   "Roger to send the memo by Friday" → who="Roger Grobler", owner_is_roger=true.
   If the transcript is a placeholder or empty, return action_items: [].

4. SENSITIVE CLASSIFICATION — set is_sensitive=true if ANY of the following:
   • The title or transcript contains a keyword from this list:
     ${JSON.stringify(SENSITIVE_KEYWORDS)}
   • The meeting is identified as a board meeting, IC meeting, or
     valuation discussion for a portfolio company.
   • The counterparty matches one of: ${JSON.stringify(Object.keys(WALL_COUNTERPARTY_SLUGS))}
     AND the context is board/IC/private.
   • The transcript references inside information, MNPI, a closed
     trading period, or pre-announcement material.
   Populate keywords_hit with the exact SENSITIVE_KEYWORDS that matched
   (case-insensitive substring). Reason: short human-readable explanation.

   If is_sensitive=true the meeting will NEVER hit Notion and NEVER hit
   the repo. It is written ONLY to the wall-side ${WALL_BASE}/<slug>/meetings/
   directory. So be honest in this flag — false negatives are worse than
   false positives.

5. SUMMARY — 3-6 sentences. Decisions taken, key positions, follow-ups.
   No flattery. No process notes. No "the team discussed". Specific.

${CONTEXT}`
}

// Per-meeting pipeline: B (fetch transcript) → C (summarise) without barrier.
const processedMeetings = await parallel(allMeetings.map((m, idx) => async () => {
  const transcript = await agent(fetchTranscriptPrompt(m), {
    label: `transcript:${m.source_id}`,
    phase: 'Transcripts',
    schema: TRANSCRIPT_SCHEMA,
  })

  if (!transcript || !transcript.fetched_ok) {
    log(`[${idx + 1}/${allMeetings.length}] transcript fetch failed for ${m.title} (${m.source_id}): ${transcript?.fetch_error || 'unknown error'} — skipping summarise.`)
    return { meeting: m, transcript, summary: null, error: 'transcript_fetch_failed' }
  }

  const summary = await agent(summarisePrompt(m, transcript), {
    label: `summarise:${m.source_id}`,
    phase: 'Summarise',
    schema: SUMMARISE_SCHEMA,
  })

  return { meeting: m, transcript, summary, error: null }
}))

phase('Summarise')  // marker — the actual summarise calls were folded into the per-meeting pipeline above
log(`Summarise: ${processedMeetings.filter(p => p?.summary).length}/${allMeetings.length} meeting(s) summarised cleanly.`)

// ── Phase D: WALL classify ────────────────────────────────────────────────
// Belt-and-suspenders: trust the agent's is_sensitive flag, but also re-run
// the SENSITIVE_KEYWORDS scan ourselves on the summary + title + counterparty
// so a model-side miss doesn't leak MNPI into Notion. If EITHER side flags
// sensitive, the meeting goes wall-side.

phase('WALLClassify')

function classifyWall(p) {
  if (!p || !p.summary) return { wall: false, reason: 'no summary' }
  const s = p.summary
  const blob = [
    s.title || '',
    s.summary || '',
    s.counterparty || '',
    p.meeting.title || '',
  ].join(' ').toLowerCase()

  // Agent-side flag
  const agentFlag = !!(s.sensitive_classification && s.sensitive_classification.is_sensitive)

  // Local keyword pass
  const hits = SENSITIVE_KEYWORDS.filter(k => blob.includes(k.toLowerCase()))

  // Counterparty pass — if counterparty is in WALL_COUNTERPARTY_SLUGS AND
  // the agent's reason mentions board/IC/private, it's sensitive.
  const cpKey = (s.counterparty || '').trim().toLowerCase()
  const cpIsWalled = !!WALL_COUNTERPARTY_SLUGS[cpKey] &&
    /board|ic\b|private|valuation|mnpi/i.test(s.sensitive_classification?.reason || s.summary || '')

  const wall = agentFlag || hits.length > 0 || cpIsWalled

  const slug = WALL_COUNTERPARTY_SLUGS[cpKey] ||
    (cpKey ? cpKey.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'unknown')

  return {
    wall,
    reason: wall
      ? `agent_flag=${agentFlag} · keyword_hits=${JSON.stringify(hits)} · cp_walled=${cpIsWalled}`
      : 'no sensitive signal',
    slug,
    keyword_hits: hits,
  }
}

const classified = processedMeetings.map(p => ({ ...p, wall: classifyWall(p) }))
const wallSide  = classified.filter(p => p.wall?.wall)
const repoSide  = classified.filter(p => p.summary && !p.wall?.wall)

log(`WALL classify: ${wallSide.length} sensitive (wall-side), ${repoSide.length} non-sensitive (Notion-bound), ${classified.length - wallSide.length - repoSide.length} skipped (no summary).`)

// Write each wall-side meeting to ~/spock-calibration/<slug>/meetings/<date>-<title>.md
// using Bash + heredoc. Never inside the repo, never to Notion.
let wallFilesWritten = 0
for (const p of wallSide) {
  const slug = p.wall.slug || 'unknown'
  const safeTitle = (p.summary.title || p.meeting.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const datePrefix = (p.meeting.modified_iso || HARVEST_SINCE).slice(0, 10)
  const filename = `${datePrefix}-${safeTitle || 'untitled'}.md`
  // WALL_BASE_SH is the bash-quoted form `"$HOME/spock-calibration"`. To
  // append a subpath we strip the trailing `"`, append, and re-quote — this
  // keeps $HOME expansion working inside the agent's bash command.
  const dirShQuoted  = `"$HOME/spock-calibration/${slug}/meetings"`
  const fileShQuoted = `"$HOME/spock-calibration/${slug}/meetings/${filename}"`

  const writeRes = await agent(
    `Write a wall-side meeting minutes file. This file must land OUTSIDE any
git repository — specifically inside ${WALL_BASE}/${slug}/meetings/. Never
under ~/code/, never under ~/spock/ (which contains repos). The
~/spock-calibration/ tree is the wall-side root and is .gitignored at every
level.

Steps (use Bash):
  1. mkdir -p ${dirShQuoted}
  2. Write the file ${fileShQuoted} with the markdown body below.
     Use a single \`cat > "$PATH" <<'WALL_EOF' ... WALL_EOF\` heredoc.
  3. Confirm the file exists and print its size.

Markdown body to write:

# ${p.summary.title || p.meeting.title}

- Date: ${p.meeting.modified_iso}
- Counterparty: ${p.summary.counterparty}
- Source: ${p.meeting.source} (${p.meeting.source_id})
- Sensitive: YES — ${p.wall.reason}
- Drive URL: ${p.meeting.drive_url || ''}

## Attendees
${(p.summary.attendees || []).map(a => `- ${a.name}${a.org ? ' (' + a.org + ')' : ''}${a.is_roger ? ' — Roger' : ''}`).join('\n')}

## Summary
${p.summary.summary}

## Action items
${(p.summary.action_items || []).map(a => `- [ ] **${a.who}** — ${a.what}${a.due ? ' (due ' + a.due + ')' : ''}${a.owner_is_roger ? ' · ROGER OWNS' : ''}`).join('\n')}

## Sensitive classification
- is_sensitive: true
- reason: ${p.summary.sensitive_classification?.reason || p.wall.reason}
- keywords_hit: ${JSON.stringify(p.summary.sensitive_classification?.keywords_hit || p.wall.keyword_hits)}

---
This file is wall-side. Do not commit. Do not paste into the Ledger,
Notion, or any partner-facing artefact. See [[project-opa-private-calibration]]
for the wall doctrine.

Return {written: true, path, bytes}.
${CONTEXT}`,
    {
      label: `wall-write:${p.meeting.source_id}`,
      phase: 'WALLClassify',
      schema: {
        type: 'object',
        properties: {
          written: { type: 'boolean' },
          path:    { type: 'string' },
          bytes:   { type: 'number' },
        },
        required: ['written'],
      },
    },
  )

  if (writeRes?.written) {
    wallFilesWritten++
    log(`Wall-write OK: ${writeRes.path} (${writeRes.bytes} bytes) — ${p.summary.counterparty}`)
  } else {
    log(`Wall-write FAILED for ${p.meeting.source_id} — surfacing for manual triage.`)
  }
}

// ── Phase E: Write Notion (non-sensitive only) ────────────────────────────

phase('WriteNotion')

// Step 1: ensure the "Meeting Minutes" Notion DB exists. If not, create it.
const dbProbe = await agent(
  `Find or create the Notion "${NOTION_DB_TITLE}" database.

Procedure:

1. Call ${MCP_NOTION}__notion-search with query="${NOTION_DB_TITLE}" and
   restrict to data sources / databases. Look for a database whose title
   exactly matches "${NOTION_DB_TITLE}".

2. If found: return {existed: true, database_id, data_source_id}.

3. If NOT found: call ${MCP_NOTION}__notion-create-database with the
   following schema:

   Title: ${NOTION_DB_TITLE}
   Parent: prefer Roger's workspace root, or his "Spock Second Brain"
   teamspace if it exists.

   Properties:
     • Title          (title)         — meeting title
     • Date           (date)
     • Counterparty   (rich_text)
     • Source         (select: drive_meet, plaud, manual)
     • Source ID      (rich_text)     — Drive file id or Plaud id
     • Drive URL      (url)
     • Summary        (rich_text)
     • Attendees      (rich_text)     — flat list "Name (Org), Name (Org)"
     • Action items   (rich_text)     — flat checklist "[ ] who — what (due)"
     • Owner: Roger?  (checkbox)      — true iff any action_item has owner_is_roger
     • Open?          (checkbox)      — default true; build-ledger flips when actions land in Done DB
     • Created        (created_time)

   Return {existed: false, database_id, data_source_id}.

4. If creation fails (permission, etc.), return {existed: false,
   database_id: "", data_source_id: "", error}. The workflow will log
   this and skip Notion writes for this fire.

${CONTEXT}`,
  {
    label: 'notion-db-probe',
    phase: 'WriteNotion',
    schema: {
      type: 'object',
      properties: {
        existed:         { type: 'boolean' },
        database_id:     { type: 'string' },
        data_source_id:  { type: 'string' },
        error:           { type: 'string' },
      },
      required: ['existed', 'database_id'],
    },
  },
)

if (!dbProbe.database_id) {
  log(`Notion "Meeting Minutes" DB unavailable (${dbProbe.error || 'unknown'}) — skipping Notion writes for this fire. Wall-side writes already completed: ${wallFilesWritten}.`)
} else {
  log(`Notion DB ${dbProbe.existed ? 'found' : 'CREATED'}: ${dbProbe.database_id}`)
}

let notionPagesCreated = 0
const writtenIdsForWatermark = []

if (dbProbe.database_id) {
  for (const p of repoSide) {
    const ownerIsRoger = (p.summary.action_items || []).some(a => a.owner_is_roger)

    const pageRes = await agent(
      `Create one page in the Notion "${NOTION_DB_TITLE}" database.

Database id: ${dbProbe.database_id}
Data source id: ${dbProbe.data_source_id}

Properties to set:
  Title:          ${JSON.stringify(p.summary.title || p.meeting.title)}
  Date:           ${p.meeting.modified_iso}
  Counterparty:   ${JSON.stringify(p.summary.counterparty)}
  Source:         ${p.meeting.source}
  Source ID:      ${p.meeting.source_id}
  Drive URL:      ${p.meeting.drive_url || ''}
  Summary:        ${JSON.stringify(p.summary.summary)}
  Attendees:      ${JSON.stringify((p.summary.attendees || []).map(a => a.name + (a.org ? ' (' + a.org + ')' : '')).join(', '))}
  Action items:   ${JSON.stringify((p.summary.action_items || []).map(a => `[ ] ${a.who} — ${a.what}${a.due ? ' (due ' + a.due + ')' : ''}${a.owner_is_roger ? ' · ROGER OWNS' : ''}`).join('\n'))}
  Owner: Roger?:  ${ownerIsRoger}
  Open?:          true

Page body (children blocks):
  • H2 "Summary" + paragraph(summary)
  • H2 "Attendees" + bulleted list of attendees
  • H2 "Action items" + to-do list, one per action_item, with the to-do's
    rich_text content being "<who> — <what>" and "(due <date>)" suffix.
    Mark each to_do unchecked.
  • H2 "Transcript link" + paragraph with the Drive URL.

Use ${MCP_NOTION}__notion-create-pages. Return {created: true, page_id, page_url}.
If creation fails (permission, schema mismatch, etc.), return {created: false, error}.

${CONTEXT}`,
      {
        label: `notion-write:${p.meeting.source_id}`,
        phase: 'WriteNotion',
        schema: {
          type: 'object',
          properties: {
            created:  { type: 'boolean' },
            page_id:  { type: 'string' },
            page_url: { type: 'string' },
            error:    { type: 'string' },
          },
          required: ['created'],
        },
      },
    )

    if (pageRes?.created) {
      notionPagesCreated++
      writtenIdsForWatermark.push(p.meeting.source_id)
      log(`Notion page OK: ${pageRes.page_url || pageRes.page_id} — ${p.summary.title}`)
    } else {
      log(`Notion page FAILED for ${p.meeting.source_id}: ${pageRes?.error || 'unknown'} — will retry next fire (NOT added to watermark).`)
    }
  }
}

// Wall-side writes also get added to the watermark — once a sensitive
// meeting has been written wall-side, we never want to re-summarise it
// (cost + risk of duplicating MNPI extracts).
for (const p of wallSide) {
  writtenIdsForWatermark.push(p.meeting.source_id)
}

// ── Watermark update ──────────────────────────────────────────────────────

if (writtenIdsForWatermark.length > 0) {
  const newWatermark = {
    processed_ids: [...new Set([...(watermarkProbe.processed_ids || []), ...writtenIdsForWatermark])],
    last_updated_sast: new Date().toISOString(),
    last_fire_summary: {
      window: { since: HARVEST_SINCE, until: HARVEST_UNTIL, date_label: HARVEST_DATE },
      discovered: allMeetings.length,
      notion_pages_created: notionPagesCreated,
      wall_files_written: wallFilesWritten,
    },
  }

  await agent(
    `Update the meetings watermark file.

Path: ${WATERMARK_SH}

Steps (use Bash):
  1. mkdir -p "$HOME/spock"
  2. Write the JSON below to ${WATERMARK_SH} using a heredoc.
  3. Print the new file's byte size.

JSON to write (verbatim):
${JSON.stringify(newWatermark, null, 2)}

Return {written: true, bytes}.

${CONTEXT}`,
    {
      label: 'watermark-update',
      phase: 'WriteNotion',
      schema: {
        type: 'object',
        properties: {
          written: { type: 'boolean' },
          bytes:   { type: 'number' },
        },
        required: ['written'],
      },
    },
  )

  log(`Watermark updated — ${newWatermark.processed_ids.length} processed ids on file.`)
}

return {
  harvest_window: { since: HARVEST_SINCE, until: HARVEST_UNTIL, date_label: HARVEST_DATE },
  meetings_discovered: allMeetings.length,
  meetings_summarised: processedMeetings.filter(p => p?.summary).length,
  notion_pages_created: notionPagesCreated,
  wall_files_written: wallFilesWritten,
  plaud_status: 'deferred',
  notion_db_id: dbProbe.database_id || null,
  notion_db_existed: !!dbProbe.existed,
}
