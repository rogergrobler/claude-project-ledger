#!/usr/bin/env node
// privacy-gate.mjs — the Ledger PRIVACY gate. Runs on current.html immediately
// before publish, after the build gate and before the R2 mirror.
//
// WHY THIS EXISTS
// The ledger is served to a second reader (Isa, on the password-protected Worker
// surface). On 3 Aug 2026 a highly personal family WhatsApp thread was swept into
// the Done tab and the audit footer and went live. The model-side rule in
// `ledger-now` (Step 3d) is the first line of defence, but a rule a model can
// forget is not a control. This script is the control: if blocked content is
// present at publish time it is STRIPPED, and if it cannot be stripped the gate
// exits non-zero so the caller skips the publish rather than shipping it.
//
// THE BLOCKLIST NEVER LIVES IN THIS REPO. It holds real names of real people, and
// this repo is a public Claude Code marketplace. It lives machine-local at
//   ~/.project_ledger/private-filter.json
// See templates/private-filter.example.json for the shape.
//
// WHAT GETS STRIPPED
//   · any single-line <li> whose text matches               (Done-tab rows)
//   · any <div class="card …"> block whose text matches     (Front Page cards)
//   · any <div class="si-row"> block whose text matches     (Isa / People rows)
//   · any `·`-separated segment of the audit footer         (the long tail — this
//     is where the 3 Aug leak mostly lived, and it is never caught by card-level
//     reasoning because it is one 145 KB line)
//
// Matching is word-boundary and case-insensitive. `allowTerms` rescues legitimate
// collisions: a blocked first name must not eat a business counterparty whose
// surname or full name merely contains it, which a naive substring match would do.
//
// Usage:  node scripts/privacy-gate.mjs <html-file> [--check] [--filter <path>]
//           --check   report only, write nothing (exit 1 if blocked content found)
// Exit:   0 = clean (or nothing to do) · 1 = blocked content survived / write failed
//         2 = usage error
// A missing filter file is NOT a failure — it warns loudly and exits 0, so a fresh
// machine can still publish.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const check = argv.includes('--check');
const fi = argv.indexOf('--filter');
const filterPath = fi !== -1 ? argv[fi + 1]
  : path.join(os.homedir(), '.project_ledger', 'private-filter.json');

if (!file) {
  console.error('usage: privacy-gate.mjs <html-file> [--check] [--filter <path>]');
  process.exit(2);
}

let html;
try { html = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`✗ cannot read ${file}: ${e.message}`); process.exit(2); }

let filter;
try { filter = JSON.parse(fs.readFileSync(filterPath, 'utf8')); }
catch (e) {
  console.log(`⚠ privacy gate: no filter at ${filterPath} (${e.code || e.message}).`);
  console.log('  Publishing UNFILTERED. Create the file to arm the gate — see');
  console.log('  templates/private-filter.example.json in the repo for the shape.');
  process.exit(0);
}

// Entries starting with "//" are comments — the example template uses them to
// document each list in place, and a copied-then-edited file keeps them.
const list = k => (filter[k] || []).filter(s => typeof s === 'string' && !s.startsWith('//'));

const blockTerms  = list('blockTerms');
const blockCardIds = list('blockCardIds');
const allowTerms  = list('allowTerms');
// A term that is only sensitive in a personal context: blocked when the same unit
// also carries one of these markers, left alone otherwise. Keeps a brother's name
// in a board-intro card while removing it from a family dispute.
const contextTerms = list('contextTerms');
const personalMarkers = list('personalMarkers');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = terms => terms.length
  ? new RegExp(`\\b(?:${terms.map(esc).join('|')})\\b`, 'i') : null;

const BLOCK   = wordRe(blockTerms);
const CONTEXT = wordRe(contextTerms);
const MARKER  = personalMarkers.length
  ? new RegExp(personalMarkers.map(esc).join('|'), 'i') : null;
const CARDID  = blockCardIds.length
  ? new RegExp(blockCardIds.map(esc).join('|'), 'i') : null;
const ALLOW   = allowTerms.length
  ? new RegExp(`\\b(?:${allowTerms.map(esc).join('|')})\\b`, 'ig') : null;

// Entities collapse to a SPACE, never to nothing: "Name&rsquo;s" must normalise
// to "Name s", not "Names", or the \b-anchored block term silently misses it.
// (That exact bug let two names through the first run of this gate.)
const deEntity = s => s
  .replace(/&middot;/g, ' · ')
  .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, ' ')
  .replace(/\s+/g, ' ');

// Rendered text of a unit — tags dropped. Used for the strip decision.
const plain = s => {
  const t = deEntity(s.replace(/<[^>]+>/g, ' '));
  // Blank out the allow-listed names first so they cannot trip a block term.
  return ALLOW ? t.replace(ALLOW, ' ') : t;
};

