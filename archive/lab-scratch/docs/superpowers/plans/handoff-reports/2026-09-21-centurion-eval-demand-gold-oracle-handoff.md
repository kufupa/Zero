# Handoff — Centurion eval demand + gold oracle (continue this chat)

**Date:** 2026-09-21  
**Branch:** `feat/centurion-dashboard-tools`  
**Worktree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools`  
**Chat transcript (full JSONL, no tool dumps):**  
`/home/orca/.cursor/projects/home-ubuntu-projects-zero-worktrees-centurion-dashboard-tools/agent-transcripts/66352160-924c-4502-8206-28a5a09711dc/66352160-924c-4502-8206-28a5a09711dc.jsonl`  
**Private evidence root (gitignored, PII):**  
`.private/centurion-corpus/centurion-tool-demand-20260919/`  
**Published counts (no PII):**  
`docs/infor-hms/centurion-eval-lab-counts.md`

This file is for a **new LLM** to continue the same research thread. Read the **locked decisions** and **do-not** list before touching numbers or quote-v2.

---

## 0. What this workstream is

Mailbox **demand analysis** for Centurion: which Infor HMS / mail **verbs** to keep, and **closed JSON I/O per verb**.

It is **not**:

- 100% email replacement
- Live Playwright writes / auton send
- Shipping quote v2 production
- A replacement for Wave A live-payload HITL (that is a **different** prior workstream — see §8)

Two metrics, **never added, never substituted**:

| Metric | Meaning | Denominator | File |
| --- | --- | --- | --- |
| `neededCount` / **ask** | Inbound requires this verb (stack OK) | **980** candidate inbounds (1069 − skip) | `truth/needed-count.json` |
| `staffUsed` | Gold staff reply used this verb | **285** paired + **124** outbound_only | `truth/staff-used.json` |

Window: **Sep 9 00:00 – Sep 18 16:50 Africa/Johannesburg**.

Catalogue: **27 IDs** in `EVAL_TOOL_CATALOGUE` (`apps/server-pilot/src/ops/centurion-eval-lab.ts`). Do not add/remove IDs. Only alias: `hms_list_documents` ≡ `documents_list_existing` (rolled staffUsed **32**, IDs not merged).

---

## 1. Locked user decisions (this chat)

| Decision | Value |
| --- | --- |
| Public number per tool | **`neededCount` only** (not primaryVerb/family pairs) |
| Freeze fate | **`keep_add`** — keep the 27; add staffUsed as a second table |
| Quote v2 | **`analysis_only`** — do not edit quote-v2 plan, do not ship |
| Luna | **`gpt-5.6-luna`**, **≤7 concurrent**, unlimited waves, stop at 100% gold/spans |
| Order vs schema | User **does not care about build order**. Wants **which tools + schema per tool**, Infor-backed |
| Ask vs staffUsed conflict | **Neither integer wins.** Build = union of ask∪staffUsed **gated by Infor owner surface** |
| Commit | **Do not commit** unless asked |
| `/mail` folders | **Do not swap** lab under `/mail` |
| `missing_owner_header` | **Do not bulk-promote** |
| Pilot RDS | **Never Vitest** against `nava-zero-mail-pilot`. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` first |
| PII | Stay in `.private`. Never Git / web search / remote MCP / SSM |

Forbidden headline numbers from earlier passes (do not revive): family/primary pairs, outbound **505** as a demand denom, `still_needed` as the build metric.

**“Forbid family + outbound 505”** (explained in-chat): “family” = a forbidden *tool-family ranking* next to `neededCount`; “outbound 505” = 505 outbound messages used as a **teacher for staff behavior**, not a second inbound denominator.

---

## 2. What this chat completed

### 2.1 Inbound `neededCount` freeze (27 tools, 95-met)

- Parser floors/ceilings in `parseNeededTools`.
- Luna cluster scoring (writes/docs/money/locators/context) with rereads until 95-met.
- Freeze writer: `apps/server-pilot/scripts/centurion-eval-needed-freeze.mjs`
- Gold freeze **must not mutate** `neededCount` (asserted in `centurion-eval-gold-freeze.mjs`).

