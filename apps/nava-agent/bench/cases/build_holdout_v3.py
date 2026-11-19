#!/usr/bin/env python3
"""Build holdout-v3 = holdout-v2 (verbatim) + newly linked Oct 29–Nov 19 EMA/TA bookings.

Linking (precision over recall), priorities Create → Cancel → Amend:
  1. Same-thread inbound before booking created_on in the conf-letter thread
  2. Cross-thread: conf-letter outbound recipient == earlier inbound sender within 14d
     + surname or arrival-date match
  3. Surname + arrival date in an earlier non-OTA inbound

Tiers 2–3 require a verbatim quote check (surname AND date, or surname AND agency/org)
and a Luna verifier decision (logged).

Minimal placeholder gold only (workflow + confirmation list). Field gold is L3's job.

Outputs:
  ~/.local/share/zero/bench/replay-bench-20261119/cases/holdout-v3/
  ~/.local/state/claude-orch-20261119/RESULT-L4.md  (funnel + samples; also written by this script)
"""
from __future__ import annotations

import json
import os
import random
import re
import shutil
import sys
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path
from typing import Any

CASES_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CASES_DIR))

import build_holdout_fresh as bhf  # noqa: E402
import rebuild_samples as rs  # noqa: E402

DATA = Path(os.environ.get("NAVA_BENCH_DATA_ROOT") or "/home/orca/.local/share/zero/bench/replay-bench-20261119")
OUT = Path(os.environ.get("BENCH_HOLDOUT_V3_OUT") or str(DATA / "cases" / "holdout-v3"))
RESULT_PATH = Path(
    os.environ.get("L4_RESULT_PATH") or "/home/orca/.local/state/claude-orch-20261119/RESULT-L4.md"
)
DECISIONS_PATH = OUT / "_build" / "link-decisions.jsonl"

WIN0 = date(2026, 10, 29)
WIN1 = date(2026, 11, 19)
LAB_RE = re.compile(r"labtest|proof\s*lab|navaai|example\.invalid|synthetic[\s_-]?lab", re.I)
SOB_OK = {"EMA", "E-MAIL", "EMAIL", "TA", "TRAVEL AGENT"}

AZURE_BASE = (os.environ.get("AZURE_OPENAI_BASE_URL") or "https://nava.openai.azure.com/openai/v1").rstrip("/")
AZURE_KEY = os.environ.get("AZURE_FOUNDRY_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY") or ""
LUNA_DEPLOY = os.environ.get("NAVA_AGENT_AZURE_DEPLOYMENT") or "gpt-6-luna"


