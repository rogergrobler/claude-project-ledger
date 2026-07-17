#!/usr/bin/env python3
"""
Reconcile poller for the Stellenbosch Ledger auto-write backend.

The dashboard (served from the Cloudflare Worker) POSTs every Done / defer /
delete / note / task to  POST /api/change , which the Worker stores as an
immutable object under  inbox/  in the R2 'ledger' bucket. This script — run
once a minute by launchd — drains that inbox and applies it:

  done / delete / defer  → drop the card/row from current.html + record in
                           done-ledger.json  (INSTANT: card gone next refresh)
  note / task / ns / *   → appended to pending-for-claude.jsonl for the next
                           scheduled Claude fire to reason about and apply.

After applying, if current.html changed AND the sanity gate passes, it
republishes to R2 — the password-protected Cloudflare Worker surface (the only
public copy is a redirect to it). Processed inbox objects are then deleted.

Safety: single-instance lockfile; pre-edit backup; publishes ONLY on a green
sanity gate; never touches <script> blocks.
"""
import os, sys, re, json, time, io, subprocess, datetime, fcntl, hashlib, html

HOME = os.path.expanduser("~")
PROJ = os.path.join(HOME, "spock-data", "project_ledger")
CURRENT = os.path.join(PROJ, "current.html")
DONELEDGER = os.path.join(PROJ, "done-ledger.json")
QUEUE = os.path.join(PROJ, "pending-for-claude.jsonl")
CONFIG = os.path.join(HOME, ".project_ledger", "config.toml")
SANITY = os.path.join(HOME, "code", "claude-project-ledger", "scripts", "..", "..", "..", "spock-data", "project_ledger", "scripts", "sanity_check.sh")
SANITY = os.path.join(PROJ, "scripts", "sanity_check.sh")
LOCK = os.path.join(HOME, ".project_ledger", "reconcile.lock")
LOGF = os.path.join(PROJ, "cron-logs", "reconcile.log")
SSB_REPO = "https://github.com/rogergrobler/spock-site-build.git"

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOGF, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass

def read_cfg():
    txt = open(CONFIG).read()
    def grab(k):
        m = re.search(rf'{k}\s*=\s*"([^"]+)"', txt)
        return m.group(1) if m else None
    return {
        "account": grab("account_id"),
        "access": grab("r2_access_key"),
        "secret": grab("r2_secret_key"),
        "bucket": grab("r2_bucket") or "ledger",
    }

def s3client(cfg):
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=f"https://{cfg['account']}.r2.cloudflarestorage.com",
        aws_access_key_id=cfg["access"],
        aws_secret_access_key=cfg["secret"],
        config=Config(signature_version="s3v4", region_name="auto"),
    )

# ── HTML element removal ─────────────────────────────────────────────────
# Attribute-ORDER-AGNOSTIC. The Claude fire emits cards as
#   <div class="card fire" data-first-seen="…" data-id="…" …>
# i.e. data-id is NOT always adjacent to class. The old strict regex required
# adjacency and silently matched ZERO cards, so no Done ever removed a card
# (the id landed in done-ledger but the card stayed). Match the class exactly
# ("card" or "card <mods>", never "card-head") and find data-id anywhere in the tag.
CARD_OPENER = re.compile(r'^\s*<div class="card(?:\s[^"]*)?"[^>]*\sdata-id="([^"]+)"')
LI_OPENER   = re.compile(r'^\s*<li class="signal-item(?:\s[^"]*)?"[^>]*\sdata-id="([^"]+)"')

def remove_element(lines, data_id):
    """Return (new_lines, removed_bool). Handles Front Page cards and
    People/Bottleneck signal-items; leaves other element types untouched."""
    # card?
    cards = [(i, m.group(1)) for i, l in enumerate(lines) if (m := CARD_OPENER.match(l))]
    for k, (idx, cid) in enumerate(cards):
        if cid == data_id:
            end = cards[k + 1][0] if k + 1 < len(cards) else None
            if end is None:
                # last card: remove to the priority-grid close if we can find it,
                # else bail (safer to leave for the Claude fire).
                return lines, False
            return lines[:idx] + lines[end:], True
    # signal-item li?
    for i, l in enumerate(lines):
        if (m := LI_OPENER.match(l)) and m.group(1) == data_id:
            e = i
            while e < len(lines) and "</li>" not in lines[e]:
                e += 1
            return lines[:i] + lines[e + 1:], True
    return lines, False

