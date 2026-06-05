#!/usr/bin/env node
// verify-build.mjs — the Ledger publish gate.
//
// The dashboard's interactivity lives entirely in inline <script> blocks. A single
// stray character from the apply phase (a find/replace that splices HTML into a JS
// function — see the v1.34 recalibrate() regression) makes a whole block fail to
// parse, which silently kills EVERY button while the page still renders. This gate
// catches that before anything is published: if the JS won't parse, or the core
// handlers aren't defined, it exits non-zero and the caller must keep the last-good
// edition rather than overwrite the live page with a dead one.
//
// Usage:  node scripts/verify-build.mjs <path-to-html>
// Exit:   0 = safe to publish · 1 = build broken (do NOT publish) · 2 = usage error

import fs from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
if (!file) { console.error('usage: verify-build.mjs <html-file>'); process.exit(2); }

let html;
try { html = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`✗ cannot read ${file}: ${e.message}`); process.exit(2); }

let problems = 0;

// 1) Every non-empty inline <script> block must parse as valid JS.
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
let checked = 0;
blocks.forEach((body, i) => {
  if (!body.trim()) return;               // skip empty / external-src script tags
  checked++;
  try { new vm.Script(body, { filename: `script-block-${i}.js` }); }
  catch (e) { problems++; console.error(`✗ <script> block ${i} fails to parse: ${e.message}`); }
});

// 2) The core interactive handlers must be defined somewhere in the page.
const required = ['toggleDone', 'toggleComment', 'saveComment', 'sendToClaude'];
const missing = required.filter(fn =>
  !new RegExp(`(?:window\\.)?${fn}\\s*=\\s*function|function\\s+${fn}\\b`).test(html));
if (missing.length) { problems++; console.error(`✗ missing handler definition(s): ${missing.join(', ')}`); }

// 3) Cheap structural sanity (matches the old apply-phase checks, kept here so the gate owns them).
if (html.length < 50_000) { problems++; console.error(`✗ file suspiciously small: ${html.length} bytes`); }
if (/Kevin Hardy/.test(html)) { problems++; console.error('✗ contains stray placeholder "Kevin Hardy"'); }

if (problems) {
  console.error(`\nBUILD GATE FAILED — ${problems} problem(s). Refusing to publish; keep the last-good edition.`);
  process.exit(1);
}
console.log(`✓ build gate passed — ${checked} script block(s) parse, ${required.length} core handlers present, ${html.length} bytes`);
