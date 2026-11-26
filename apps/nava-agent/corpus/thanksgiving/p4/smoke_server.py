#!/usr/bin/env python3
"""Small mobile-friendly smoke-check server for P4 linkage decisions."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import sqlite3
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_WORK = Path.home() / ".local/share/zero/research/thanksgiving/work/p4"
DEFAULT_DB = DEFAULT_WORK / "snapshot.sqlite"
DEFAULT_SAMPLES = DEFAULT_WORK / "samples"
DEFAULT_SMOKE = DEFAULT_WORK / "smoke"
SEED = "p4-smoke-lock-2026-11-26"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def salted(value: str) -> str:
    return hashlib.sha256((SEED + "\0" + value).encode()).hexdigest()


def load_results(run_dir: Path) -> dict[str, dict[str, dict[str, Any]]]:
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for name, arm in (("links.jsonl", None), ("judge.jsonl", None)):
        for row in read_jsonl(run_dir / name):
            if row.get("arm") and row.get("confirmation"):
                out.setdefault(row["arm"], {})[row["confirmation"]] = row
    return out


def ids(row: dict[str, Any] | None) -> set[str]:
    if not row:
        return set()
    return {str(x.get("id")) for x in row.get("earliest_request") or [] if isinstance(x, dict) and x.get("id")}


def first_citation(row: dict[str, Any] | None) -> dict[str, str]:
    if row:
        for item in row.get("earliest_request") or []:
            if isinstance(item, dict) and item.get("id"):
                return {"id": str(item.get("id") or ""), "quote": str(item.get("quote") or "")}
    return {"id": "", "quote": ""}


def choose_linker_arm(results: dict[str, dict[str, dict[str, Any]]]) -> str | None:
    if "luna" in results:
        return "luna"
    return next((arm for arm in sorted(results) if arm != "haiku_judge"), None)


def compare_rows(linker: dict[str, Any] | None, judge: dict[str, Any] | None) -> str:
    if not linker or not judge:
        return "missing"
    li, ji = ids(linker), ids(judge)
    if linker.get("status") == "found" and judge.get("status") == "found" and li and li == ji:
        return "agreement"
    return "disagreement"


def lock_selection(db: Path, samples_dir: Path, run_dir: Path, smoke_dir: Path, linker_arm: str | None) -> dict[str, Any]:
    smoke_dir.mkdir(parents=True, exist_ok=True)
    lock_path = smoke_dir / "selection.json"
    if lock_path.exists():
        return json.loads(lock_path.read_text(encoding="utf-8"))
    results = load_results(run_dir)
    linker_arm = linker_arm or choose_linker_arm(results)
    linker = results.get(linker_arm or "", {})
    judge = results.get("haiku_judge", {})
    candidates = []
    for sample in read_jsonl(samples_dir / "e0b-30.jsonl"):
        conf = sample["confirmation"]
        if conf not in linker or conf not in judge:
            continue
        candidates.append({"confirmation": conf, "stratum": sample.get("stratum", "unknown"), "kind": compare_rows(linker.get(conf), judge.get(conf))})
    agreements = sorted((c for c in candidates if c["kind"] == "agreement"), key=lambda c: salted(c["confirmation"]))[:8]
    disagreements_all = sorted((c for c in candidates if c["kind"] == "disagreement"), key=lambda c: salted(c["confirmation"]))
    disagreements = disagreements_all[:7]
    chosen = agreements + disagreements
    cards = []
    for item in chosen:
        conf = item["confirmation"]
        lc = first_citation(linker.get(conf))
        jc = first_citation(judge.get(conf))
        cards.append(
            {
                "card_id": hashlib.sha256((conf + "|" + lc["id"] + "|" + jc["id"]).encode()).hexdigest()[:16],
                "confirmation": conf,
                "stratum": item["stratum"],
                "kind": item["kind"],
                "linker_arm": linker_arm,
                "luna": lc,
                "haiku": jc,
                "linker_status": linker.get(conf, {}).get("status"),
                "judge_status": judge.get(conf, {}).get("status"),
            }
        )
    payload = {
        "schema": "p4-smoke-selection-v1",
        "locked_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "run_dir": str(run_dir),
        "linker_arm": linker_arm,
        "counts": {"agreements_available": sum(1 for c in candidates if c["kind"] == "agreement"), "disagreements_available": len(disagreements_all), "cards": len(cards)},
        "cards": cards,
    }
    lock_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def booking(db: Path, confirmation: str) -> dict[str, Any]:
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    row = con.execute("select confirmation,guest_name,arrival,departure,created_at,travel_agent,company,created_by,status from hms_stay where confirmation=?", (confirmation,)).fetchone()
    con.close()
    return dict(row) if row else {}


def message(db: Path, ident: str) -> dict[str, Any]:
    if not ident.startswith("msg:"):
        return {}
    key = ident[4:]
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    row = con.execute("select id,sent_at,from_addr,to_addrs,subject,body_text from message where id=?", (key,)).fetchone()
    con.close()
    return dict(row) if row else {}


def esc(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def excerpt(msg: dict[str, Any], quote: str) -> str:
    body = str(msg.get("body_text") or "")
    subject = str(msg.get("subject") or "")
    text = body or subject
    if not text:
        return "<em>message excerpt unavailable</em>"
    pos = text.find(quote) if quote else -1
    if pos < 0:
        pos = max(0, len(text) // 2 - 350) if len(text) > 900 else 0
        part = text[pos : pos + 900]
        return esc(part).replace("\n", "<br>")
    start = max(0, pos - 350)
    end = min(len(text), pos + len(quote) + 350)
    before = esc(text[start:pos])
    mark = esc(text[pos : pos + len(quote)])
    after = esc(text[pos + len(quote) : end])
    return (before + "<mark>" + mark + "</mark>" + after).replace("\n", "<br>")


def page_shell(title: str, body: str) -> bytes:
    return f"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{esc(title)}</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f7f7f8;color:#111;line-height:1.35}}main{{max-width:760px;margin:auto;padding:14px}}.card{{background:white;border-radius:12px;padding:14px;margin:12px 0;box-shadow:0 1px 4px #0002}}.meta{{font-size:14px;color:#444}}table{{width:100%;border-collapse:collapse;font-size:14px}}td{{padding:3px;border-bottom:1px solid #eee;vertical-align:top}}mark{{background:#fff176;padding:0 2px}}.quote{{border-left:4px solid #ddd;padding-left:9px;margin:9px 0;font-size:14px}}button{{font-size:18px;padding:10px 12px;margin:5px 4px 5px 0;border:1px solid #999;border-radius:9px;background:#fff}}button[name=verdict][value=right]{{background:#e8f5e9}}button[name=verdict][value=wrong]{{background:#ffebee}}textarea{{width:100%;min-height:64px;font-size:16px}}input[type=submit]{{font-size:18px;padding:10px 18px}}a{{color:#0645ad}}.pill{{border-radius:99px;padding:2px 8px;background:#eee;font-size:12px}}
</style></head><body><main>{body}</main></body></html>""".encode("utf-8")


