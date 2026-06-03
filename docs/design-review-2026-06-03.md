# Stellenbosch Ledger — Design Review

**Date:** 3 June 2026
**Author:** Claude (Opus 4.7, 1M context)
**Scope:** First three weeks of dogfooding the Stellenbosch Ledger dashboard (16 May–3 June 2026). 24 published editions, two real travel windows, multiple hand-off attempts, one structural bug surfaced (the WhatsApp MCP gap), one cosmetic bug surfaced (the tip-block not rotating), one architectural gap exposed (scheduler-host).
**Purpose:** Audit the artefact and the workflow. Rank improvements by leverage. Tag each with implementation effort.

---

## Headline findings

1. **The dashboard works as a single-pane status surface for Roger.** Three weeks in, Roger reaches for it across two devices (laptop + Pixel), trusts the priority order, and uses the "Send to Claude" payload as a real feedback loop. The information density is roughly right.

2. **Three structural gaps cost more than any cosmetic improvement would buy.** In order of leverage: (a) the scheduler-host gap (zero cron fires across Camp David), (b) the Notion-bucket-sync gap (Roger's payload protocol references a Notion infrastructure I have not built), (c) the Send-to-Claude friction (he hand-writes the payload from his Pixel; a one-tap compile would close it). All three are real friction Roger has named; none are cosmetic.

3. **Two slow leaks accumulate over weeks.** (a) Items carry forward unchanged across many editions before becoming truly resolved (Pieter Day 26, Atlax silent, Spock CI Day 15+) — the dashboard does not currently distinguish "actively worked" from "carried-but-cold". (b) Editions silently inherit data from prior editions (e.g. v1.21–v1.23 misclassified the Lima Tyme D1 thread as closed). Both can be reduced by structural changes, not by writing better lede prose.

---

## What's working — keep

- **The five-section spine** (Lede → Inbox → Front Page grid → Day cards → All Actions → Pullquote → Footer) maps to how Roger reads. Don't restructure.
- **The North Star spine** under the lede grounds the day in seven-frame priorities. The Family / Chronos / Inner-life split has held across every edition without needing renames.
- **The Send-to-Claude payload format** Roger uses from his Pixel is the right shape — it carries ticks, notes, new tasks, and inbox-handled in one block. The protocol is sound; the friction is in *composing* it, not in the format itself.
- **WhatsApp MCP wire-up** (after the 28 May fix) is holding. The mandatory three-thread sweep (Isa DM, Isa Projects, Elca DM) caught real items that the headless cron previously dropped silently. This pattern — explicit always-sweep mandates encoded in the SKILL.md — should be the template for any new source.
- **The footer as edition-history surface** has been useful for Roger to trace what moved between editions. Keep the verbose log.

---

## Ranked improvements

Each item: **scope · effort · why it matters · what changes**.

### 1. Move the scheduler off the Mac (RECOMMENDED THIS WEEK)

- **Effort:** ~1 hour (provision + cutover + verify)
- **Why:** Zero cron fires landed across the 5-day Camp David trip. Mac slept; launchd does not wake. The 3×/day promise is moot until this is fixed. This is the single biggest reliability gap.
- **What changes:** Provision a $5/month DigitalOcean droplet (Ubuntu LTS), install `claude` CLI + `gh` CLI, mirror the WhatsApp MCP server config (the local-process MCP needs to run somewhere — easiest is to keep WhatsApp local on the Mac and accept that the cron skips WhatsApp when the Mac is asleep; the next-best is to run a second WhatsApp MCP on the droplet against a separate Beeper-style relay). Replace launchd with cron on the droplet. The dashboard becomes machine-independent.
- **Tradeoff:** WhatsApp sweep when Mac is asleep is the open question. Three options: (a) accept WhatsApp gap when away (cron disclosure in footer), (b) run a second WhatsApp MCP on the droplet (more setup), (c) keep launchd on the Mac as a "when home" supplement to the cloud cron (the cloud one runs always, the Mac one adds WhatsApp coverage when awake). My recommendation: ship (c).

### 2. Build the Notion bucket-sync infrastructure (or stop referencing it)

- **Effort:** ~3-4 hours
- **Why:** Roger's "Send to Claude" payload protocol references Notion bucket pages (Signatures / Payments / Reviews / Respond), a North Star DB, and a private activity log. None of these exist as actual Notion infrastructure I have built. Every payload Roger sends includes routing instructions that I cannot honour. This is dishonest in both directions: my echo-back claims to do things I haven't done, and Roger believes a bucket sync is happening that isn't.
- **What changes:** Either build the four bucket pages + the dedupe-by-fuzzy-title sync (one-time spec + module), OR scrub the routing-instruction template so it only references what's actually wired. The first is better long-term; the second is honest cleanup.

### 3. Add a "Compile Payload" button to the dashboard

- **Effort:** ~2 hours
- **Why:** Roger hand-writes the "Send to Claude" payload on his Pixel by typing into a notes app. The dashboard already has all the tick states (localStorage), all the note inputs (localStorage), and the new-task form. A button that gathers these into the canonical payload format and copies it to the clipboard would close the loop.
- **What changes:** Add a floating action button `[📋 Compile Payload]`. On click, walk all FP cards + inbox items + NS notes + new-task inputs, build the markdown block matching Roger's protocol, copy to clipboard, show a toast. Roger pastes into chat. The friction of hand-writing the payload drops to zero.

### 4. Fix the tip-block rotation (DONE this edition; codify into SKILL.md)

- **Effort:** ~30 min (just the SKILL.md update; the v1.24 rotation already demonstrated the pattern)
- **Why:** The tip stayed frozen at #1 for every edition since shipping — JS ticks went to localStorage and the next edition's HTML still showed the old tip. Confidence-eroding because the UI explicitly promised "a fresh tip surfaces on the next dashboard".
- **What changes:** Add a step in `/ledger-now` SKILL.md: query Notion Tips Backlog (data source `114727aa-c905-40fc-9d5b-c76342f93189`) for the next backlog entry whose `Status` is `Backlog` and whose ID is not the current `data-tip-id`. Inject title + body + URL into the tip block. Push the previous tip ID to a "shown" list in the build-state file (or a Notion property). Closes the contract.

### 5. Standardise the action-ID convention

- **Effort:** ~1 hour
- **Why:** The dashboard mixes `fp-tue-*` / `fp-wed-*` / `task-mpwll4gp` / `act-mkopa-*` / `inbox-thu-*`. The day-letter prefix becomes wrong every Monday. The `task-*` IDs from the payload-protocol have a different shape. The `act-*` prefix is just legacy.
- **What changes:** One scheme. Suggestion: `<source>-<noun>-<short>` where source is `fp`/`task`/`act`/`inbox`, day-letter dropped. So `fp-tue-pwc-tech-dd-17h` becomes `fp-pwc-tech-dd`. Stable across editions. The day context lives in the meta line, not the ID.

### 6. Add "Days carrying" / "Last touched" signal to FP cards

- **Effort:** ~1 hour
- **Why:** Pieter Day 26 has a day count baked in by hand. Atlax doesn't have one but probably should. truID is "26h unread". The signal is inconsistent. Without it, "carrying but cold" items disappear into the same visual weight as "fresh and hot" items.
- **What changes:** Add `data-first-seen="2026-05-09"` to each card. The card's meta line auto-renders "Day N" from today's date. Stale items (>7 days) get a subtle visual treatment (italic? colour shift?) to mark the difference between "carrying" and "active".

### 7. Mobile / Pixel viewport audit

- **Effort:** ~2 hours
- **Why:** Roger reads on his Pixel as much as his laptop. The FP grid is currently `auto-fill, minmax(360px, 1fr)`, which on a Pixel renders as a single column with full card width — fine — but the masthead, North Star spine, and footer have not been visually verified on narrow viewports. The "Send to Claude" payload composition happens on the Pixel; the dashboard should be optimised for that.
- **What changes:** Open the live URL on a Pixel-sized viewport, screenshot the four key sections, fix anything that overflows or feels cramped. Specifically check: tip-block summary line on narrow screens; FP card meta line wrapping; pullquote indent. No structural changes expected; just CSS tightening.

### 8. Edition history index page

- **Effort:** ~1 hour
- **Why:** `edition_*.html` snapshots accumulate in the project_ledger directory with no UI to browse them. Roger has occasionally referred back to what state things were in three days ago; currently that requires opening files by hand.
- **What changes:** Generate a tiny `index.html` in spock-site-build (or as a sibling to `ledger/`) listing recent editions with title + timestamp + a one-line summary. Update each publish-cycle.

### 9. Tip backlog visibility on the dashboard

- **Effort:** ~30 min
- **Why:** Roger doesn't currently see what tips are queued. The tip block shows today's; everything else is invisible until rotation. A small "next 3 tips" preview under the current tip would let Roger up/down/skip from the same view.
- **What changes:** Add a `<details>` block below today's tip: "Next in the queue → [tip 2] · [tip 3] · [tip 4]" with one-line summaries. Pulled from the same Notion query.

### 10. Footer-vs-pullquote rebalance

- **Effort:** ~30 min
- **Why:** The footer has grown to a 200-word paragraph documenting every edition's deltas. The pullquote is one sentence. The right balance is the opposite: pullquote does the emotional/strategic frame in 2-3 sentences; the footer is a tighter version-stamp + 3-5 bullet deltas.
- **What changes:** Restructure footer template into: `Compiled · location · version (slot)` + `5 deltas max` + `still open: 3 items max` + `pending architectural decisions: 1`. Push the rest into a `<details>` "Full audit log" block for editions where Roger wants the prose history.

---

## Honourable mentions (not ranked)

- **3×/day cadence** — Once running, is 3 the right number? Looking back at the editions actually published manually, Roger has been refreshing roughly 2× per day on busy days, once on quiet days. **Morning briefing + evening reset** might be the right cadence; midday adds noise more often than signal.
- **`current.html` vanishing** — Has happened twice unexplained. Worth instrumenting `ledger-cron.sh` to log when the file changes outside of a publish cycle.
- **The Spock CI Day-N counter is broken** — has shown Day 9 / 10 / 11 / 14 / 15+ over the last week with no actual checks against GitHub Actions. Either query the GitHub Actions API and report real counts, or stop showing the day number.
- **"All Actions" section quality** — hasn't been refreshed in weeks. Mostly stale rows. Either prune to current state or de-emphasise visually.

---

## Suggested order

If we ship one thing this week: **#1 (scheduler)**.

If we ship two: add **#3 (compile-payload button)** — it directly closes the friction Roger named.

If we ship three: add **#4 (tip-block rotation in SKILL.md)** — small effort, closes a contract Roger already noticed.

The Notion-bucket-sync (#2) is the heaviest lift but the deepest payoff; queue for a calm weekend.

---

## Closing

The artefact is healthy and the dogfood is real. The improvements above are not corrections — they're tightening the parts that have been load-bearing enough to start showing wear. Three weeks in, the dashboard is doing what it was supposed to do.
