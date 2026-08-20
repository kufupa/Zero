# Centurion email → PMS tool demand handoff (historical)

**Date:** 2026-08-03  
**Audience:** any LLM / engineer with **zero prior context**  
**Purpose:** preserve dated tool-demand context and guardrails. This is not a current mail-pull, response-state, or operator-runbook authority.

> **Historical / supersession notice (2026-08-10):** Snapshot descriptions and conclusions below remain historical. They must not be used to infer a current queue, response count, or case resolution. For current thread-state status, required evidence, and safe operator steps, use `centurion-thread-state-status-2026-08-10.md` and `centurion-thread-state-audit-runbook.md`.
>
> **Retired route:** `apps/server-pilot/scripts/dump-centurion-emails-md.mjs` and its S3 raw-dump transfer route are retired. Do not invoke, restore, or replace that route from this handoff.

This historical doc records:

1. How mail was pulled and analysed
2. User goals and safety guardrails
3. Corpus snapshots and method caveats
4. What each recommended tool does and why
5. Write vs read policy (discovery vs shipped tools)
6. Revised ranking after clarifying that write tools should be **designed now** but **not submitted** during autonomous discovery

Related artifacts (same repo):

| File | Role |
| --- | --- |
| Historical local raw Markdown artifacts | Snapshot-bound, gitignored PII artifacts; do not refresh, transfer, or use as current runbook input |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-04.md` | Aggregate analysis + scores (latest) |
| Historical outbound description in this handoff | Aggregate-only recurring template patterns and counts; no subject index or message-level detail |
| `docs/infor-hms/centurion-thread-collation-summary-2026-08-04.md` | Thread size/direction histograms (latest) |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-03.md` | Prior analysis snapshot |
| `docs/infor-hms/capability-matrix.md` | Infor HMS capability allow/deny matrix |
| `docs/superpowers/plans/2026-07-29-infor-hms-full-tool-portfolio-roadmap.md` | Full read/write roadmap |
| `docs/infor-hms/centurion-thread-state-status-2026-08-10.md` | Current aggregate-only operational trust status |
| `docs/infor-hms/centurion-thread-state-audit-runbook.md` | Current private read-only canonical export → adjudication → report flow |

---

## 1. Product context (one paragraph)

Nava pilots Centurion Hotel mail. Triage already ships. The drafting agent must stop inventing rates, confirmation numbers, availability, folio balances, and bill-to details. Those facts live in **Infor HMS** (and sometimes in inbound PDF vouchers). The workstream builds **deterministic Playwright tools** that read (and later, gated-write) HMS so an AI drafting agent can ground replies. Historically, staff outbound was mostly templated reservation- or payment-document delivery, not freeform essays.

---

## 2. Historical user goals (as stated)

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

- Current operator access must use the dedicated canonical exporter in the current runbook; do not use generic SQL or dump scripts.
- **Never** run Vitest (or any test runner) with `DATABASE_URL` pointing at pilot/production.  
- Never set `VITEST_ALLOW_PILOT_RDS=1`.  
- Never emit database URLs, credentials, private mail bodies, addresses, subjects, or other PII to stdout, logs, chat, Git, or prompts.
- Raw email material stays in owner-controlled private artifacts. Tracked docs are aggregate-only or redacted analysis; never email subjects or other PII.

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

### 4.1 Historical raw-dump route — retired

The prior refresh path materialized raw mailbox content and transferred it through an outdated route. It is retained nowhere in this handoff as an executable procedure. Do not copy, download, upload, or inspect historical raw dumps from this document.

For a future authorized private run, follow `docs/infor-hms/centurion-thread-state-audit-runbook.md`: a canonical read-only export on a Linux private writer, local adjudication, then private reconciled reports. Source environment only inside the operation subshell; do not run a test runner there.

### 4.2 Historical collation

The former flat-dump collation step is historical only. It does not meet the current validated-canonical-corpus or thread-state evidence contract.

Current thread construction must come from the validated canonical corpus and its strict evidence rules.

### 4.3 Historical tool-demand analysis

The historical classifier and tool scores remain dated demand signals, not response-state evidence or live operational counts. Future aggregate reporting must use the current thread-state runbook and its safe receipts; no raw material may enter tracked docs.

### 4.4 Re-run cadence

Do not re-run the retired raw-dump route. Preserve dated documents as history. A future fresh run follows `centurion-thread-state-audit-runbook.md` and publishes only an aggregate result after its receipt gate passes.

---

## 5. Historical corpus snapshots

| Dump | Messages | In / Out | Threads | Notes |
| --- | ---: | --- | ---: | --- |
| ~27–29 Jul (roadmap baseline) | 223 | 197 / 26 | 193 | early sample |
| 2026-08-01 | 526 | 458 / 68 | 434 | first full refresh in this workstream |
| 2026-08-03 | 623 | 551 / 72 | 520 | +97 msgs vs Aug 1; +4 outbound |
| **2026-08-04** | **812** | **724 / 88** | **668** | +189 msgs vs Aug 3; +16 outbound |

2026-08-04 highlights:

- Threads with ≥1 PMS-fact signal: **599** (~90%)  
- Open inbound-looking PMS-reply-worthy (heuristic): **420**  
- Outbound: **88** messages across **86** threads; **~82** used recurring reservation- or payment-document delivery templates
- Non-template outbound: **6** messages across three internal or administrative categories (two each)
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

Almost all historical Centurion outbound used recurring reservation- or payment-document delivery templates. This aggregate description retains no email-subject text, guest details, or message identifiers.

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

- Prefer `centurion-thread-state-status-2026-08-10.md` and `centurion-thread-state-audit-runbook.md` over this historical handoff for current operations.
- Do not commit, copy, upload, or inspect historical raw dumps through an unapproved route.
- Do not paste guest bodies/PII into external tools, stdout, chat, or Git.
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

**Job:** Historical tool-demand context for Nava Centurion AI drafting.
**Data:** The snapshot figures below are historical only. Do not pull, regroup, or analyse raw mail through this handoff; use the current private thread-state runbook for a fresh authorized result.
**Historical outbound pattern:** almost all staff sends used recurring reservation- or payment-document templates.
**Reads to build first:** find reservation, mail artifact, quote (availability+rates), list documents, company, group, folio, sent-email audit.  
**Writes to design now, never auto-submit on prod:** create reservation, generate/send confirmation, amend, cancel.  
**Discovery rule:** explore up to the submit button; do not press it. CRS Check Availability creates a reservation — forbidden as a “read.”  
**Do not trust** the old “~27% new booking” number; true please-book/RFQ-ish demand is closer to **~4% of threads**, still enough to require a create tool, not enough to rank it above find/docs/quote.