class SmokeApp:
    def __init__(self, db: Path, selection: dict[str, Any], smoke_dir: Path):
        self.db = db
        self.selection = selection
        self.smoke_dir = smoke_dir
        self.answers_path = smoke_dir / "answers.jsonl"
        self.lock = threading.Lock()
        self.cards = {card["card_id"]: card for card in selection.get("cards", [])}

    def answers(self) -> dict[str, dict[str, Any]]:
        out = {}
        for row in read_jsonl(self.answers_path):
            if row.get("card_id"):
                out[row["card_id"]] = row
        return out

    def index(self) -> bytes:
        answers = self.answers()
        rows = []
        for card in self.selection.get("cards", []):
            ans = answers.get(card["card_id"], {})
            rows.append(f"<tr><td><a href='/card?id={card['card_id']}'>{esc(card['confirmation'])}</a></td><td>{esc(card['stratum'])}</td><td>{esc(card['kind'])}</td><td>{esc(ans.get('verdict','unanswered'))}</td></tr>")
        counts = self.selection.get("counts", {})
        body = f"<h1>P4 linkage smoke check</h1><p class=meta>{len(rows)} cards locked before reveal. Agreements available: {counts.get('agreements_available')}; disagreements available: {counts.get('disagreements_available')}.</p><table><tr><th>booking</th><th>stratum</th><th>model agreement</th><th>answer</th></tr>{''.join(rows)}</table>"
        return page_shell("P4 smoke", body)

    def card(self, card_id: str) -> bytes:
        card = self.cards.get(card_id)
        if not card:
            return page_shell("missing", "<h1>card not found</h1><p><a href='/'>back</a></p>")
        stay = booking(self.db, card["confirmation"])
        msg = message(self.db, card["luna"]["id"])
        answers = self.answers()
        ans = answers.get(card_id, {})
        body = f"""<p><a href='/'>← all cards</a></p><h1>{esc(card['confirmation'])}</h1>
<div class=card><h2>Booking</h2><table>
<tr><td>guest</td><td>{esc(stay.get('guest_name'))}</td></tr><tr><td>dates</td><td>{esc(stay.get('arrival'))} → {esc(stay.get('departure'))}</td></tr><tr><td>agency/company</td><td>{esc(stay.get('travel_agent'))} / {esc(stay.get('company'))}</td></tr><tr><td>created</td><td>{esc(stay.get('created_at'))} by {esc(stay.get('created_by'))}</td></tr><tr><td>status</td><td>{esc(stay.get('status'))}</td></tr></table></div>
<div class=card><h2>Luna pick <span class=pill>{esc(card.get('linker_status'))}</span></h2><p class=meta>{esc(card['luna']['id'])}</p><div class=quote><b>quote:</b> {esc(card['luna']['quote'])}</div><p class=meta>{esc(msg.get('sent_at'))} from {esc(msg.get('from_addr'))} — {esc(msg.get('subject'))}</p><div>{excerpt(msg, card['luna']['quote'])}</div></div>
<div class=card><h2>Haiku pick <span class=pill>{esc(card.get('judge_status'))}</span></h2><p class=meta>{esc(card['haiku']['id'])}</p><div class=quote><b>quote:</b> {esc(card['haiku']['quote'])}</div></div>
<div class=card><h2> verdict: {esc(ans.get('verdict','unanswered'))}</h2><form method=post action='/answer'><input type=hidden name=card_id value={esc(card_id)}>
<button name=verdict value=right>Right</button><button name=verdict value=wrong>Wrong</button><button name=verdict value=cant_tell>Can't tell</button><br><textarea name=note placeholder=note>{esc(ans.get('note',''))}</textarea><br><input type=submit value=Save></form></div>"""
        return page_shell(card["confirmation"], body)

    def answer(self, data: dict[str, str]) -> None:
        card = self.cards.get(data.get("card_id", ""))
        if not card or data.get("verdict") not in {"right", "wrong", "cant_tell"}:
            return
        row = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "card_id": card["card_id"],
            "confirmation": card["confirmation"],
            "verdict": data["verdict"],
            "note": data.get("note", ""),
        }
        with self.lock:
            append_jsonl(self.answers_path, row)