// Everything a reader could reach — tags KEPT, so data-title="…", data-id="…"
// and inline JS string literals are scanned too. Used for the final survivor
// check only: a hard-blocked name hiding in an attribute still counts as a leak,
// and a false alarm here blocks a publish (safe) rather than shipping one (not).
const raw = s => {
  const t = deEntity(s);
  return ALLOW ? t.replace(ALLOW, ' ') : t;
};

const sensitive = text => {
  if (CARDID && CARDID.test(text)) return true;
  if (BLOCK && BLOCK.test(text)) return true;
  if (CONTEXT && MARKER && CONTEXT.test(text) && MARKER.test(text)) return true;
  return false;
};

const removed = [];
let lines = html.split('\n');

// ── Block-level units: <div class="card …"> and <div class="si-row"> ─────────
// Walk forward from the opener counting <div opens vs </div> closes to find the
// matching close, then test the whole unit's text.
const openerRe = /<div[^>]*class="(?:card\b[^"]*|si-row)"/;
for (let i = 0; i < lines.length; i++) {
  if (!openerRe.test(lines[i])) continue;
  let depth = 0, end = i;
  for (let j = i; j < lines.length; j++) {
    depth += (lines[j].match(/<div\b/g) || []).length;
    depth -= (lines[j].match(/<\/div>/g) || []).length;
    end = j;
    if (depth <= 0) break;
  }
  const unit = lines.slice(i, end + 1).join('\n');
  if (sensitive(plain(unit))) {
    removed.push({ kind: 'block', line: i + 1, text: plain(unit).trim().slice(0, 160) });
    for (let j = i; j <= end; j++) lines[j] = '';
    i = end;
  }
}

// ── Single-line <li> rows (the Done tab) ─────────────────────────────────────
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!l.trimStart().startsWith('<li>')) continue;
  if (sensitive(plain(l))) {
    removed.push({ kind: 'li', line: i + 1, text: plain(l).trim().slice(0, 160) });
    lines[i] = '';
  }
}

// ── The audit footer: segment-level scrub ───────────────────────────────────
// One line can be >100 KB of `·`-separated audit prose spanning many editions.
// Dropping the line would destroy the whole audit trail, so scrub per segment
// and re-emit any markup the dropped segment carried (a stray </span> or <br/>
// inside a dropped segment would otherwise unbalance the document).
const SEG = /(\s*(?:&middot;|·)\s*|(?<=[.;])\s+)/;
const scrubSegments = (line, lineNo) => {
  const parts = line.split(SEG);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i] ?? '';
    const delim = parts[i + 1] ?? '';
    if (seg && sensitive(plain(seg))) {
      removed.push({ kind: 'segment', line: lineNo, text: plain(seg).trim().slice(0, 160) });
      out.push((seg.match(/<[^>]+>/g) || []).join(''));   // keep markup, drop text
    } else {
      out.push(seg + delim);
    }
  }
  return out.join('');
};

for (let i = 0; i < lines.length; i++) {
  if (lines[i].length < 2000) continue;                    // only the mega-lines
  if (!/footer-text|audit/i.test(lines[i])) continue;
  lines[i] = scrubSegments(lines[i], i + 1);
}

let out = lines.join('\n').replace(/(?:&middot;\s*){2,}/g, '&middot; ');

// ── Verify nothing survived ─────────────────────────────────────────────────
const survivors = [];
for (const [i, l] of out.split('\n').entries()) {
  const t = raw(l);
  if (!t.trim()) continue;
  if (CARDID && CARDID.test(t)) survivors.push(`line ${i + 1}: blocked card id`);
  else if (BLOCK && BLOCK.test(t)) survivors.push(`line ${i + 1}: ${t.match(BLOCK)[0]}`);
}

const label = check ? 'privacy gate (check)' : 'privacy gate';
console.log(`${label} — ${removed.length} unit(s) stripped, ${survivors.length} survivor(s)`);
for (const r of removed.slice(0, 40)) console.log(`  – [${r.kind} L${r.line}] ${r.text}`);
if (removed.length > 40) console.log(`  – … ${removed.length - 40} more`);

if (survivors.length) {
  console.error('\nPRIVACY GATE FAILED — blocked content still present after stripping:');
  for (const s of survivors.slice(0, 20)) console.error(`  ✗ ${s}`);
  console.error('Do NOT publish. Fix the source, or widen the blocklist and re-run.');
  process.exit(1);
}

if (check) {
  console.log('✓ no blocked content would survive (nothing written — --check)');
  process.exit(0);
}

if (removed.length) {
  try { fs.writeFileSync(file, out, 'utf8'); }
  catch (e) { console.error(`✗ cannot write ${file}: ${e.message}`); process.exit(1); }
  console.log(`✓ ${path.basename(file)} rewritten clean (${html.length} → ${out.length} bytes)`);
} else {
  console.log('✓ clean — nothing to strip');
}
process.exit(0);
