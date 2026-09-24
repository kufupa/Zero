# Centurion email → PMS tool demand handoff

> **Historical quote note (superseded 2026-09-17):** This demand handoff predates the client-approved Hotel Availability workflow. Any older Room Availability/Display Rates quote wording is evidence history, not execution guidance; current `hms_quote_stay` work uses Hotel Availability and read-only Availability Details. CRS Check Availability remains a write path.

**Date:** 2026-08-03  
**Audience:** any LLM / engineer with **zero prior context**  
**Purpose:** reproduce the email pull + analysis process, honor guardrails, and use the tool conclusions without re-deriving from chat history.

This doc consolidates:

1. How we pull and analyse Centurion mailbox data  
2. User goals and safety guardrails  
3. Corpus snapshots and method caveats  
4. What each recommended tool does and why  
5. Write vs read policy (discovery vs shipped tools)  
6. Revised ranking after clarifying that write tools should be **designed now** but **not submitted** during autonomous discovery  

Related artifacts (same repo):

| File | Role |
| --- | --- |
| `centurion-emails-dump.md` | Flat dump (gitignored, PII) |
| `centurion-emails-by-thread.md` | Thread-collated dump (gitignored, PII) |
| `centurion-emails-index.md` | Slim subject index (gitignored) |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-04.md` | Aggregate analysis + scores (latest) |
| `docs/infor-hms/centurion-outbound-index-2026-08-04.md` | Outbound subject index (latest) |
| `docs/infor-hms/centurion-thread-collation-summary-2026-08-04.md` | Thread size/direction histograms (latest) |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-03.md` | Prior analysis snapshot |
| `docs/infor-hms/capability-matrix.md` | Infor HMS capability allow/deny matrix |
| `docs/superpowers/plans/2026-07-29-infor-hms-full-tool-portfolio-roadmap.md` | Full read/write roadmap |
| `apps/server-pilot/scripts/dump-centurion-emails-md.mjs` | RDS → Markdown dump |
| `scripts/regroup-centurion-by-thread.mjs` | Flat dump → by-thread |
| `scripts/analyse-centurion-pms-tools.mjs` | Classifier + tool scoring |
| `apps/server-pilot/deploy/ssm-run-command.sh` | Run commands on pilot EC2 via SSM |

---

## 1. Product context (one paragraph)

Nava pilots Centurion Hotel mail. Triage already ships. The drafting agent must stop inventing rates, confirmation numbers, availability, folio balances, and bill-to details. Those facts live in **Infor HMS** (and sometimes in inbound PDF vouchers). The workstream builds **deterministic Playwright tools** that read (and later, gated-write) HMS so an AI drafting agent can ground replies. Staff outbound today is mostly templated confirmation / payment-confirmation letter delivery, not freeform essays.

---

## 2. User goals (as stated)

1. Autonomously figure out which Infor / PMS tools are needed by exploring docs + the live PMS UI.  
2. **Reading is fine.** **No side-effecting writes to production PMS while discovering / building.**  
3. Use real Centurion mailbox data (refreshed every few days) to decide tool demand from actual inbound + outbound patterns.  
4. Process steps requested for the data pass:
   1. Update markdown dump on disk with most recent emails + responses  
   2. Collate threads and message order  
   3. View all Centurion outbound / response emails  
   4. Analyse every email  
   5. Extract details that require external PMS access (rates, etc.)  
   6. Recommend common tools so an AI drafting agent could draft ~100% of replies going forward (use prior sent emails to reverse-engineer needs)  
5. Later clarification (policy): shipped tools **may include write operations**. During autonomous tool-building, get all the way up to Create Reservation / Submit, but **do not click Submit** on production. Deterministic Playwright for writes must not accidentally submit. **Note write operations in tool form now.** Ranking should reflect high-volume mail that needs HMS-specific facts an LLM cannot invent (including “please book my room” when that class is large enough).

---

## 3. Hard guardrails (non-negotiable)