def handler(app: SmokeApp):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/":
                payload = app.index()
            elif parsed.path == "/card":
                params = urllib.parse.parse_qs(parsed.query)
                payload = app.card((params.get("id") or [""])[0])
            else:
                payload = page_shell("not found", "<h1>not found</h1>")
                self.send_response(404)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self) -> None:
            if urllib.parse.urlparse(self.path).path != "/answer":
                self.send_error(404)
                return
            length = int(self.headers.get("content-length") or 0)
            data = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8")).items()}
            app.answer(data)
            self.send_response(303)
            self.send_header("location", "/card?id=" + urllib.parse.quote(data.get("card_id", "")))
            self.end_headers()

        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("smoke " + fmt % args + "\n")

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--samples-dir", type=Path, default=DEFAULT_SAMPLES)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--smoke-dir", type=Path, default=DEFAULT_SMOKE)
    parser.add_argument("--linker-arm")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args(argv)
    selection = lock_selection(args.db, args.samples_dir, args.run_dir, args.smoke_dir, args.linker_arm)
    if args.prepare_only:
        print(json.dumps({"ok": True, "cards": len(selection.get("cards", [])), "selection": str(args.smoke_dir / "selection.json")}, sort_keys=True))
        return 0
    app = SmokeApp(args.db, selection, args.smoke_dir)
    server = ThreadingHTTPServer((args.host, args.port), handler(app))
    print(f"serving http://{args.host}:{args.port}/ cards={len(selection.get('cards', []))} answers={args.smoke_dir / 'answers.jsonl'}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
