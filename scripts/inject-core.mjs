#!/usr/bin/env node
// inject-core.mjs — restore the dashboard's frozen JavaScript.
//
// The Ledger's interactivity (toggleDone, toggleComment, saveComment, sendToClaude,
// the North-Star spine, drag/drop, the payload modal) is ENTIRELY static across
// fires — it carries no per-edition content. Yet the apply phase, when it hand-edits
// current.html, periodically splices HTML into a JS function and silently breaks a
// whole <script> block (the recurring v1.34 recalibrate() regression). The cure is to
// stop trusting the inherited JS at all: every fire, overwrite all inline <script>
// blocks with the canonical, gate-passing copy in templates/dashboard-core.json.
//
// The apply phase runs this FIRST (so the page starts from known-good JS) and is told
// never to edit anything between <script> and </script>. verify-build.mjs is the
// backstop if anything still slips through.
//
// Usage:  node scripts/inject-core.mjs <path-to-html> [path-to-core-json]
// Exit:   0 = injected · 1 = block-count mismatch / error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
const coreFile = process.argv[3] || path.join(__dirname, '..', 'templates', 'dashboard-core.json');
if (!target) { console.error('usage: inject-core.mjs <html-file> [core-json]'); process.exit(1); }

let core;
try { core = JSON.parse(fs.readFileSync(coreFile, 'utf8')); }
catch (e) { console.error(`✗ cannot read core template ${coreFile}: ${e.message}`); process.exit(1); }

let html;
try { html = fs.readFileSync(target, 'utf8'); }
catch (e) { console.error(`✗ cannot read ${target}: ${e.message}`); process.exit(1); }

let i = 0;
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
  const open = m.match(/<script\b[^>]*>/i)[0];
  const body = m.slice(open.length, m.length - '</script>'.length);
  if (!body.trim()) return m;                 // leave empty / external-src tags alone
  const repl = i < core.length ? `${open}${core[i]}</script>` : m;
  i++;
  return repl;
});

if (i !== core.length) {
  console.error(`✗ block-count mismatch: page has ${i} inline <script> block(s), template has ${core.length}. NOT writing — investigate before publishing.`);
  process.exit(1);
}

fs.writeFileSync(target, html);
console.log(`✓ injected ${core.length} frozen script block(s) into ${path.basename(target)}`);