def load_doneledger():
    try:
        return json.load(open(DONELEDGER))
    except Exception:
        return {}

def gate_ok():
    try:
        r = subprocess.run(["bash", SANITY, CURRENT, ""], capture_output=True, text=True, timeout=60)
        return "SANITY GATE: PASS" in r.stdout
    except Exception as e:
        log(f"gate error: {e}")
        return False

def publish_r2(s3, cfg, body):
    s3.put_object(Bucket=cfg["bucket"], Key="current.html", Body=body,
                  ContentType="text/html; charset=utf-8", CacheControl="no-cache, max-age=0")

def publish_pages():
    """Mirror current.html to GitHub Pages so scheduled fires (which rebase from
    the live URL) don't revert the drops."""
    work = f"/tmp/ssb-reconcile-{os.getpid()}"
    subprocess.run(["rm", "-rf", work], check=False)
    r = subprocess.run(["git", "clone", "--depth", "1", SSB_REPO, work], capture_output=True, text=True)
    if r.returncode != 0:
        log(f"pages clone failed: {r.stderr[:200]}"); return False
    subprocess.run(["cp", CURRENT, os.path.join(work, "ledger", "index.html")], check=True)
    subprocess.run(["git", "-C", work, "config", "user.name", "Roger Grobler"], check=True)
    subprocess.run(["git", "-C", work, "config", "user.email", "roger@ccap.ai"], check=True)
    subprocess.run(["git", "-C", work, "add", "ledger/index.html"], check=True)
    c = subprocess.run(["git", "-C", work, "commit", "-m",
                        f"Ledger auto-reconcile · {datetime.datetime.now():%Y-%m-%d %H:%M SAST}"],
                       capture_output=True, text=True)
    if "nothing to commit" in (c.stdout + c.stderr):
        subprocess.run(["rm", "-rf", work], check=False); return True
    p = subprocess.run(["git", "-C", work, "push", "origin", "main"], capture_output=True, text=True)
    subprocess.run(["rm", "-rf", work], check=False)
    if p.returncode != 0:
        log(f"pages push failed: {p.stderr[:200]}"); return False
    return True

def add_done_tab_entries(text, entries):
    """Register each dropped card in the Done tab so a Done tap visibly lands there.
    Prepends <li> rows into a dedicated 'Cleared from the dashboard' done-card
    (created on first use) inside #panel-done .done-grid, and bumps #count-done."""
    if not entries:
        return text
    lis = "".join(
        f'\n        <li><span class="ck">✓</span><strong>{html.escape(t)}</strong> '
        f'— cleared from the dashboard {ts[11:16]} UTC.</li>'
        for (t, ts) in entries
    )
    marker = '<div class="done-card dash" id="done-dashboard-cleared">'
    if marker in text:
        text = re.sub(
            r'(<div class="done-card dash" id="done-dashboard-cleared">.*?<ol class="done-list">)',
            lambda m: m.group(1) + lis, text, count=1, flags=re.S)
    else:
        block = (
            '\n    <div class="done-card dash" id="done-dashboard-cleared">'
            '\n      <div class="done-hed">✅ Cleared from the dashboard '
            '<span class="done-when">auto-logged</span></div>'
            f'\n      <ol class="done-list">{lis}\n      </ol>\n    </div>')
        text = re.sub(r'(<div class="done-grid">)', lambda m: m.group(1) + block, text, count=1)
    m = re.search(r'(id="count-done">)(\d+)(</span>)', text)
    if m:
        text = text[:m.start()] + f'{m.group(1)}{int(m.group(2)) + len(entries)}{m.group(3)}' + text[m.end():]
    return text

def bump_compiled_at(text):
    now = datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()
    return re.sub(r'(<body data-compiled-at=")[^"]*(")', rf'\g<1>{now}\g<2>', text, count=1)

