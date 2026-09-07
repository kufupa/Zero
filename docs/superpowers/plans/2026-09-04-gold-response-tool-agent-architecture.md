# Centurion Gold-Response Tool & Agent Architecture Analysis

> **Date:** 2026-09-04 \
> **Denom:** `both_outbound_emails_gold` (union ≈420 msgs; catchup-conditioned primary = 314 Sent bodies) \
> **Artifacts:** `.private/both-outbound-emails-gold/indexes/gold-response-tool-analysis-2026-09-04.json` \
> **Exa Agent:** not available in this session (`agent_run` MCP absent). Ordinary Exa + Cursor WebSearch used; Exa free tier rate-limited after first query.

## 1. What changed vs Sep-1 portfolio

| Tool | Sep-1 draft-target threads | Gold-response demand (catchup 314) | Shift |
| --- | ---: | ---: | --- |
| `hms_find_reservation` | 1120 (80%) | **70 (22%)** | Still #1, not identity-of-everything |
| `hms_read_folio` | 169 (12%) | **59 (19%)** | **Promote earlier** |
| `hms_list_documents` | 76 (5%) | **51 (16%)** | **Promote with artifact** |
| `mail_read_artifact` | 524 (38%) | **51 (16%)** | Still core; attach-heavy Sent |
| `hms_quote_stay` | 264 (19%) | **43 (14%)** | Still B1, not only full-draft archetype |
| `hms_group_block_read` / `hms_event_read` | 50 (4%) | **14 (4.5%) each** | Keep deferred, not zero |
| `hms_company_account_read` | 120 | **1** | Stay deferred |

**Why Sep-1 overstated:** draft-target = unanswered inbound + handoff + gold, archetype→tool map on **trigger**, not on what Centurion **actually wrote**. Gold was 87/73 then; now ~308 new Sent rows + prior gold.

**Infor-fact coverage (catchup):** 140/314 (~45%) have ≥1 Infor-only fact in authored reply; 174 prose/no-fact (many ack-only or attach-forward).

**Template reuse:** after dropping empty bodies, only **~2%** of catchup replies share a near-duplicate normalized shape. Centurion voice is **not** highly copy-pasted. Template packs still useful for structure (salutation/closing/claim slots), but **do not** expect 4 packs to cover most gold.

### Catchup archetype mix (response-side)

| Archetype | n | Share |
| --- | ---: | ---: |
| prose_other | 159 | 51% |
| payment_billing | 60 | 19% |
| quote | 32 | 10% |
| documents_delivery | 23 | 7% |
| reservation_status | 13 | 4% |
| group_event | 10 | 3% |
| cancel_amend | 9 | 3% |
| internal_handoff | 8 | 3% |

Top Infor fact types (union analysis): confirmation_number, stay_dates, folio/payment, quote terms, group/event, document/voucher.

---

## 2. Revised tool build order (gold-conditioned)

**Wave MVP (prove staff-visible grounded draft):**

1. **Promote `hms_find_reservation` to productionActive** (live_verified) — identity spine still highest gold hit.
2. Keep **`mail_read_artifact`** executable (PDF/voucher path dominates Sent with attachments).
3. **`hms_quote_stay`** next for quote archetype.
4. **Pull `hms_read_folio` forward** (was Tier B) — payment_billing is #2 archetype.
5. **`hms_list_documents`** with folio (attach + “please find invoice/quote”).

**Defer:** company account, guest prefs, sent-email audit, group/event (until group pack eval fails), all writes.

**Schema clarifications (claim envelopes):**

| Tool | Must claim | Must deny |
| --- | --- | --- |
| find | confirmation, guest surname+dates, status | invent rate, invent folio balance |
| quote | rate/avail for requested stay | bookable without HITL |
| folio | deposit/balance classes redacted | settle/refund |
| list_documents | doc metadata + link eligibility | resend/send |
| artifact | opaque OCR/text from inbound attach | treat as PMS authority over find |

Do **not** add `draft_mail_compose` registry tool — keep code-owned renderer (matches Mastra/Nylas guidance: draft only, never send).

---

## 3. Agent architecture recommendation (MVP)

### Options

| Option | Fit for “show hotel a product this week” | Fit for security | Fit for eval |
| --- | --- | --- | --- |
| A. Triage → one draft agent (wire `suggestedTools` → planner) | **Best** | OK | Best (reuse runKinds) |
| B. Single agent triage+draft+all tools | Slowest to harden | Worst | Hard |
| C. Per-folder specialized agents | High build cost | Best long-term | Many eval suites |