### 3.1 Pilot RDS / mail data

- Read-only SQL / dump scripts against pilot are OK.  
- **Never** run Vitest (or any test runner) with `DATABASE_URL` pointing at pilot/production.  
- Never set `VITEST_ALLOW_PILOT_RDS=1`.  
- Never print database URLs, credentials, private mail bodies, addresses, or other PII into prompts, logs, or chat when avoidable.  
- Full email bodies stay in **gitignored** dumps. Tracked docs are aggregates / subjects / redacted analysis only.

### 3.2 Live Infor HMS (production hotel PMS)

- **Autonomous discovery / overnight / tool-building pass:** navigate + read OK; **no create / amend / cancel / post / settle / refund / send / print / export / save / submit**.  
- Allowed pattern: open write forms, fill fields for discovery, stop at **Create / Check Availability / Wrap Up / Save / Submit**. Do not press them on production.  
- Infor CRS docs state: **“Click Check Availability. A new reservation record is created.”**  
  - Primary: https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428583967.html  
  - Therefore **CRS Check Availability is a write path**, not a safe inventory read.  
  - Safe read inventory = Front Desk **Room Availability**. Safe read rates = **Display Rates** (`bookable=false`).  
- Shipped tool **catalog** may include writes (`future_write` / human-supervised). Building real Playwright write adapters ≠ authorization to run them live. Fixture / fail-closed harness before any live write.

### 3.3 Drafting product boundary

- HITL send still required for mail unless a separate send-gate is explicitly authorized.  
- Tools replace HMS-only facts; LLM does not invent rates, conf numbers, or balances.

---

## 4. Process: pull + analyse emails

### 4.1 Refresh dump from pilot (read-only)

Run on pilot EC2 via SSM (env sourced on the instance only; do not echo secrets):

```bash
# From laptop repo root
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
bash apps/server-pilot/deploy/ssm-run-command.sh "
  export NVM_DIR=/home/ubuntu/.nvm
  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  export PATH=\"\$HOME/.local/share/pnpm:\$PATH\"
  cd /home/ubuntu/repos/zero/apps/server-pilot
  ENV_FILE=.env.production
  [ -f \"\$ENV_FILE\" ] || ENV_FILE=/home/ubuntu/.env.production
  set -a; source \"\$ENV_FILE\"; set +a
  unset VITEST_ALLOW_PILOT_RDS
  OUT=/tmp/centurion-emails-dump-\${STAMP}.md
  node scripts/dump-centurion-emails-md.mjs --out \"\$OUT\"
  head -n 8 \"\$OUT\"
  aws s3 cp \"\$OUT\" \
    s3://nava-zero-mail-845242190536-af-south-1/ops/centurion-email-analysis/centurion-emails-dump-\${STAMP}.md \
    --region af-south-1
  echo S3_KEY=ops/centurion-email-analysis/centurion-emails-dump-\${STAMP}.md
"
```

Script: `apps/server-pilot/scripts/dump-centurion-emails-md.mjs`  
- Queries `message` for transport Centurion  
- Writes one Markdown file with index + per-message metadata + text/HTML bodies  
- Read-only

Download locally (gitignored path):

```bash
aws s3 cp \
  "s3://nava-zero-mail-845242190536-af-south-1/ops/centurion-email-analysis/centurion-emails-dump-<STAMP>.md" \
  "centurion-emails-dump.md" \
  --region af-south-1
```

### 4.2 Collate by thread

```bash
node scripts/regroup-centurion-by-thread.mjs
# → centurion-emails-by-thread.md (gitignored)
```

Groups by `thread_id`, chronological order, preserves direction.

### 4.3 Analyse (outbound index + fact/intent demand + tool scores)

```bash
# Ensure scripts/analyse-centurion-pms-tools.mjs OUTPUT paths use today's date
node scripts/analyse-centurion-pms-tools.mjs
```

Writes tracked docs under `docs/infor-hms/`:

