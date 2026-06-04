# Workflows for the Stellenbosch Ledger

This directory holds the **multi-phase Workflow scripts** that run the
dashboard build. They're the architectural answer to the "consistency"
problem in the design review: every refresh follows the same gates instead
of me re-deciding each time.

## `build-ledger.workflow.js`

End-to-end dashboard rebuild. Five phases:

| Phase | What it does | How |
|---|---|---|
| **Sweep** | Pull deltas from 6 sources | 6 parallel agents (WhatsApp mandatory + WhatsApp self-chat + Gmail + Calendar + Notion + Drive) |
| **Synthesize** | Merge deltas into a structured patch | 1 agent that reads current.html + sweep results and emits a typed JSON patch (FP adds/drops/updates, NS updates, kicker/subtitle/lede, etc.) |
| **RotateTip** | Pick the next tip from Notion | 1 agent that queries the Tips Backlog DB, fetches content, returns typed JSON for the tip block |
| **Apply** | Apply patches + bump 9 timestamps + write current.html | 1 agent with Read/Edit/Bash that materialises the patch |
| **Publish** | Snapshot, clone, commit, push, poll for live | 1 agent that runs the canonical publish chain |

Each phase emits **structured output via a JSON schema**, so the pipeline
doesn't pass free-form text between phases — it passes typed records.
That's what makes it reproducible.

### Running interactively

```
Workflow({ scriptPath: "~/code/claude-project-ledger/workflows/build-ledger.workflow.js" })
```

Optionally pass args:

```
Workflow({
  scriptPath: "...",
  args: {
    since: "2026-06-04T08:32:00+02:00",   // what window to sweep
    payload_done: [{ id: "fp-wed-foo", title: "..." }],  // from Send-to-Claude payload
  }
})
```

### Running from the cron

The headless cron (Mac launchd or cloud VM) should be updated to invoke the
workflow rather than the existing `/ledger-now` slash command. The wrapper
in `scripts/ledger-cron.sh` already runs `claude --print "/ledger-now"`; to
switch to the workflow flow, change that to:

```
$CLAUDE_BIN --print --dangerously-skip-permissions \
  'Run the build-ledger workflow at ~/code/claude-project-ledger/workflows/build-ledger.workflow.js'
```

Claude will route through this script, the same 5 phases will run, and the
edition publishes. No manual hand-curation in between.

### Iterating on a phase

Edit the script file directly (Edit/Write tools). To re-run from a specific
phase without re-doing the earlier phases, use `resumeFromRunId`:

```
Workflow({
  scriptPath: "...",
  resumeFromRunId: "wf_xxxxx_xxx"
})
```

Completed agents return cached results instantly; only edited or new
agent() calls re-run live. The full-pipeline run-id is logged in the
published edition's footer for traceability.

### Why a Workflow instead of a Skill

A Skill is a markdown file that *describes* what Claude should do.
Each refresh, Claude re-reads the description and makes new decisions
(version number, anchor list, etc.) — same description, different
judgement calls each time. That's where the v1.25/v1.26 mistakes came
from.

A Workflow is a **JavaScript file that executes**. Each phase has a
contract (its JSON schema). The orchestration is deterministic; only the
LLM calls inside each phase have judgement. Same input + same script =
same output. That's the source of consistency.

The `/ledger-now` SKILL.md stays as the **interactive entry-point** (Roger
types `/ledger-now`, the skill invokes the workflow). The workflow is the
heavy lifting.