**Pick A for MVP.** Code already assumes triage-then-drafter (`mail_triage` vs `candidate_draft`). Competitors (D3x July 2026, Altek Outlook-in-inbox) ship **intent → PMS context → draft → staff Agree**. Mastra docs: workflow classify step + deterministic draft; never auto-send.

**Do not revamp the 11 folders from template clusters** — gold replies are not template-clustered enough; folders already approximate money/bookings/docs/groups. Folder change burns durable seed, refine, UI, retag for little draft gain.

**Triage’s job in the money loop:**

1. Spam cut (already strongest lane).
2. Surface high-revenue queues (`bookings`, `groups-events`, `money-billing`, `exceptions-recovery` + `urgent`) — **add UI sort by P0–P1**, not only folder membership.
3. Tag tools for the single draft agent (`suggestedTools` must feed `planCandidateReads` / `activeToolIds` — today disconnected).

**Draft agent MVP demo:** staff opens thread → sees candidate draft grounded on find/artifact (even partial) → edit → send. That is the product. Per-folder agents later if eval shows tool confusion.

---

## 4. Product completeness north star (max value, min architecture churn)

1. **Inbox that makes money:** spam gone, urgent/bookings/groups first, P-rank visible.
2. **Draft that does not invent Infor facts:** claim-safe + live find (+ folio/docs soon).
3. **HITL Agree surface:** one click approve/edit/send (competitors lead with this).
4. **Shadow metrics → gold replay on both-outbound 420** as eval gate before `enabled`.
5. **Writes later:** reservation_create / cancel behind explicit HITL; Playwright hard-stop before Submit (existing Phase B policy).

---

## 5. Immediate next actions (ordered)

1. **Wire triage `suggestedTools` → draft planner** (small code bridge; no new agent).
2. **Live-promote `hms_find_reservation`** (unblock claim-safe path; registry live flags empty today).
3. **Staff-visible draft persist under controlled flag** (shadow metrics alone do not demo).
4. **Gold eval harness** on both-outbound 420 / catchup-gold UIDLs (replace draft-target BUILD table as SoT for tool priority).
5. **Folio + list_documents** next Playwright promotions using existing Phase B plans.
6. **UI:** revenue/urgent sort on Centurion inbox.
7. Only then consider per-folder tool allowlists if single agent mis-fires tools.

---

## 6. Gaps / honesty

- Analysis used regex on authored reply + subject; not full thread RDS join for all 420 (catchup bodies + quoted history; prior Aug-30 often thin preview).
- Empty/short authored (28 catchup) undercount Infor facts that live only in attachments → artifact tool still mandatory.
- Exa Agent unavailable; Infor API evidence from public docs/adapters, not tenant OpenAPI dump.
- `productionActiveReadToolIds()` still empty — portfolio analysis ≠ shippable draft until live promote.

## Sources (local)

- `.private/both-outbound-emails-gold/indexes/gold-response-tool-analysis-2026-09-04.json`
- `.private/both-outbound-emails-gold/indexes/manifest.json`
- `docs/superpowers/plans/2026-09-01-ai-drafting-tool-portfolio-plan.md`
- `docs/plans/2026-09-01-001-feat-corpus-tool-rediscovery-plan.md`
- `apps/server-pilot/src/hms/read-tools.ts`, `candidate-read-plan.ts`, `ai/suggested-tools.ts`, `ai/candidate-draft-agent.ts`
- `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`
- `docs/infor-hms/capability-matrix.md`, centurion tool-demand handoffs

## Sources (web)

- https://d3x.ai/platform/email (hotel agentic email, HITL Agree, PMS context)
- https://www.altek.ai/hotel-email-automation (Outlook + live PMS draft)
- https://github.com/anantrp/hotel-email-agent (LangGraph HITL hotel email)
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428584123.html (CRS reservation search)
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html (folios)
- https://uip.nec-help.com/adapter/Adapters/Adapter-inforhms/ (findReservation / getFolio)
- https://mastra.ai/docs/workflows/overview
- https://cli.nylas.com/guides/mastra-email-agent (draft-only, never send)
- https://www.agentnative.dev/patterns/human-in-the-loop-approval-flow-pattern