Published table: `docs/infor-hms/centurion-eval-lab-counts.md` (first table). Integers are **frozen**. Do not replace them.

### 2.2 Gold oracle (`staffUsed` + spans)

Paired inbound+gold scored for **what staff actually used**, plus field quotes with exact body spans.

- Shards: `scripts/centurion-eval-gold-oracle-shuffle.mjs`
- Launch: `scripts/centurion-eval-launch-luna.sh` (refuses `SHARDS>7`)
- Alive poll: `scripts/centurion-eval-luna-alive.sh`
- Collate: `scripts/centurion-eval-gold-collate.mjs` — CAT boolean keys only (do not let `guestName` pollute `staffUsed`)
- Freeze: `scripts/centurion-eval-gold-freeze.mjs` → `truth/staff-used.json` + `truth/call-graph.json`
- Lab patch: `scripts/centurion-eval-span-patch-lab.ts` (mjs is a thin tsx wrapper)
- Field inventory: `scripts/centurion-eval-field-inventory.mjs`

Piles and stop condition (KEEP reread → move 0):

| Pile | Rows | Result |
| --- | ---: | --- |
| gold-oracle | 285 | staff+quote final move 0; independent reread had flipped hard — KEEP is the stabilizer |
| outbound-only | 124 | staff move 0 |
| true-gap | 261 | staffUsed all false (required); quote move 0 after KEEP |
| channel-auto | 146 | create stays 0; staffUsed stable |
| gold-audit | 200 | **`goldAgree` 199/199** among oracle; 1 `no_oracle` exempt; residual 0 |

`goldAgree` = `staffUsed` matches gold. A **needed/ask mismatch must not fail** goldAgree.

`alwaysInStack`: `hms_find_reservation`, `hms_read_reservation` — run on existing-stay work even when ask is 16/17.

### 2.3 Quote-span 100% classification

Initial 161 “unresolved quotes” were **classified**, not ignored:

- 150 true_gap schema drift (`text` instead of `quote`, missing enum `field`) → `normalizeGoldQuote` aliases `text`→`quote`, rejects non-enum `field`
- 11 empty lab `textBody` despite snapshot bodies → `rehydrateMailText`
- Dedicated Luna: `TRUE_GAP_FIELDS.txt` (150) and `GOLD_WHOLE_BODY.txt` (23)

`truth/quote-span-100.json`:

- `unclassifiedLocateMiss: 0`
- `bad_field: 0`
- `whole_body: 0`

Miss reasons (closed): `empty_quote | empty_body | not_in_body | bad_field | whole_body`.

`GOLD_QUOTE_MAX_CHARS = 400`. Whole-body dumps are misses, not fake offsets.

**Ignore** numeric `"0"…"17"` keys in `truth/field-inventory-quote-group-cancel-artifact.json` — Luna index junk, not HMS fields.

### 2.4 Lab UI

- Route: `apps/mail/app/(routes)/lab/centurion/page.tsx` → **`/lab/centurion`**, must not mount under `/mail`
- Components: `apps/mail/components/lab/`
- Types/index: `apps/mail/lib/lab/centurion-eval.ts`
- Tests: `apps/mail/tests/centurion-eval-lab.test.tsx`

Shows `neededCount` + `staffUsedCount`, inbound vs gold `<mark>` spans, SchemaPane bound to **selected** tool (`data-testid=tool-*`).

### 2.5 Tool + schema catch-up (end of chat)

User: don’t care about order; want **tools + schema per tool**, backed by Infor.

**Build rule:** `max(ask, staffUsed) > 0` **and** an Infor/mail owner surface exists. Schema = closed Zod on that surface (or catalogue §6 for writes). Luna `GOLD_FIELD_ENUM` is **highlight vocab**, not HMS keys.

