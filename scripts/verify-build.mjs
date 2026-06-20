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
// CHECKS (each a separate test — first failure does NOT short-circuit; the gate
// reports every problem so a single run gives the full picture):
//   T1  JS syntax — every non-empty <script> block parses as valid JS
//   T2  Required handlers — toggleDone, toggleComment, saveComment, sendToClaude,
//        showTab are defined somewhere on the page
//   T3  Handler coverage — every onclick="X(...)" / oninput="X(...)" handler
//        names a function that is defined in some script block, in the HTML, or
//        is a standard DOM API. Catches v1.47-class regressions where 8 tabs
//        called showTab() but the frozen template never defined it.
//   T4  Tab consistency — every <button class="tab-btn" id="tab-NAME"> has a
//        matching <div class="tab-panel" id="panel-NAME"> and vice versa, and
//        all tab onclick handlers reference showTab.
//   T5  Cheap structural sanity — file size, no stray placeholder names.
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

const results = [];                         // { test, passed, message }
const pass = (test, message) => results.push({ test, passed: true,  message });
const fail = (test, message) => results.push({ test, passed: false, message });

// Collect inline <script> bodies once for reuse.
const scriptBodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

// ── T1: JS syntax ─────────────────────────────────────────────────────────
{
  let checked = 0;
  let badBlocks = [];
  scriptBodies.forEach((body, i) => {
    if (!body.trim()) return;
    checked++;
    try { new vm.Script(body, { filename: `script-block-${i}.js` }); }
    catch (e) { badBlocks.push(`block ${i}: ${e.message.split('\n')[0]}`); }
  });
  if (badBlocks.length) fail('T1 JS syntax', `${badBlocks.length} block(s) failed to parse:\n   - ` + badBlocks.join('\n   - '));
  else                  pass('T1 JS syntax', `${checked} <script> block(s) parse cleanly`);
}

// ── T2: Required handlers ─────────────────────────────────────────────────
{
  const required = ['toggleDone', 'toggleComment', 'saveComment', 'sendToClaude', 'showTab', 'cardDone', 'cardDefer', 'cardDelegate', 'cardDelete', 'cardRecur'];
  const missing = required.filter(fn =>
    !new RegExp(`(?:window\\.)?${fn}\\s*=\\s*function|function\\s+${fn}\\b`).test(html));
  if (missing.length) fail('T2 Required handlers', `missing: ${missing.join(', ')}`);
  else                pass('T2 Required handlers', `all ${required.length} present: ${required.join(', ')}`);
}

// ── T3: Handler coverage (every onclick="X(...)" / oninput="X(...)" / etc. ─
// Catches the v1.47-class regression where 8 tab buttons called showTab() but
// the frozen template never defined it. Also covers oninput, onchange,
// onsubmit, ondrop, etc.
{
  const handlerAttrs = ['onclick','oninput','onchange','onsubmit','onkeydown','onkeyup','ondrop','ondragstart','ondragover','onblur','onfocus','onmouseover','onmouseout','ontouchstart'];
  const all = new Set();
  for (const attr of handlerAttrs) {
    const re = new RegExp(`${attr}=["']([^"']+)["']`, 'g');
    let m;
    while ((m = re.exec(html))) {
      // Pull function NAMES from the attribute body — match `name(` patterns.
      const fnRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
      let fm;
      while ((fm = fnRe.exec(m[1]))) all.add(fm[1]);
    }
  }
  // Standard DOM / window globals AND JS keywords — always available.
  const builtins = new Set([
    // DOM / window
    'event','this','window','document','localStorage','console','self','parent','top',
    'alert','confirm','prompt','setTimeout','setInterval','clearTimeout','clearInterval',
    'requestAnimationFrame','Date','Math','JSON','Number','String','Boolean','Array','Object',
    'navigator','encodeURIComponent','decodeURIComponent','open','focus','blur',
    'String.fromCharCode','parseInt','parseFloat','isNaN','isFinite','Promise','Map','Set','WeakMap','WeakSet','Symbol','Error','RegExp',
    // JS reserved words / keywords that the regex picks up as `KEYWORD(`
    'if','else','for','while','do','switch','case','default','break','continue',
    'return','throw','try','catch','finally','function','var','let','const',
    'new','delete','typeof','instanceof','in','of','void','true','false','null',
    'undefined','async','await','yield','class','extends','super','import','export',
  ]);
  const missing = [];
  for (const name of all) {
    if (builtins.has(name)) continue;
    // accept any of: `function NAME(`, `NAME =`, `window.NAME =`, `var NAME =`
    const defined = new RegExp(
      `(?:function\\s+${name}\\b)|(?:\\bwindow\\.${name}\\s*=)|(?:\\b(?:var|let|const)\\s+${name}\\s*=)|(?:\\b${name}\\s*=\\s*function)`
    ).test(html);
    if (!defined) missing.push(name);
  }
  if (missing.length) fail('T3 Handler coverage', `${missing.length} handler(s) referenced but never defined: ${missing.join(', ')}`);
  else                pass('T3 Handler coverage', `${all.size} unique handler(s) referenced, all defined or builtins`);
}