- `centurion-pms-tool-demand-YYYY-MM-DD.md`  
- `centurion-outbound-index-YYYY-MM-DD.md`  
- `centurion-thread-collation-summary-YYYY-MM-DD.md`  

Method:

1. Parse every message subject + body  
2. Regex-classify **intents** (confirm, new booking, quote, group, invoice, cancel, …)  
3. Regex-classify **PMS fact types** (conf #, rates, dates, folio, company, docs, …)  
4. Aggregate per thread  
5. Score candidate tools: `score = 2×thread_fact_hits + 3×thread_intent_hits`  
6. Emit outbound subject index (no bodies in tracked files)

**Caveat:** classifiers are recall-oriented. Expect false positives. Especially the original `new_booking` regex matched any `\bbooking\b` / `\breserve\b` (including confirmation chatter). Treat scores as demand **signals**, not ticket counts. See §6 for corrected create-intent estimates.

### 4.4 Re-run cadence

Re-run §4.1–4.3 every few days as mailbox grows. Keep dated analysis files; refresh gitignored dumps in place.

---

## 5. Corpus snapshots

| Dump | Messages | In / Out | Threads | Notes |
| --- | ---: | --- | ---: | --- |
| ~27–29 Jul (roadmap baseline) | 223 | 197 / 26 | 193 | early sample |
| 2026-08-01 | 526 | 458 / 68 | 434 | first full refresh in this workstream |
| 2026-08-03 | 623 | 551 / 72 | 520 | +97 msgs vs Aug 1; +4 outbound |
| **2026-08-04** | **812** | **724 / 88** | **668** | +189 msgs vs Aug 3; +16 outbound |

2026-08-04 highlights:

- Threads with ≥1 PMS-fact signal: **599** (~90%)  
- Open inbound-looking PMS-reply-worthy (heuristic): **420**  
- Outbound: **88** messages across **86** threads; **~82** are templated `Confirmation Letter` / `Payment Confirmation` subjects  
- Non-template outbound: Centurion test ×2, Nava access ×2, Comp ×2  
- Multi-message threads: **63** (most threads still single inbound)
- Window: 2026-07-27 → 2026-08-04 (~8 days)

---

## 6. Classifier correction (important)

| Classifier | Approx result (03 Aug) | Meaning |
| --- | --- | --- |
| Original analysis “New booking request” | ~143 threads (~27.5%) | **Inflated** — regex matches almost any “booking”/“reserve” |
| Tighter book-request (please book / RFQ / accommodation request / new reservation request) | **~21 threads (~4%)** | Closer to true create/quote-request demand |
| Strict “please book/reserve” | **~8 threads (~1.5%)** | Rare explicit ask |
| Quote language | **~70 threads (~13%)** | Higher than true create |
| Amend language | **~37 threads (~7%)** | Future write |
| Confirm/status | **~201 threads (~39%)** | Dominant |

**Do not** promote `hms_create_reservation` to #1 on the inflated 27% figure. **Do** still design create as a first-class write tool for the real minority class (gov/RFQ/accommodation asks) because LLMs cannot invent inventory binds or confirmation numbers.

---

## 7. What staff actually send (outbound)

Almost all Centurion outbound in-corpus = **templated document delivery**:

- `The Centurion Hotel_Confirmation Letter_<Guest> (n°…)`  
- Newer: `The Centurion Hotel_Payment Confirmation_<Guest> (n°…)`  

Implication: drafting “100% of *sent shape*” needs **document list/fetch/generate + attach**, not only prose. Many stays already exist in HMS (channel/SynXis/agent) before staff email goes out.

---

## 8. User clarification on writes (recap)

> While executing the discovery/build plan: do **not** create or modify bookings; do **not** perform write operations on production HMS.  
> Actual tools we create **can** include write operations.  
> Recommendation: get all the way up to the Create Reservation button, but do **not** hit Submit now.  
> Deterministic Playwright for write tools must not accidentally submit, so there is room to explore if docs are wrong.  
> Write operations should be **noted out in tool form now**.  
> If a high percentage of mail is “please book my room…”, that should become a tool, because tools replace HMS-specific details an LLM cannot invent.

**How that changes conclusions:**

| Before | After |
| --- | --- |
| Writes treated as out-of-scope for ranking | Writes **in catalog now**, `future_write`, discovery **no submit** |
| Create deferred as vague “later” | Create = named Playwright tool with hard stop before submit |
| Implied ~27% need booking create | Corrected ~4% tight book-request; ~13% quote |
| `quote_stay` mid-pack | Rises — prerequisite for honest quotes **and** create |
| Single “live ranking” | Split: **run-now reads** vs **design-now writes** |

Does **not** change: live autonomous pass still must not mutate production PMS.

---

## 9. Recommended tools — what they do and why

### 9.1 Read / evidence tools (build and use for drafting now)

| Tool | What it does | Why |
| --- | --- | --- |
| `hms_find_reservation` | Guest Stay search by conf # / external ref / guest+dates; return status, dates, room type, guest | Highest demand. Without this, confirmations, “where is my booking?”, invoice, amend paths cannot ground. |
| `mail_read_artifact` | Extract text from inbound PDF/voucher/POP (not HMS) | Often the only place the conf # / VCC / voucher lives. Feeds find_reservation. |
| `hms_quote_stay` | Read **Room Availability** + **Display Rates** separately; never CRS Check Availability; `bookable=false` | Needed for quote/new-stay asks and as prerequisite before any create. LLM must not invent rates/inventory. |
| `hms_list_documents` | List/fetch confirmation letter, pro-forma, tax invoice on the stay | Matches ~97% outbound staff shape (doc delivery). |
| `hms_company_account_read` | Company / travel-agent bill-to, AR terms | Corp/gov/TA mail needs correct bill-to language. |
| `hms_group_block_read` | Group allotment / rooming list / block status | Large group/event/conference slice; single-stay search insufficient. |
| `hms_event_read` | Event / F&B reservation read | Event/showcase/F&B threads. |
| `hms_read_folio` | Balance, deposits, outstanding — no post/settle/refund | Payment / POP / refund / payment-confirmation paths. |
| `hms_sent_email_audit` | Prove prior HMS/email send; support resend decisions | “Did you send my confirmation?” without double-sending. |
| `hms_guest_preferences_read` | Special requests / preferences | Lower volume; still HMS-backed. |

### 9.2 Write tools (design now; Playwright real; **Submit disabled** until human gate)

| Tool | What it does | Why note now |
| --- | --- | --- |
| `hms_create_reservation` | Fill CRS / Stay Wizard through fields; stop before Check Availability / Wrap Up / Save on prod until gated | Minority (~4% tight) but irreducible: inventing a booking is worse than inventing a rate. Gov/RFQ/accommodation asks. |
| `hms_generate_confirmation_proforma` | Generate confirmation / pro-forma artifacts in HMS | Matches outbound document workflow. |
| `hms_send_reservation_confirmation` | Send/resend confirmation (gated) | Staff send shape; HITL/policy still required. |
| `hms_amend_reservation` | Change dates/room/guests on existing stay | ~7% amend-signal threads. |
| `hms_cancel_reservation` | Cancel path (gated) | Cancel/refund language present; validate carefully (noisy regex). |
| Group/event write variants | Update block / rooming list / event | After single-stay writes mature. |

Roadmap already lists these under Wave 4C in `2026-07-29-infor-hms-full-tool-portfolio-roadmap.md`.

### 9.3 Explicitly forbidden during autonomous discovery

- CRS **Check Availability** (creates reservation record per Infor docs)  
- Any Save / Create / Amend / Cancel / Post / Settle / Refund / Send / Print / Export on production  
- Live write-form **submit** exploration  

Allowed: open screens, observe selectors, fill fields, assert UI, stop at the button.

---

## 10. Rankings (dual horizon)

### A — Run-now / shadow-now (live = read only)

1. `hms_find_reservation`  
2. `mail_read_artifact`  
3. `hms_quote_stay` *(raised — rates/avail + create prerequisite)*  
4. `hms_list_documents`  
5. `hms_company_account_read`  
6. `hms_group_block_read` (+ `hms_event_read`)  
7. `hms_read_folio` / `hms_sent_email_audit`  

### B — Design-now write pack (submit-gated)

1. `hms_create_reservation`  
2. `hms_generate_confirmation_proforma` + `hms_send_reservation_confirmation`  
3. `hms_amend_reservation`  
4. `hms_cancel_reservation`  
5. Group/event write variants  

### Example chain: “Please book government rooms for DATE–DATE”

1. `mail_read_artifact` — extract dates, names, PO/RFQ from attach  
2. `hms_quote_stay` — availability counts + Display Rates  
3. `hms_company_account_read` — gov/corp bill-to if present  
4. `hms_create_reservation` — fill wizard; **submit only when write gate on**  
5. `hms_list_documents` / generate + send confirmation — match staff outbound  

Without step 4 gated-write, agent may only honestly draft quote/hold language — not “booked, conf n°…”.

---

## 11. Practical build order (aligned to live ladder)

1. Live Guest Stay adapter + worker Playwright session + shadow real reads (no persist of bad candidates if policy says so).  
2. Harden quote path: Room Availability + Display Rates (read-only).  
3. Document list/fetch + outbound-shaped draft templates.  
4. Folio + sent-email audit reads.  
5. Group/event/company account reads.  
6. **Write adapters with fail-closed submit** (fixture first): create → confirmation generate/send → amend/cancel → group writes.  
7. Human-supervised live write validation per operation — never “autonomous first live write.”

Live autonomy progress ladder (separate from this mail analysis): safety/fixtures + login canary + Guest Stay not-found canary done; live search+row parse, worker Playwright session, shadow real reads still the choke points before enabled persist / AI_DRAFTS full path.

---

## 12. Safety reminder for the next LLM

- Prefer this handoff + dated `docs/infor-hms/centurion-*-2026-08-03.md` over chat memory.  
- Do not commit gitignored email dumps.  
- Do not paste guest bodies/PII into external tools.  
- Do not treat CRS Check Availability as a read.  
- Do not run tests against pilot RDS.  
- Designing a write tool ≠ permission to submit on production.

---

## 13. Remaining gaps (honest)

- Human label pass on ~21 tight book-request threads (create vs quote-only vs already held elsewhere).  
- Confirm Centurion tenant create surface: CRS vs Stay Wizard.  
- Confirm whether confirmation PDFs are generated inside HMS vs mail/Rocketseed path for the send tool.  
- Recompute tool scores with a tightened `new_booking` classifier so tracked demand docs stop overstating create volume.

---

## 14. One-screen summary for another LLM

**Job:** Infer Infor HMS tools for Nava Centurion AI drafting from real mail + Infor docs.  
**Data:** Dump Centurion messages from pilot RDS (read-only SSM) → regroup by thread → regex analyse → scored tool list. Latest dump **623 msgs / 520 threads (2026-08-03)**.  
**Outbound truth:** almost all staff sends are confirmation/payment letter templates.  
**Reads to build first:** find reservation, mail artifact, quote (availability+rates), list documents, company, group, folio, sent-email audit.  
**Writes to design now, never auto-submit on prod:** create reservation, generate/send confirmation, amend, cancel.  
**Discovery rule:** explore up to the submit button; do not press it. CRS Check Availability creates a reservation — forbidden as a “read.”  
**Do not trust** the old “~27% new booking” number; true please-book/RFQ-ish demand is closer to **~4% of threads**, still enough to require a create tool, not enough to rank it above find/docs/quote.