**25 distinct verbs** (27 IDs − list alias pair). Do not drop zero-ask tools that staff used (`hms_generate_quote_document` 0/57, `hms_email_folio` 0/19, `hms_sent_email_audit` 0/4).

Do not flatten:

- send-conf ≠ create ≠ STORECONF/proforma ≠ quote-PDF
- folio-read ≠ post-payment ≠ invoice-generate ≠ email-folio ≠ refund
- Hotel Availability ≠ CRS Check Availability (Check Availability **creates a record**)
- `rateCode` / `rateQuoted` live on **read.rates + quote**, never find GRID
- `mail_read_artifact` ≠ `documents_read_existing` ≠ `hms_read_document` (mailbox vs HMS bytes)

---

## 3. Frozen ask / staffUsed table

From `docs/infor-hms/centurion-eval-lab-counts.md`. Denoms **not comparable as a single rank**.

| tool | ask/980 | staffUsed | alwaysInStack |
| --- | ---: | ---: | --- |
| `mail_read_artifact` | 279 | 30 | |
| `hms_quote_stay` | 184 | 143 | |
| `hms_group_block_read` | 170 | 43 | |
| `hms_generate_confirmation_proforma` | 124 | 25 | |
| `hms_generate_invoice` | 108 | 51 | |
| `hms_read_folio` | 93 | 14 | |
| `hms_send_reservation_confirmation` | 78 | 94 | |
| `hms_cancel_reservation` | 75 | 29 | |
| `mail.send_with_attachments` | 73 | 166 | |
| `hms_amend_reservation` | 70 | 44 | |
| `hms_post_payment` | 61 | 84 | |
| `hms_event_read` | 51 | 18 | |
| `documents_read_existing` | 50 | 17 | |
| `hms_list_documents` | 43 | 19 | |
| `documents_list_existing` | 43 | 13 | alias of list |
| `hms_create_reservation` | 41 | 41 | |
| `mail_parse_channel_payload` | 39 | 5 | |
| `hms_read_reservation` | 17 | 89 | **yes** |
| `hms_find_reservation` | 16 | 75 | **yes** |
| `hms_refund` | 16 | 9 | |
| `hms_company_account_read` | 8 | 47 | |
| `hms_read_notes_traces` | 3 | 56 | |
| `hms_attach_guest_stay_document` | 3 | 91 | |
| `property_read_knowledge` | 3 | 19 | |
| `hms_generate_quote_document` | 0 | 57 | |
| `hms_email_folio` | 0 | 19 | |
| `hms_sent_email_audit` | 0 | 4 | |

Disagree is expected: staff ≫ ask = staff workflow (find/read/notes/attach/company/quote-PDF/send-with-attach/post-pay). ask ≫ staff = guest named it; staff answered from stay/mail or skipped (group/proforma/invoice/folio/inbound artifact/cancel/channel).

---

## 4. Schema map (coded vs paper)

Shared HMS read envelope: `ReadResult` + `ReadFact`. Unknown keys rejected.

Runtime reads: `apps/server-pilot/src/hms/agent-read-tools.ts`  
Contracts: `reservation-context-contract.ts`, `quote-stay-contract.ts`, `read-service-contracts.ts`, `read-tools.ts`  
Catalogue I/O: `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` §3 (reads) and §6 (writes)  
Surface grabability: `docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md`  
Capability matrix: `docs/infor-hms/capability-matrix.md`

