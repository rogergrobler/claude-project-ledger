---
name: ledger-rebuild
description: Rebuild the Stellenbosch Ledger from scratch — full sweep, regenerate every section (not just deltas), publish. Heavier than /ledger-now; use when the dashboard structure has drifted, sections are missing, or the version has gone stale enough that a delta-merge won't recover it. Use when the user says "/ledger-rebuild", "rebuild from scratch", "ledger has drifted", "regenerate the dashboard", "full rebuild ledger", or "the dashboard is broken — fix it".
---

# Project Ledger — Rebuild

Heavyweight version of `ledger-now`. Where `ledger-now` does a delta-merge into the existing `current.html`, this skill regenerates every section from the sweep results plus the canonical structure spec. Use when the structure has drifted or sections have been silently dropped.

## When to invoke this rather than ledger-now

- `current.html` is missing AND no recent edition snapshot exists
- Sections have been deleted by accident (no North Star group, no Front Page grid, no Day cards)
- The version has been static for more than 48 hours (delta-merge would compound stale state)
- Roger explicitly asks for a "full rebuild" or "fresh from scratch"
- The completeness audit on the previous edition flagged silent drops

If none of the above apply, prefer `ledger-now` — it's faster and preserves Roger's iterative edits.

## Workflow

### Step 1 — Confirm the rebuild is wanted

Briefly state to Roger what you're about to regenerate. Wait for confirmation only if there's any risk of losing recent manual edits. Otherwise proceed (per his "drive decisions, don't ask" standing instruction).

### Step 2 — Capture the canonical structure

The Ledger has these sections, in order:

1. `<head>` with title, meta, inline CSS
2. Kicker line (slot + version + headline tag)
3. Subtitle (one-liner with the timestamp and headline shifts)
4. Dateline (edition number)
5. Last-calibrated stamp
6. Tip of the Day (collapsed by default — `<details>` block, sourced from Notion DB "🎓 Claude Tips Backlog" data source `114727aa-c905-40fc-9d5b-c76342f93189`)
7. North Star spine (7 stars: Family, Matterhorn, Chronos, Spock, Portfolio, Inner life, Flywheel)
8. Lede paragraph
9. Inbox section
10. Front Page priority grid (fp-* cards)
11. Day cards (Today / Tomorrow / Tonight blocks)
12. All Actions section (act-* rows, grouped by North Star)
13. Pullquote
14. Footer with version + commit metadata

Each act-* row has a comment button and a tick state stored in localStorage.

### Step 3 — Full sweep + regeneration

Run the same sweep agent pattern as `ledger-now` (see that SKILL.md), but instead of merging deltas into the existing HTML, regenerate each section fresh. Use the previous edition only as a source of "still-open" items to carry forward — never copy section text verbatim.

### Step 4 — Snapshot existing, write new, publish

Before writing the new `current.html`, snapshot the existing one as `edition_<date>-<slot>-prerebuild.html` so Roger can diff if needed. Then write the new `current.html`, run the publish block (same as `ledger-now` Step 5), and poll for live.

### Step 5 — Disclose

Lead the summary with: "Full rebuild. Previous edition snapshotted as `edition_<date>-<slot>-prerebuild.html`."

## Guardrails

- Same as `ledger-now`: no fabricated deadlines, no Kevin Hardy, no Founding Partner titles, no process notes in user-facing copy.
- Tick state in localStorage is per-user-per-browser. Don't try to restore it across rebuilds — Roger expects done items to clear on a rebuild.
- If a section sourced from Notion (Tip of the Day, North Star body) fails to fetch, fall back to the last-known good content from the prior edition and disclose the gap.