def main():
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return  # another instance running; skip this tick silently

    # Defer to an in-progress scheduled fire (it edits current.html too). The fire
    # writes an epoch to fire.lock and clears it on exit; honour it while fresh
    # (< 30 min, the fire's own ceiling) so we never edit mid-build.
    fire_lock = os.path.join(HOME, ".project_ledger", "fire.lock")
    try:
        if os.path.exists(fire_lock):
            started = int(open(fire_lock).read().strip() or "0")
            if 0 < (time.time() - started) < 1800:
                return
    except Exception:
        pass

    cfg = read_cfg()
    s3 = s3client(cfg)
    objs = s3.list_objects_v2(Bucket=cfg["bucket"], Prefix="inbox/").get("Contents", [])
    if not objs:
        return
    changes = []
    for o in sorted(objs, key=lambda x: x["Key"]):
        try:
            body = s3.get_object(Bucket=cfg["bucket"], Key=o["Key"])["Body"].read().decode()
            changes.append((o["Key"], json.loads(body)))
        except Exception as e:
            log(f"skip unreadable {o['Key']}: {e}")
    if not changes:
        return
    log(f"draining {len(changes)} change(s) from inbox")

    text = open(CURRENT, encoding="utf-8").read()
    lines = text.split("\n")
    ledger = load_doneledger()
    ts = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    html_changed = False
    processed_keys = []
    done_tab_entries = []

    DROP_TYPES = {"done", "cardDone", "delete", "cardDelete", "defer", "cardDefer"}
    for key, ch in changes:
        typ = ch.get("type", "")
        cid = ch.get("id", "")
        title = ch.get("title", cid)
        if typ in DROP_TYPES and cid:
            lines, removed = remove_element(lines, cid)
            defer_until = ch.get("deferUntil") if "defer" in typ.lower() else None
            ledger[cid] = {"title": title, "clearedAt": ts, "deferUntil": defer_until}
            if removed:
                html_changed = True
                if "delete" not in typ.lower():
                    done_tab_entries.append((title, ts))
                log(f"  dropped card {cid} ({typ})")
            else:
                log(f"  recorded {cid} ({typ}) in done-ledger (not a card/li — Claude will drop it)")
            processed_keys.append(key)
        else:
            # note / task / ns / anything else → queue for the next Claude fire
            with open(QUEUE, "a") as q:
                q.write(json.dumps(ch, ensure_ascii=False) + "\n")
            log(f"  queued {typ} {cid} for next Claude fire")
            processed_keys.append(key)

    # Self-heal: any id already in done-ledger but STILL rendered (e.g. a drop the
    # poller previously failed to apply) gets swept here, so the page can't drift
    # out of sync with the ledger and the sanity gate's cleared-id check stays green.
    for cid in list(ledger.keys()):
        if any(f'data-id="{cid}"' in l for l in lines):
            lines, removed = remove_element(lines, cid)
            if removed:
                html_changed = True
                log(f"  self-heal: swept previously-cleared {cid}")

    # persist done-ledger always (records the clears)
    json.dump(ledger, open(DONELEDGER, "w"), ensure_ascii=False, indent=2)

    if html_changed:
        new_text = add_done_tab_entries("\n".join(lines), done_tab_entries)
        new_text = bump_compiled_at(new_text)
        # backup then write
        bak = CURRENT + ".reconcile.bak"
        open(bak, "w", encoding="utf-8").write(text)
        open(CURRENT, "w", encoding="utf-8").write(new_text)
        if not gate_ok():
            log("SANITY GATE FAILED after reconcile — restoring backup, NOT publishing")
            open(CURRENT, "w", encoding="utf-8").write(text)
            return  # leave inbox intact so nothing is lost; investigate
        body = new_text.encode("utf-8")
        publish_r2(s3, cfg, body)
        log("published to R2 (password-protected Worker surface)")

    # delete processed inbox objects (only reached if gate passed or no html change)
    for key in processed_keys:
        try:
            s3.delete_object(Bucket=cfg["bucket"], Key=key)
        except Exception as e:
            log(f"failed to delete {key}: {e}")
    log(f"reconcile done — {len(processed_keys)} change(s) applied")

if __name__ == "__main__":
    main()