| tool | I/O | Owner surface | Notes |
| --- | --- | --- | --- |
| `hms_find_reservation` | `{candidateId}` → matches (label, kind, status, dates, roomType). **No ratePlan** | [Guest Stay](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html) | GRID live; dataspy 1941 |
| `hms_read_reservation` | `{reservationRef, sections[core,stay,rates,policies,operations]}` default core+stay | detail + [Rate details](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428572875.html) | rates owner, not GRID |
| `hms_quote_stay` | `{quoteRequestRef}` → nightly obs, `held:false`, `bookable`, `stayTotal`, `occupancyPriced` | [Hotel Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/jxo1557688477063.html) **only** | never [CRS Check Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html) |
| `hms_read_folio` | sections balance/deposits/transactions(/authorization) | [Folios](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html) + [Advance deposit](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html) | zero ≠ paid; A/R transfer |
| `hms_list_documents` | `{scopeRef, source, kinds?, limit, cursor}` metadata | [Sent Email](https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html) + [Tax invoice](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428580083.html) | list ≠ generate (print mutates) |
| `documents_read_existing` / `hms_read_document` | text **or** artifactRef, never both | same | do not regenerate |
| `mail_read_artifact` | mailbox bytes | Nava mail | not PMS |
| `hms_sent_email_audit` | log rows; `deliveryEvidence: hms_log_only` | Sent Email | log ≠ delivery |
| `hms_company_account_read` | `{reservationRef}` linked only | org/AR | no arbitrary company search |
| `hms_group_block_read` | sections summary/blocks/delegates | [Blocks](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428587883.html) | no guessed CON/BLK math; rooming list **creates** reservations |
| `hms_event_read` | existing HMS event | [Events](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428591097.html) | not SCS |
| `hms_read_notes_traces` | notes/traces; no Complete/Submit | [Notes](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428576136.html) / [Traces](https://docs.infor.com/hms/2026.08/en-us/hmsolh/mru1429015474343.html) | Complete asserts delivery |
| `property_read_knowledge` | closed topic enum | approved property docs | non-PMS |
| `mail_parse_channel_payload` | FW/OTA body | mail | feeds find candidate |
| **Writes** (create/amend/cancel/pay/refund/generate_*/send/attach/email_folio/`mail.send_with_attachments`) | catalogue §6 **proposal** `{proposalRef,…}` then `{proposalRef, approvedOperationRef, idempotencyKey}` | see catalogue Infor URLs | **no executor in this freeze**; HITL |

`GOLD_FIELD_ENUM` → owner (eval highlights only):

- `confirmationNumber`, `status` → find + read
- `guestName` → find + read + create
- `arrival`, `departure` → find, read, quote, group, cancel
- `adults`, `children`, `paxTotal`, `occupancy`, `roomQty` → quote + create/amend + group (**not** find GRID)
- `roomType` → find label, read stay, quote nights, group block
- `rateCode`, `rateQuoted` → **read.rates + quote**
- `amount` → quote / folio / invoice / payment
- `groupName` → group_block
- `cancelReason` → cancel proposal
- `attachmentName`, `docType` → list/read/attach/send

---

## 5. Code / scripts touched in this chat

### Contracts + tests

- `apps/server-pilot/src/ops/centurion-eval-lab.ts` — catalogue, parser, spans, `mergeStaffUsedWithoutTouchingNeeded`, `buildCallGraph`
- `apps/server-pilot/tests/centurion-eval-lab.test.ts`
- `apps/mail/lib/lab/centurion-eval.ts`
- `apps/mail/components/lab/`
- `apps/mail/app/(routes)/lab/centurion/page.tsx`
- `apps/mail/app/routes.ts` (lab route)
- `apps/mail/tests/centurion-eval-lab.test.tsx`

### Eval scripts

Under `apps/server-pilot/scripts/`:

- `centurion-eval-needed-*.{mjs,ts}` — inbound freeze
- `centurion-eval-gold-*.mjs` — oracle collate/freeze/audit/shuffle
- `centurion-eval-span-patch-lab.ts` (+ `.mjs` wrapper)
- `centurion-eval-field-inventory.mjs`
- `centurion-eval-launch-luna.sh`, `centurion-eval-luna-alive.sh`

### Private prompts (demand dir)

`NEEDED_*.txt`, `GOLD_ORACLE.txt`, `GOLD_ORACLE_REREAD.txt`, `GOLD_AUDIT*.txt`, `OUTBOUND_ONLY*.txt`, `TRUE_GAP*.txt`, `CHANNEL_AUTO*.txt`, `GOLD_WHOLE_BODY.txt`, `TRUE_GAP_FIELDS.txt`, plus earlier pass prompts.

### Private truth (read these; do not rewrite neededCount)

`truth/needed-count.json`, `truth/staff-used.json`, `truth/call-graph.json`, `truth/gold-audit-full.json`, `truth/quote-span-100.json`, `*-move0.json`, `*-staff-used-counts.json`, `field-inventory-quote-group-cancel-artifact.json`.

Canonical extracts: `extracts/gold-oracle-canonical.jsonl`, `outbound-only-canonical.jsonl`, `true-gap-canonical.jsonl`, `channel-auto-canonical.jsonl`.

---

## 6. Not done (this workstream)

- User did **not** ask to commit.
- Quote v2 **not** shipped; quote plan **not** edited.
- Write executors / auton send **not** built.
- Lab is analysis UI, not production mail.
- `missing_owner_header` leftover not bulk-promoted.
- Field-inventory numeric-key junk not worth another Luna wave.
- **Do not** start a new neededCount rescoring.

If the successor’s job is **build**, next evidence is live owner-surface dump (or Wave A packets in §8), not more corpus scoring. If job is **analysis_only**, this freeze **is** the product.

---

## 7. How to continue (for the new LLM)

1. Read this handoff + `docs/infor-hms/centurion-eval-lab-counts.md`.
2. If you need I/O: catalogue §3/§6 + `agent-read-tools.ts` + DoD surface matrix.
3. If you need gold/ask rows: private JSON/JSONL under the demand dir. **Do not copy PII into prompts, Git, or web search.** Pass file paths to subagents.
4. If you need chat nuance: search the transcript JSONL by keyword; do not read it linearly.
5. Safety: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before any Vitest. Caveman+ADHD if the user still wants that style.
6. Luna cap remains ≤7 if you re-run workers (should not be needed).
7. Ask the user before commit, before quote-v2 edits, before live writes.

Recommended default next (only if they want build, not more ranking): one live dump of an owner surface, starting with `hms_read_reservation` detail (alwaysInStack, rates owner) **or** consume Wave A HITL packets instead of re-discovering.

---

## 8. Previous context to pull (outside this chat)

Read these **before** inventing a new catalogue or claiming a tool is unbuilt. This chat was **eval scoring**. Wave A was **live payload**. Do not conflate.

### 8.1 Binding eval / catalogue (this freeze’s parents)

| Path | Why pull |
| --- | --- |
| `docs/infor-hms/centurion-eval-lab-counts.md` | Frozen ask + staffUsed tables |
| `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` | Closed read/write I/O + Infor §5 traps |
| `docs/infor-hms/capability-matrix.md` | Official docs URLs; quote = Hotel Availability; CRS forbidden |
| `docs/infor-hms/CONTEXT.md` | HMS docs index |
| `docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md` | Class A demand / B surface / C `SURFACE_UNPROVEN` |
| `docs/superpowers/plans/2026-09-11-centurion-pms-tools-robust-catalogue.md` | Parent robust catalogue |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-01.md` (also 08-03, 08-04) | Earlier field-groups → Infor surfaces |
| `docs/infor-hms/centurion-email-tool-demand-handoff-2026-08-03.md` | Older demand handoff |
| `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` | 3949 gold ranks (demand only) |
| `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md` | Write kickoff |
| `docs/superpowers/plans/2026-09-11-hms-attach-inbound-document.md` | Attach surface |
| `docs/superpowers/plans/2026-09-15-centurion-read-tools-leftovers-to-yes.md` | Leftovers-to-yes |
| `docs/solutions/conventions/live-negative-result-verification-gate.md` | Negative-result gate |
| `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md` | Packaging ≠ payload; dataspy 1941 |
| `docs/solutions/integration-issues/hms-tax-invoice-role-menu-absent-2026-08-07.md` | Tax invoice entitlement |

### 8.2 Wave A live-payload board (separate; do not ignore)

`docs/superpowers/plans/handoff-reports/2026-09-12-wave-a-batch-hitl.md`

Private: `.private/wave-a-20260912/COMPLETION-AUDIT.md`, `.private/wave-a-20260912/PROGRESS.md`

That board greened several **read payloads** (folio, quote nightly, group LST, company FSOGPF, notes, channel parse, list docs, mailbox document digest) and left **EXTERNAL_ROLE_GATE** on A1 rate-details nightly, A3 Guest Stay Documents, A7 events, A10 knowledge. This eval chat still talked “unproven dump” from DoD language — **reconcile with Wave A before rebuilding those readers**.

### 8.3 Quote v2 (out of scope unless user says otherwise)

- Canonical plan: `docs/plans/2026-09-17-002-feat-playwright-fetch-quote-plan.md` — native Playwright, Hotel Availability only, no runtime LLM/Stagehand, one browser owner, **no reservation mutation**
- Historical only: `docs/plans/2026-09-17-001-feat-stagehand-quote-mvp-plan.md` — must not override successor
- Workspace rule: plan-scoped exception in `.cursor/rules/nava-workflow.mdc`

### 8.4 Runtime / read-tool code (already exists)

| Path | Why |
| --- | --- |
| `apps/server-pilot/src/hms/agent-read-tools.ts` | Agent-facing read IDs + Zod inputs |
| `apps/server-pilot/src/hms/read-tools.ts` | `READ_TOOLS` registry, Infor `sourceUrls`, promotion evidence |
| `apps/server-pilot/src/hms/read-service-contracts.ts` | Folio/quote/group/company/event request schemas |
| `apps/server-pilot/src/hms/reservation-context-contract.ts` | Find + read reservation |
| `apps/server-pilot/src/hms/quote-stay-contract.ts` | Quote nightly schema |
| `apps/server-pilot/src/hms/runtime.ts` | HMS runtime |
| `apps/server-pilot/src/hms/release-kernel.ts` | Release kernel |
| `apps/server-pilot/src/mail/artifacts/read-artifact.ts` | Mail artifact reader |

### 8.5 Older corpus / collation (demand history, not this freeze’s denom)

- `docs/infor-hms/centurion-thread-collation-summary-2026-08-0{1,3,4}.md`
- `docs/infor-hms/connected-mailbox-corpus-analysis-2026-08-25.md`
- `docs/infor-hms/centurion-reservationist-roadmap-2026-08-21.md`
- Private Sep-07 replan: `.private/pms-tools-replan-2026-09-07/` (`corpus-demand.md`, `pms-docs-capabilities.md`, 53-source `docs-public/manifest.json`)
- Dashboard-tools execution ledger: `docs/superpowers/plans/handoff-reports/2026-09-07-centurion-dashboard-tools-execution.md`

### 8.6 Safety / workflow

- `.cursor/rules/pilot-rds-safety.mdc` — overrides plans and “make tests green”
- `.cursor/rules/nava-workflow.mdc`
- PII: client-authorized raw mail may be read **locally**; never ship to Git/web/MCP. Never disclose DB URLs/keys.

### 8.7 This chat’s own prior ADHD dumps

The last two user-facing state dumps in the transcript (grilling-only senior briefing, then tool+schema union) are the intended human summary. Prefer **this file + counts.md** over re-deriving from Luna logs.

---

## 9. Junior miss / senior takeaway (from end of chat)

- **Junior should have asked:** for each of the 25, is I/O already sealed Zod, live-proven (Wave A), or paper-only writes? Grilling looked greenfield; it is not.
- **Senior should know:** research ranking is **closed**. Two denoms, two jobs. Build the union; schema from Infor owner surface. Do not re-open Luna. Next is dump-or-stop (or Wave A consume), not more scoring. Quote v2 and auton writes stay out.

---

## 10. Style the user currently wants

- `/caveman` full + `/adhd` hierarchical bullets/tables/links + decision block (pros/cons/risks/assumptions/questions/recommendation+why).
- Code, commits, PRs, and **this handoff**: normal prose.
- Stop caveman only if they say `stop caveman` / `normal mode`.