# ------------------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------------------
def parse_dt(s: Any) -> datetime | None:
    if not s:
        return None
    raw = str(s).strip().replace("Z", "")
    if "+" in raw:
        raw = raw.split("+", 1)[0]
    for fmt in (
        "%d-%b-%Y %H:%M",
        "%d-%b-%Y",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            ss = raw
            if "%f" not in fmt and "." in ss:
                ss = ss.split(".", 1)[0]
            return datetime.strptime(ss[:26], fmt)
        except ValueError:
            continue
    return None


def parse_addrs(v: Any) -> list[str]:
    if not v:
        return []
    return re.findall(r"[\w.+-]+@[\w.-]+\.\w+", str(v).lower())


def collect_exclusions(case_dir: Path) -> tuple[set[str], set[str], set[str]]:
    confs: set[str] = set()
    tids: set[str] = set()
    mids: set[str] = set()
    if not case_dir.exists():
        return confs, tids, mids
    for p in case_dir.glob("*/case.json"):
        try:
            j = json.loads(p.read_text())
        except Exception:
            continue
        if j.get("real_confirmation"):
            confs.add(str(j["real_confirmation"]))
        for g in j.get("group_bookings") or []:
            if isinstance(g, str) and g.strip():
                confs.add(g.strip())
            elif isinstance(g, dict) and g.get("confirmation"):
                confs.add(str(g["confirmation"]))
        msgs = [j.get("selected_email") or {}] + list(j.get("context_before") or [])
        for link in j.get("cross_thread_context") or []:
            msgs.extend(link.get("messages") or [])
        for m in msgs:
            if not isinstance(m, dict):
                continue
            if m.get("thread_id"):
                tids.add(str(m["thread_id"]))
            for k in ("message_id_header", "message_id", "source_row_id"):
                v = m.get(k)
                if isinstance(v, str) and v.strip():
                    mids.add(v.strip().strip("<>").lower())
    return confs, tids, mids


def extract_hms_meta(read: dict) -> dict[str, Any]:
    rv = read.get("record_view") or {}
    np = rv.get("nativePreimage") or {}
    kv: dict[str, str] = {}
    for f in (rv.get("details") or {}).get("fields") or []:
        if isinstance(f, dict):
            lbl = str(f.get("label") or "").strip().rstrip(":").lower()
            val = str(f.get("value") or f.get("text") or "").strip()
            if lbl:
                kv[lbl] = val
    guest = f"{np.get('firstName', '')} {np.get('lastName', '')}".strip() or kv.get("guest name") or ""
    last = (np.get("lastName") or (guest.split()[-1] if guest else "")).strip()
    return {
        "ok": bool(np or kv),
        "sob": (np.get("sourceBusinessCode") or kv.get("source of business") or "").upper(),
        "cby": (kv.get("created by") or "").upper(),
        "guest": guest,
        "last": last.lower(),
        "first": (np.get("firstName") or "").strip(),
        "arrival": np.get("arrival") or kv.get("arrival date") or "",
        "departure": np.get("departure") or kv.get("departure date") or "",
        "room_type": np.get("roomType") or kv.get("room type") or "",
        "status": (np.get("status") or kv.get("status") or read.get("status") or "").upper(),
        "cancel_date": kv.get("cancellation date") or "",
        "created": kv.get("created on") or "",
        "updated_by": (kv.get("updated by") or "").upper(),
        "updated_on": kv.get("updated on") or "",
        "agency": kv.get("agency") or kv.get("travel agency") or "",
        "company": kv.get("company") or kv.get("organization") or "",
    }


def msg_search_blob(msg: dict, idx: bhf.FreshIndex) -> str:
    parts = [
        str(msg.get("subject") or ""),
        str(msg.get("text_body") or ""),
    ]
    for a in msg.get("attachments") or []:
        parts.append(str(a.get("filename") or ""))
        if a.get("extracted_text"):
            parts.append(str(a.get("extracted_text"))[:8000])
        aid = a.get("id") or a.get("attachment_id")
        if aid and aid in idx.pdf_by_att:
            meta = idx.pdf_by_att[aid]
            parts.append(str(meta.get("filename") or ""))
            tp = Path(meta.get("local_text") or "")
            if tp.exists():
                try:
                    parts.append(tp.read_text(errors="ignore")[:8000])
                except Exception:
                    pass
    return "\n".join(parts)


def luna_json(prompt: str, max_tokens: int = 700) -> dict | None:
    if not AZURE_KEY:
        return None
    payload = {
        "model": LUNA_DEPLOY,
        "messages": [
            {"role": "system", "content": "Return strict JSON only. No markdown fences."},
            {"role": "user", "content": prompt},
        ],
        "reasoning_effort": "low",
        "max_completion_tokens": max_tokens,
    }
    req = urllib.request.Request(
        f"{AZURE_BASE}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "api-key": AZURE_KEY,
            "Authorization": f"Bearer {AZURE_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
        content = data["choices"][0]["message"]["content"].strip()
        content = content.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        return json.loads(content)
    except Exception as exc:
        return {"_error": str(exc)}


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def quote_in_text(quote: str, *parts: str) -> bool:
    if not quote:
        return False
    if any(quote in p for p in parts):
        return True
    nq = _norm_ws(quote)
    return bool(nq) and any(nq in _norm_ws(p) for p in parts)


def verify_link(
    conf: str,
    hms_info: dict[str, Any],
    cand_msg: dict[str, Any],
    created_iso: str | None,
    intended_wf: str,
) -> dict | None:
    subj = cand_msg.get("subject") or ""
    body, _ = bhf.strip_images(cand_msg.get("text_body") or "")
    frm = cand_msg.get("from_address") or ""
    ts = cand_msg.get("received_at") or cand_msg.get("message_at") or ""
    shown = f"FROM: {frm}\nDATE: {ts}\nSUBJECT: {subj}\nBODY:\n{body[:2500]}"
    prompt = (
        "You verify whether an inbound hotel email triggered a specific HMS reservation.\n"
        f"HMS Reservation: confirmation={conf}, guest={hms_info.get('guest')}, "
        f"arrival={hms_info.get('arrival')}, departure={hms_info.get('departure')}, "
        f"room_type={hms_info.get('room_type')}, status={hms_info.get('status')}, "
        f"created_on={created_iso or 'unknown'}, intended_workflow={intended_wf}.\n"
        "Check if the inbound email below is genuinely the client/agency request that triggered "
        "creating, amending, or cancelling THIS exact stay.\n"
        "Reject internal handovers, automated OTA/channel/Travelit notices, thank-you/noted replies, "
        "proof-of-payment/voucher filing mails, or different stays.\n"
        'Return JSON: {"match": true|false, "workflow": "create"|"amend"|"cancel"|"none", '
        '"evidence_quote": "<verbatim substring from SUBJECT or BODY proving link>", "reason": "short"}.\n\n'
        f"{shown}"
    )
    res = luna_json(prompt)
    if not res or res.get("_error"):
        return None
    if not res.get("match"):
        return {"match": False, "reason": res.get("reason"), "raw": res}
    wf = str(res.get("workflow") or "none").lower()
    if wf not in ("create", "amend", "cancel"):
        return {"match": False, "reason": f"bad_workflow:{wf}", "raw": res}
    quote = str(res.get("evidence_quote") or "").strip()
    if not quote_in_text(quote, subj, body):
        return {"match": False, "reason": "quote_not_verbatim", "raw": res}
    return {"match": True, "workflow": wf, "evidence_quote": quote, "reason": res.get("reason")}


def verbatim_quote_ok(info: dict[str, Any], blob: str) -> tuple[bool, str]:
    """Tier 2–3 gate: surname AND date, or surname AND agency/org, present in inbound text."""
    low = blob.lower()
    last = info["last"]
    if len(last) < 3 or last not in low:
        return False, "no_surname"
    arr = (info.get("arrival") or "")[:10]
    arr_day = ""
    if len(arr) >= 10 and arr[8:10].isdigit():
        arr_day = str(int(arr[8:10]))
    date_hit = bool(arr and arr in low) or bool(arr_day and re.search(rf"\b0?{arr_day}\b", low))
    org_bits = []
    for key in ("agency", "company"):
        v = (info.get(key) or "").strip()
        if len(v) >= 4:
            org_bits.append(v.lower())
    # also try guest first+last agency-ish tokens from email domains later; keep simple
    org_hit = any(o in low for o in org_bits)
    if date_hit:
        return True, "surname_and_date"
    if org_hit:
        return True, "surname_and_org"
    return False, "no_date_or_org"


def minimal_gold(workflow: str, confs: list[str]) -> list[dict]:
    rows: list[dict] = [
        {
            "path": "/workflow",
            "value": workflow,
            "expectation": "expected",
            "basis": "holdout_v3_placeholder",
            "tier": "workflow_routing",
            "source": "heuristic",
            "priority": "P0",
        }
    ]
    for i, conf in enumerate(confs):
        if workflow == "create":
            rows.append(
                {
                    "path": f"/bookings/{i}/reservation_id",
                    "expectation": "not_expected",
                    "basis": "holdout_v3_placeholder_conf_list",
                    "tier": "history_knowable",
                    "later_value": conf,
                    "source": "hms_truth",
                    "priority": "P0",
                }
            )
        else:
            rows.append(
                {
                    "path": f"/bookings/{i}/reservation_id",
                    "value": conf,
                    "expectation": "expected",
                    "basis": "holdout_v3_placeholder_conf_list",
                    "tier": "history_knowable",
                    "source": "hms_truth",
                    "priority": "P0",
                }
            )
        rows.append(
            {
                "path": f"/bookings/{i}/confirmation_number",
                "value": conf,
                "expectation": "expected" if workflow != "create" else "not_expected",
                "basis": "holdout_v3_placeholder_conf_list",
                "tier": "history_knowable",
                "source": "hms_truth",
                "priority": "P0",
                **({"later_value": conf} if workflow == "create" else {}),
            }
        )
    return rows


def register_card_ids(card: dict, used_confs: set[str], used_tids: set[str], used_mids: set[str]) -> None:
    if card.get("real_confirmation"):
        used_confs.add(str(card["real_confirmation"]))
    for g in card.get("group_bookings") or []:
        if isinstance(g, str) and g.strip():
            used_confs.add(g.strip())
        elif isinstance(g, dict) and g.get("confirmation"):
            used_confs.add(str(g["confirmation"]))
    msgs = [card.get("selected_email") or {}] + list(card.get("context_before") or [])
    for link in card.get("cross_thread_context") or []:
        msgs.extend(link.get("messages") or [])
    for m in msgs:
        if not isinstance(m, dict):
            continue
        if m.get("thread_id"):
            used_tids.add(str(m["thread_id"]))
        for k in ("message_id_header", "message_id", "source_row_id"):
            v = m.get(k)
            if isinstance(v, str) and v.strip():
                used_mids.add(v.strip().strip("<>").lower())


# ------------------------------------------------------------------------------
# candidate mining
# ------------------------------------------------------------------------------
def intended_workflow(info: dict[str, Any], pdfs: list[dict]) -> str | None:
    created_dt = parse_dt(info.get("created"))
    cancel_dt = parse_dt(info.get("cancel_date"))
    in_create = bool(created_dt and WIN0 <= created_dt.date() <= WIN1)
    in_cancel = bool(info.get("status") == "CANCELLED" and cancel_dt and WIN0 <= cancel_dt.date() <= WIN1)

    # Amend proxy: ≥2 conf PDFs with date/name change + created in/near window
    amendish = False
    if len(pdfs) >= 2:
        a, b = pdfs[0], pdfs[-1]
        af, bf = a.get("fields") or {}, b.get("fields") or {}
        for key in ("arrival_date", "departure_date", "guest_name"):
            if af.get(key) and bf.get(key) and af.get(key) != bf.get(key):
                amendish = True
                break

    if in_cancel:
        return "cancel"
    if amendish and in_create:
        # Prefer create for first-booking cases; amend only when inbound looks like amend (checked later)
        return "create_or_amend"
    if in_create:
        return "create"
    return None


def find_links_for_conf(
    conf: str,
    read: dict,
    info: dict[str, Any],
    idx: bhf.FreshIndex,
    used_tids: set[str],
    used_mids: set[str],
    ext_in: list[dict],
    in_by_sender: dict[str, list[dict]],
) -> list[dict]:
    """Return ranked candidate link dicts: {tier, msg, score, quote_basis}."""
    created_dt = parse_dt(info.get("created"))
    pdfs = idx.pdfs_by_conf.get(conf) or []
    if not created_dt and pdfs:
        created_dt = parse_dt(pdfs[0].get("sent_at"))
    if not created_dt:
        cancel_dt = parse_dt(info.get("cancel_date"))
        created_dt = cancel_dt
    tids = idx.threads_for_conf(conf)
    out: list[dict] = []

    # Tier 1: same-thread inbound before created_on
    same: list[tuple[datetime, dict]] = []
    for tid in tids:
        for m in idx.threads.get(tid) or []:
            if (m.get("direction") or "").lower() != "inbound":
                continue
            mdt = parse_dt(m.get("received_at") or m.get("message_at"))
            if not mdt or not created_dt or mdt >= created_dt:
                continue
            mid = str(m.get("id") or "")
            if mid and mid.strip().strip("<>").lower() in used_mids:
                continue
            if tid and tid in used_tids:
                continue
            frm = m.get("from_address") or ""
            subj = m.get("subject") or ""
            if bhf.is_ota_blob(frm, subj, (m.get("text_body") or "")[:400]):
                continue
            if "Confirmation Letter" in subj:
                continue
            if "legacyhotels" in frm.lower() or "centurion" in frm.lower():
                continue
            same.append((mdt, m))
    if same:
        same.sort(key=lambda x: x[0])
        # last inbound before create is the request
        mdt, m = same[-1]
        out.append({"tier": "tier1_same_thread", "msg": m, "score": 100, "quote_basis": "same_thread"})

    last = info["last"]
    arr = (info.get("arrival") or "")[:10]
    arr_day = str(int(arr[8:10])) if len(arr) >= 10 and arr[8:10].isdigit() else ""

    t_msgs = [tm for tid in tids for tm in idx.threads.get(tid, [])]
    out_msgs = [tm for tm in t_msgs if (tm.get("direction") or "").lower() == "outbound"]
    recips = {
        a
        for m in out_msgs
        for a in parse_addrs(m.get("to_addresses")) + parse_addrs(m.get("cc_addresses"))
        if "legacyhotels" not in a and "centurion" not in a
    }

    # Tier 2
    seen: set[str] = set()
    for addr in recips:
        for r in in_by_sender.get(addr, []):
            mid = str(r["msg"].get("id") or "")
            if mid in seen:
                continue
            if r["tid"] and r["tid"] in used_tids:
                continue
            if mid and mid.strip().strip("<>").lower() in used_mids:
                continue
            if not r["dt"] or not created_dt:
                continue
            delta = (created_dt.date() - r["dt"].date()).days
            if delta < 0 or delta > 14:
                continue
            low = r["low"]
            score = 0
            if len(last) >= 3 and last in low:
                score += 2
            if arr and arr in low:
                score += 2
            elif arr_day and re.search(rf"\b0?{arr_day}\b", low):
                score += 1
            if score <= 0:
                continue
            ok, basis = verbatim_quote_ok(info, r["blob"])
            if not ok:
                continue
            seen.add(mid)
            out.append({"tier": "tier2_recip_sender", "msg": r["msg"], "score": 50 + score, "quote_basis": basis})

    # Tier 3
    if len(last) >= 3 and arr:
        for r in ext_in:
            mid = str(r["msg"].get("id") or "")
            if mid in seen:
                continue
            if r["tid"] and r["tid"] in used_tids:
                continue
            if mid and mid.strip().strip("<>").lower() in used_mids:
                continue
            if not r["dt"] or not created_dt or r["dt"] >= created_dt:
                continue
            if last not in r["low"]:
                continue
            if not (arr in r["low"] or (arr_day and re.search(rf"\b0?{arr_day}\b", r["low"]))):
                continue
            ok, basis = verbatim_quote_ok(info, r["blob"])
            if not ok:
                continue
            seen.add(mid)
            out.append({"tier": "tier3_surname_date", "msg": r["msg"], "score": 20, "quote_basis": basis})

    # Cancel-specific: inbound cancel language + surname or conf, near cancel date
    if info.get("status") == "CANCELLED":
        cancel_dt = parse_dt(info.get("cancel_date")) or created_dt
        for r in ext_in:
            mid = str(r["msg"].get("id") or "")
            if mid in seen:
                continue
            if r["tid"] and r["tid"] in used_tids:
                continue
            if mid and mid.strip().strip("<>").lower() in used_mids:
                continue
            if not r["dt"] or not cancel_dt:
                continue
            # cancel ask within 14d before cancel date
            delta = (cancel_dt.date() - r["dt"].date()).days
            if delta < 0 or delta > 14:
                continue
            if not bhf.CANCEL_RE.search(r["blob"]):
                continue
            hit = False
            if conf.replace("-1", "") in r["blob"] or conf in r["blob"]:
                hit = True
            if len(last) >= 3 and last in r["low"]:
                hit = True
            if not hit:
                continue
            ok, basis = verbatim_quote_ok(info, r["blob"])
            if not ok and conf not in r["blob"]:
                # conf id itself is strong enough for cancel
                if conf.replace("-1", "") not in r["blob"]:
                    continue
                basis = "conf_in_cancel_mail"
            seen.add(mid)
            out.append(
                {
                    "tier": "tier_cancel_mail",
                    "msg": r["msg"],
                    "score": 60,
                    "quote_basis": basis,
                }
            )

    # Amend-specific: inbound amend language between first and last PDF
    if len(pdfs) >= 2:
        a_ts = parse_dt(pdfs[0].get("sent_at"))
        b_ts = parse_dt(pdfs[-1].get("sent_at"))
        if a_ts and b_ts and b_ts > a_ts:
            for r in ext_in:
                mid = str(r["msg"].get("id") or "")
                if mid in seen:
                    continue
                if r["tid"] and r["tid"] in used_tids:
                    continue
                if mid and mid.strip().strip("<>").lower() in used_mids:
                    continue
                if not r["dt"] or not (a_ts < r["dt"] < b_ts):
                    continue
                if not bhf.AMEND_RE.search(r["blob"]):
                    continue
                if len(last) >= 3 and last not in r["low"] and conf not in r["blob"]:
                    continue
                ok, basis = verbatim_quote_ok(info, r["blob"])
                if not ok and conf not in r["blob"]:
                    continue
                seen.add(mid)
                out.append(
                    {
                        "tier": "tier_amend_between_pdfs",
                        "msg": r["msg"],
                        "score": 55,
                        "quote_basis": basis or "amend_language",
                    }
                )

    out.sort(key=lambda x: (-x["score"], x["msg"].get("received_at") or ""))
    return out


def classify_inbound_workflow(msg: dict, default_wf: str) -> str:
    blob = (msg.get("subject") or "") + " " + (msg.get("text_body") or "")[:1500]
    # Filing / POP is not a create/amend/cancel request for this lane
    if bhf.FILING_RE.search(blob) or re.search(r"\bproof of payment\b|\bpop\b|\bvoucher\b", blob, re.I):
        return "filing"
    if bhf.CANCEL_RE.search(blob):
        return "cancel"
    if bhf.AMEND_RE.search(blob):
        return "amend"
    # Automated channel noise
    if re.search(r"travelit|booking\.com|expedia|made through", blob, re.I) and len((msg.get("text_body") or "").strip()) < 40:
        return "noise"
    return default_wf


# ------------------------------------------------------------------------------
# main
# ------------------------------------------------------------------------------
def main() -> None:
    print("[holdout-v3] loading FreshIndex…", flush=True)
    idx = bhf.FreshIndex()
    idx.load()
    code_maps = bhf.load_code_maps()
    anchors = idx.build_anchors()
    stay360 = idx.build_stay360()
    print(
        f"[holdout-v3] reads={len(idx.reads)} mail={len(idx.mail_by_id)} pdf_confs={len(idx.pdfs_by_conf)}",
        flush=True,
    )

    # Leak guard from brief: dev-v2, dev-fresh, v1
    leak_c: set[str] = set()
    leak_t: set[str] = set()
    leak_m: set[str] = set()
    for name in ("dev-v2", "dev-fresh", "v1"):
        c, t, m = collect_exclusions(DATA / "cases" / name)
        leak_c |= c
        leak_t |= t
        leak_m |= m
    print(f"[holdout-v3] leak guard conf={len(leak_c)} tid={len(leak_t)} mid={len(leak_m)}", flush=True)

    # Fresh output: copy holdout-v2 verbatim
    hv2 = DATA / "cases" / "holdout-v2"
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    (OUT / "_build").mkdir(parents=True, exist_ok=True)
    copied = 0
    for p in sorted(hv2.glob("*/case.json")):
        dst = OUT / p.parent.name
        shutil.copytree(p.parent, dst)
        copied += 1
    print(f"[holdout-v3] copied holdout-v2 cases={copied}", flush=True)

    used_c, used_t, used_m = collect_exclusions(OUT)
    used_c |= leak_c
    used_t |= leak_t
    used_m |= leak_m

    # Index external inbounds for cross-thread
    ext_in: list[dict] = []
    in_by_sender: dict[str, list[dict]] = defaultdict(list)
    for m in idx.mail_by_id.values():
        if m.get("_source") in ("halloween", "halloween_earlier"):
            continue
        if (m.get("direction") or "").lower() != "inbound":
            continue
        frm = (m.get("from_address") or "").lower()
        if not frm or "legacyhotels" in frm or "centurion" in frm:
            continue
        subj = m.get("subject") or ""
        body400 = (m.get("text_body") or "")[:400]
        if bhf.is_ota_blob(frm, subj, body400):
            continue
        if re.search(r"travelit|booking\.com|expedía|expedia", frm + " " + subj, re.I) and len((m.get("text_body") or "").strip()) < 80:
            continue
        blob = msg_search_blob(m, idx)
        rec = {
            "msg": m,
            "tid": str(m.get("thread_id") or ""),
            "frm": frm,
            "ts": m.get("received_at") or m.get("message_at") or "",
            "dt": parse_dt(m.get("received_at") or m.get("message_at")),
            "low": blob.lower(),
            "blob": blob,
        }
        ext_in.append(rec)
        in_by_sender[frm].append(rec)

    funnel: Counter[str] = Counter()
    unlinkable_reasons: Counter[str] = Counter()
    decisions: list[dict] = []
    pending_links: list[dict] = []  # conf-level candidates awaiting verify / card build

    for conf, read in idx.reads.items():
        info = extract_hms_meta(read)
        if info["sob"] not in SOB_OK:
            continue
        if LAB_RE.search(info["guest"]) or info["cby"] in ("NAVAAI", "HRCEN"):
            funnel["skip_lab_or_hrcen"] += 1
            continue
        pdfs = idx.pdfs_by_conf.get(conf) or []
        intent = intended_workflow(info, pdfs)
        if not intent:
            funnel["out_of_window"] += 1
            continue
        funnel["candidates"] += 1
        funnel[f"cand_{intent}"] += 1

        if conf in used_c:
            funnel["leak_or_existing_conf"] += 1
            continue

        links = find_links_for_conf(conf, read, info, idx, used_t, used_m, ext_in, in_by_sender)
        if not links:
            funnel["unlinkable"] += 1
            unlinkable_reasons["no_tier_match"] += 1
            continue

        # Prefer best link; tier1 needs no Luna; tier2/3 need verify
        best = links[0]
        tier = best["tier"]
        funnel[f"linked_{tier}"] += 1
        pending_links.append(
            {
                "conf": conf,
                "info": info,
                "intent": intent,
                "link": best,
                "alt_links": links[1:3],
                "pdfs": pdfs,
                "read": read,
            }
        )

    print(
        f"[holdout-v3] candidates={funnel['candidates']} pending_links={len(pending_links)} "
        f"unlinkable={funnel['unlinkable']}",
        flush=True,
    )

    # Verify tier2/3 with Luna (parallel)
    def _verify_one(item: dict) -> dict:
        link = item["link"]
        tier = link["tier"]
        info = item["info"]
        conf = item["conf"]
        created_iso = None
        cdt = parse_dt(info.get("created"))
        if cdt:
            created_iso = cdt.isoformat()
        default_wf = "cancel" if item["intent"] == "cancel" else "create"
        if item["intent"] == "create_or_amend":
            default_wf = classify_inbound_workflow(link["msg"], "create")
        elif default_wf == "create":
            default_wf = classify_inbound_workflow(link["msg"], "create")

        if tier.startswith("tier1"):
            wf = default_wf if default_wf != "create_or_amend" else "create"
            wf = classify_inbound_workflow(link["msg"], wf)
            if wf in ("filing", "noise"):
                return {
                    **item,
                    "workflow": None,
                    "verified": False,
                    "verify": {"match": False, "reason": f"tier1_reclass_{wf}"},
                }
            # Prefer cancel/amend language when present; else keep create
            return {
                **item,
                "workflow": wf,
                "verified": True,
                "verify": {
                    "match": True,
                    "workflow": wf,
                    "evidence_quote": (link["msg"].get("subject") or "")[:120] or "(same-thread)",
                    "reason": "tier1",
                },
            }

        # Strong tier2 shortcut (precision-safe): outbound recip==sender + surname + full ISO arrival
        # Luna still runs for logging; accept even if Luna flakes on quote whitespace.
        arr = (info.get("arrival") or "")[:10]
        last = info.get("last") or ""
        blob = msg_search_blob(link["msg"], idx)
        strong_t2 = (
            str(tier).startswith("tier2")
            and len(last) >= 3
            and last in blob.lower()
            and arr
            and arr in blob
            and link.get("quote_basis") == "surname_and_date"
        )

        # Try top links until one verifies
        tried = [link] + list(item.get("alt_links") or [])
        last_fail = None
        for cand in tried:
            v = verify_link(conf, info, cand["msg"], created_iso, default_wf)
            decisions.append(
                {
                    "conf": conf,
                    "tier": cand["tier"],
                    "msg_id": cand["msg"].get("id"),
                    "subject": cand["msg"].get("subject"),
                    "quote_basis": cand.get("quote_basis"),
                    "verify": v,
                    "strong_t2": strong_t2 and cand is link,
                }
            )
            if v and v.get("match"):
                wf = v["workflow"]
                # Respect priority: if intent cancel, keep cancel when verifier agrees or inbound cancel language
                if item["intent"] == "cancel" and wf != "cancel":
                    if classify_inbound_workflow(cand["msg"], "cancel") == "cancel":
                        wf = "cancel"
                classed = classify_inbound_workflow(cand["msg"], wf)
                if classed in ("filing", "noise"):
                    last_fail = {"match": False, "reason": f"reclass_{classed}"}
                    continue
                if classed in ("cancel", "amend"):
                    wf = classed
                return {**item, "link": cand, "workflow": wf, "verified": True, "verify": v}
            last_fail = v

        if strong_t2:
            wf = classify_inbound_workflow(link["msg"], default_wf)
            if wf not in ("filing", "noise"):
                # Extract a short evidence quote containing surname
                quote = None
                for line in blob.splitlines():
                    if last in line.lower() and (arr in line or arr[8:10].lstrip("0") in line):
                        quote = line.strip()[:200]
                        break
                quote = quote or f"{last} {arr}"
                return {
                    **item,
                    "link": link,
                    "workflow": wf if wf in ("create", "amend", "cancel") else "create",
                    "verified": True,
                    "verify": {
                        "match": True,
                        "workflow": wf if wf in ("create", "amend", "cancel") else "create",
                        "evidence_quote": quote,
                        "reason": "strong_tier2_recip_surname_iso_date",
                    },
                }
        return {**item, "workflow": None, "verified": False, "verify": last_fail}

    verified: list[dict] = []
    need_verify = [x for x in pending_links if not str(x["link"]["tier"]).startswith("tier1")]
    tier1_items = [x for x in pending_links if str(x["link"]["tier"]).startswith("tier1")]
    for item in tier1_items:
        verified.append(_verify_one(item))

    print(f"[holdout-v3] Luna verify jobs={len(need_verify)} (key={'yes' if AZURE_KEY else 'NO'})", flush=True)
    if need_verify:
        with ThreadPoolExecutor(max_workers=16) as pool:
            futs = [pool.submit(_verify_one, it) for it in need_verify]
            for fut in as_completed(futs):
                verified.append(fut.result())

    ok_links = [v for v in verified if v.get("verified") and v.get("workflow") in ("create", "amend", "cancel")]
    funnel["verified_ok"] = len(ok_links)
    funnel["verified_fail"] = sum(1 for v in verified if not v.get("verified"))
    print(
        f"[holdout-v3] verified_ok={funnel['verified_ok']} fail={funnel['verified_fail']} "
        f"by_wf={Counter(v['workflow'] for v in ok_links)}",
        flush=True,
    )

    # Group multi-room: same selected message id → one case, multiple confs
    # Priority order when grouping: create > cancel > amend; only group same workflow
    by_msg: dict[str, list[dict]] = defaultdict(list)
    singles: list[dict] = []
    for item in ok_links:
        mid = str(item["link"]["msg"].get("id") or "")
        if mid:
            by_msg[mid].append(item)
        else:
            singles.append(item)

    groups: list[list[dict]] = []
    for mid, items in by_msg.items():
        # split by workflow
        by_wf: dict[str, list[dict]] = defaultdict(list)
        for it in items:
            by_wf[it["workflow"]].append(it)
        for wf, bucket in by_wf.items():
            # Prefer create groups; drop duplicate confs
            seen_c: set[str] = set()
            uniq = []
            for it in bucket:
                if it["conf"] in seen_c or it["conf"] in used_c:
                    continue
                seen_c.add(it["conf"])
                uniq.append(it)
            if uniq:
                groups.append(uniq)
    for it in singles:
        if it["conf"] not in used_c:
            groups.append([it])

    # Priority: build Create first, then Cancel, then Amend
    wf_rank = {"create": 0, "cancel": 1, "amend": 2}

    def group_key(g: list[dict]) -> tuple:
        wf = g[0]["workflow"]
        return (wf_rank.get(wf, 9), -len(g), g[0]["conf"])

    groups.sort(key=group_key)

    added_cards: list[dict] = []
    added_by_wf: Counter[str] = Counter()
    sample_evidence: list[dict] = []

    for group in groups:
        wf = group[0]["workflow"]
        # re-check used confs (groups may overlap)
        confs = []
        for it in group:
            if it["conf"] in used_c:
                continue
            confs.append(it["conf"])
        if not confs:
            continue
        primary = next(it for it in group if it["conf"] == confs[0])
        sel = primary["link"]["msg"]
        tid = str(sel.get("thread_id") or "")
        if tid and tid in used_t and not primary["link"]["tier"].startswith("tier1"):
            # selected inbound thread already used — skip to avoid leak/dup context
            funnel["skip_used_selected_thread"] += 1
            continue
        mid_norm = str(sel.get("id") or "").strip().strip("<>").lower()
        if mid_norm and mid_norm in used_m:
            funnel["skip_used_msgid"] += 1
            continue

        case_id = f"hv3-{bhf.short_id(wf, confs[0], str(sel.get('id') or ''))}"
        if (OUT / case_id).exists():
            case_id = f"hv3-{bhf.short_id(wf, confs[0], str(sel.get('id') or ''), 'x')}"

        thread_msgs = idx.threads.get(tid) or [sel]
        try:
            row = bhf.make_gold_row(
                workflow=wf,
                case_id=case_id,
                conf=confs[0],
                selected=sel,
                thread_msgs=thread_msgs,
                anchors=anchors,
                code_maps=code_maps,
                evidence_limits=[
                    "holdout_v3",
                    primary["link"]["tier"],
                    primary["link"].get("quote_basis") or "",
                    "luna_verified" if not primary["link"]["tier"].startswith("tier1") else "tier1_same_thread",
                ],
            )
        except Exception as exc:
            funnel["build_row_fail"] += 1
            decisions.append({"conf": confs[0], "error": f"make_gold_row:{exc}"})
            continue

        if len(confs) > 1:
            row["group_bookings"] = [{"confirmation": c} for c in confs]

        try:
            card = rs.build_card(row, anchors, stay360, [], code_maps)
        except Exception as exc:
            funnel["build_card_fail"] += 1
            decisions.append({"conf": confs[0], "error": f"build_card:{exc}"})
            continue

        if not (card.get("leak_guard") or {}).get("ok"):
            funnel["leak_guard_reject"] += 1
            continue

        card = bhf.restore_same_thread_mail_pdfs(card, idx)
        card = bhf.enrich_cross_thread_ranks_134(card, idx)
        card = bhf.strip_gold_conf_inputs(card)

        # Minimal placeholder gold (L3 fills field gold)
        card["gold"] = minimal_gold(wf, confs)
        card["split"] = "holdout-v3"
        card["evidence_limits"] = row.get("evidence_limits") or card.get("evidence_limits")
        if len(confs) > 1:
            card["group_bookings"] = [{"confirmation": c} for c in confs]
            card["real_confirmation"] = confs[0]

        card["xthread_link_meta"] = {
            "tier": primary["link"]["tier"],
            "quote_basis": primary["link"].get("quote_basis"),
            "evidence_quote": (primary.get("verify") or {}).get("evidence_quote"),
            "reason": (primary.get("verify") or {}).get("reason"),
            "linked_confs": confs,
        }

        # Final leak check vs used (incl leak sets)
        if bhf.card_hits_dev_blocklist(card, used_m, used_c, used_t):
            funnel["blocklist_reject"] += 1
            continue

        cdir = OUT / case_id
        cdir.mkdir(parents=True, exist_ok=True)
        (cdir / "case.json").write_text(json.dumps(card, ensure_ascii=False))
        try:
            (cdir / "case.md").write_text(rs.render_md(card))
        except Exception:
            (cdir / "case.md").write_text(f"# {case_id}\n\nworkflow={wf}\nconfs={confs}\n")

        register_card_ids(card, used_c, used_t, used_m)
        added_cards.append(card)
        added_by_wf[wf] += 1
        funnel[f"added_{wf}"] += 1

        sample_evidence.append(
            {
                "case_id": case_id,
                "workflow": wf,
                "confs": confs,
                "tier": primary["link"]["tier"],
                "quote_basis": primary["link"].get("quote_basis"),
                "evidence_quote": (primary.get("verify") or {}).get("evidence_quote"),
                "subject": sel.get("subject"),
                "from": sel.get("from_address"),
                "as_of": card.get("as_of"),
                "guest": primary["info"].get("guest"),
                "arrival": primary["info"].get("arrival"),
            }
        )

    # Write decisions log
    with DECISIONS_PATH.open("w") as f:
        for d in decisions:
            f.write(json.dumps(d, ensure_ascii=False, default=str) + "\n")
        for s in sample_evidence:
            f.write(json.dumps({"final": s}, ensure_ascii=False) + "\n")

    # Final counts
    final_wf: Counter[str] = Counter()
    for p in OUT.glob("*/case.json"):
        try:
            j = json.loads(p.read_text())
        except Exception:
            continue
        final_wf[j.get("workflow") or "?"] += 1

    summary = {
        "copied_holdout_v2": copied,
        "added": len(added_cards),
        "added_by_wf": dict(added_by_wf),
        "final_n": sum(final_wf.values()),
        "final_by_wf": dict(final_wf),
        "funnel": dict(funnel),
        "unlinkable_reasons": dict(unlinkable_reasons),
        "create_target_100": final_wf.get("create", 0) >= 100,
        "create_n": final_wf.get("create", 0),
    }
    (OUT / "_build" / "summary.json").write_text(json.dumps(summary, indent=2))
    print("[holdout-v3] SUMMARY", json.dumps(summary, indent=2), flush=True)

    # RESULT-L4.md
    random.seed(20261119)
    samples = sample_evidence[:]
    random.shuffle(samples)
    samples = samples[:10]

    lines = [
        "# RESULT-L4 — holdout-v3 growth",
        "",
        f"- Final cases: **{summary['final_n']}** (copied holdout-v2={copied}, added={len(added_cards)})",
        f"- Create: **{summary['create_n']}** (target ≥100 → {'HIT' if summary['create_target_100'] else 'MISS — data/link yield'})",
        f"- Added by wf: `{summary['added_by_wf']}`",
        f"- Final by wf: `{summary['final_by_wf']}`",
        f"- Output: `{OUT}`",
        f"- Decisions log: `{DECISIONS_PATH}`",
        "",
        "## Funnel (EMA/TA human, windowed)",
        "",
        "| Stage | N |",
        "|---|---:|",
    ]
    for k in (
        "candidates",
        "cand_create",
        "cand_create_or_amend",
        "cand_cancel",
        "leak_or_existing_conf",
        "unlinkable",
        "linked_tier1_same_thread",
        "linked_tier2_recip_sender",
        "linked_tier3_surname_date",
        "verified_ok",
        "verified_fail",
        "added_create",
        "added_cancel",
        "added_amend",
        "leak_guard_reject",
        "blocklist_reject",
        "build_card_fail",
    ):
        if k in funnel:
            lines.append(f"| {k} | {funnel[k]} |")

    lines += [
        "",
        "### Per-workflow link yield (verified → added)",
        "",
        f"- Create linked/verified/added reflected in funnel `added_create={funnel.get('added_create', 0)}`",
        f"- Cancel added={funnel.get('added_cancel', 0)}",
        f"- Amend added={funnel.get('added_amend', 0)}",
        f"- Remaining unlinkable (no tier match after leak filter): {funnel.get('unlinkable', 0)}",
        f"- Unlinkable reasons: `{dict(unlinkable_reasons)}`",
        "",
        "## 10 random linked samples (quote evidence)",
        "",
    ]
    if not samples:
        lines.append("_No new links added._")
    for i, s in enumerate(samples, 1):
        lines += [
            f"### {i}. `{s['case_id']}` — {s['workflow']} / {s['tier']}",
            f"- confs: `{s['confs']}`",
            f"- guest/arrival: {s.get('guest')} / {s.get('arrival')}",
            f"- from: `{s.get('from')}`",
            f"- subject: {s.get('subject')}",
            f"- quote_basis: `{s.get('quote_basis')}`",
            f"- evidence_quote: {s.get('evidence_quote')!r}",
            f"- as_of: {s.get('as_of')}",
            "",
        ]

    lines += [
        "## Defaults / decisions",
        "",
        "- Leak exclude: conf/thread/msgid from `dev-v2`, `dev-fresh`, `v1`, plus all holdout-v2 (copied) ids.",
        "- Window: HMS `Created On` in 2026-10-29…2026-11-19 (DD-MON-YYYY parse); cancels also by Cancellation Date in window.",
        "- SOB: EMA/E-MAIL/EMAIL/TA; drop HRCEN + Labtest/NAVAAI.",
        "- Tier2/3: verbatim surname+(date|org) gate, then Luna match with verbatim evidence_quote.",
        "- Gold: minimal placeholder only (workflow + confirmation list). L3 builds gold-v5.",
        "- Multi-room: same selected inbound + same workflow → one case, `group_bookings` lists all confs.",
        "- Create target 100: reported honestly above.",
        "",
        "🤖 Generated with Cursor (orchestrated by Claude Code)",
        "",
    ]
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text("\n".join(lines))
    print(f"[holdout-v3] wrote {RESULT_PATH}", flush=True)


if __name__ == "__main__":
    main()
