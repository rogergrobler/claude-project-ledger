#!/usr/bin/env python3
"""
Rotate the Claude Tip of the Day on the Stellenbosch Ledger dashboard.

Picks the next unticked tip from the Notion "🎓 Claude Tips Backlog" database
(data source: 114727aa-c905-40fc-9d5b-c76342f93189) and rewrites the
<details class="tip-block"> section in current.html with its content.

Invoked by /ledger-now SKILL.md as part of every fresh build. Also runnable
standalone:

    python3 ~/code/claude-project-ledger/scripts/rotate-tip.py \\
        --current-html "$HOME/Documents/Claude/Projects/Project Ledger/project_ledger/current.html" \\
        --history-file "$HOME/.project_ledger/tip-history.json"

The history file tracks which tip IDs have been shown so we don't repeat until
the backlog is exhausted. Format: {"shown": ["368493ab-...", ...], "current": "..."}.

DESIGN NOTE: this script does NOT query Notion directly — it expects the caller
(the orchestrating Claude session) to have already fetched the next tip and
to pass its content in via JSON on stdin. This keeps the script free of API
credentials and Notion-version dependencies.

Stdin JSON shape:
    {
      "id": "368493ab-3bff-...",
      "feature": "Claude persistent memory (chat + project-scoped) — GA",
      "title": "Claude persistent memory — chat + project-scoped, now GA",
      "summary_kicker": "Claude Tip of the Day",
      "summary_meta": "#3 · Evaluate next month · click to expand",
      "hook": "...",
      "what_it_does": "...",
      "why_high_leverage": "...",
      "tags": ["Evaluate next month", "Surface · Claude apps", "Effort · Low", "Released · 1 Mar 2026"],
      "steps_html": "<strong>Try it — three moves:</strong><br>1.&nbsp; ...",
      "tiein": "↳ ...",
      "source_url": "https://support.claude.com"
    }

Returns 0 on success, prints the new tip id to stdout.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path


TIP_BLOCK_RE = re.compile(
    r'<details class="tip-block"[^>]*?id="tip-of-day"[^>]*?>.*?</details>',
    re.DOTALL,
)


def render_tip_html(tip: dict) -> str:
    tags = "".join(
        f'<span class="tip-tag{(" adopt" if i==0 else "")}">{t}</span>'
        for i, t in enumerate(tip.get("tags", []))
    )
    return (
        f'<details class="tip-block" id="tip-of-day" '
        f'data-tip-id="{tip["id"]}" '
        f'data-tip-feature="{tip["feature"]}">\n'
        f'  <summary class="tip-summary">'
        f'<span class="tip-summary-icon">🎓</span>'
        f'<span class="tip-summary-kicker">{tip.get("summary_kicker", "Claude Tip of the Day")}</span>'
        f'<span class="tip-summary-title">{tip["title"]}</span>'
        f'<span class="tip-summary-meta">{tip["summary_meta"]}</span>'
        f'<span class="tip-chevron">⌃</span></summary>\n'
        f'  <div class="tip-body">\n'
        f'  <div class="tip-hook">{tip["hook"]}</div>\n'
        f'  <div class="tip-section"><span class="tip-lbl">What it does</span>{tip["what_it_does"]}</div>\n'
        f'  <div class="tip-section"><span class="tip-lbl">Why it\'s high leverage for you</span>{tip["why_high_leverage"]}</div>\n'
        f'  <div class="tip-tags">{tags}</div>\n'
        f'  <div class="tip-steps">{tip["steps_html"]}</div>\n'
        f'  <div class="tip-tiein">{tip["tiein"]}</div>\n'
        f'  <div class="tip-controls">\n'
        f'    <button class="tip-btn up" onclick="tipVote(this,\'up\')">👍 Learned &amp; implemented</button>\n'
        f'    <button class="tip-btn down" onclick="tipVote(this,\'down\')">👎 Not useful</button>\n'
        f'    <button class="tip-btn note" onclick="tipNote(this)">✎ Note</button>\n'
        f'    <span class="tip-verdict" id="tip-verdict"></span>\n'
        f'    <span class="tip-src"><a href="{tip["source_url"]}" target="_blank">source ↗</a></span>\n'
        f'  </div>\n'
        f'  <div class="tip-note-box" id="tip-note-box"><textarea class="tip-note-input" placeholder="Teach me — what\'s useful here, or how to surface tips better…"></textarea></div>\n'
        f'  </div>\n'
        f'</details>'
    )


def update_history(history_path: Path, tip_id: str) -> dict:
    history = {"shown": [], "current": None}
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text())
        except Exception:
            pass
    if history.get("current") and history["current"] not in history["shown"]:
        history["shown"].append(history["current"])
    history["current"] = tip_id
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(history, indent=2))
    return history


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--current-html",
        default=str(Path.home() / "Documents/Claude/Projects/Project Ledger/project_ledger/current.html"),
    )
    ap.add_argument(
        "--history-file",
        default=str(Path.home() / ".project_ledger/tip-history.json"),
    )
    args = ap.parse_args()

    try:
        tip = json.load(sys.stdin)
    except Exception as e:
        print(f"error reading tip JSON from stdin: {e}", file=sys.stderr)
        return 2

    required = ("id", "feature", "title", "summary_meta", "hook", "what_it_does",
                "why_high_leverage", "tags", "steps_html", "tiein", "source_url")
    missing = [k for k in required if k not in tip]
    if missing:
        print(f"error: tip JSON missing keys: {missing}", file=sys.stderr)
        return 2

    html_path = Path(args.current_html)
    text = html_path.read_text()
    new_block = render_tip_html(tip)
    new_text, n = TIP_BLOCK_RE.subn(new_block, text, count=1)
    if n != 1:
        print("error: could not locate the tip block in current.html", file=sys.stderr)
        return 1
    html_path.write_text(new_text)

    update_history(Path(args.history_file), tip["id"])
    print(tip["id"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