// ── T4: Tab consistency ───────────────────────────────────────────────────
{
  const btnIds   = [...html.matchAll(/<button[^>]*class="tab-btn"[^>]*id="tab-([a-z\-]+)"/g)].map(m => m[1]);
  const panelIds = [...html.matchAll(/<div[^>]*class="tab-panel"[^>]*id="panel-([a-z\-]+)"/g)].map(m => m[1]);
  // Also handle the inverse attribute order (class after id)
  const btnIdsAlt   = [...html.matchAll(/<button[^>]*id="tab-([a-z\-]+)"[^>]*class="tab-btn"/g)].map(m => m[1]);
  const panelIdsAlt = [...html.matchAll(/<div[^>]*id="panel-([a-z\-]+)"[^>]*class="tab-panel"/g)].map(m => m[1]);
  const btns   = new Set([...btnIds,   ...btnIdsAlt]);
  const panels = new Set([...panelIds, ...panelIdsAlt]);
  if (btns.size === 0 && panels.size === 0) {
    pass('T4 Tab consistency', 'no tabs on this page — skipped');
  } else {
    const btnsNoPanel = [...btns].filter(n => !panels.has(n));
    const panelsNoBtn = [...panels].filter(n => !btns.has(n));
    const onclickCalls = [...html.matchAll(/<button[^>]*class="tab-btn"[^>]*onclick="([^"]+)"/g)].map(m => m[1]);
    const nonShowTabHandlers = onclickCalls.filter(c => !/^\s*showTab\s*\(/.test(c));
    const issues = [];
    if (btnsNoPanel.length) issues.push(`buttons with no panel: ${btnsNoPanel.join(', ')}`);
    if (panelsNoBtn.length) issues.push(`panels with no button: ${panelsNoBtn.join(', ')}`);
    if (nonShowTabHandlers.length) issues.push(`tab-btn onclick doesn't call showTab(): ${nonShowTabHandlers.slice(0,3).join(' | ')}`);
    if (issues.length) fail('T4 Tab consistency', issues.join('; '));
    else                pass('T4 Tab consistency', `${btns.size} tabs, all paired (btn ↔ panel) and call showTab()`);
  }
}

// ── T5: Cheap structural sanity ───────────────────────────────────────────
{
  const issues = [];
  if (html.length < 50_000) issues.push(`file suspiciously small: ${html.length} bytes`);
  if (/Kevin Hardy/.test(html)) issues.push('contains stray placeholder "Kevin Hardy"');
  if (issues.length) fail('T5 Structural sanity', issues.join('; '));
  else                pass('T5 Structural sanity', `${html.length} bytes, no known stray placeholders`);
}

// ── Report ────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.passed);
const total  = results.length;
const passed = total - failed.length;

console.log('Ledger build gate — ' + (failed.length ? '❌ FAIL' : '✓ PASS') + ` (${passed}/${total} tests)`);
for (const r of results) {
  const icon = r.passed ? '✓' : '✗';
  console.log(`  ${icon} ${r.test}: ${r.message}`);
}
if (failed.length) {
  console.error(`\nBUILD GATE FAILED — ${failed.length} test(s) failed. Refusing to publish; keep the last-good edition.`);
  process.exit(1);
}
process.exit(0);
