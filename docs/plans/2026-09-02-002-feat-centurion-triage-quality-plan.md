---
title: "feat: Centurion workflow triage quality — Automate, spam restore, quarantine label"
date: 2026-09-02
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
origin: "User locks reconfirmed 2026-09-02 evening (1A Automate for routine OTA/SynXis — reason folder exists; 2A restore promo/cold-sales spam; FortiMail quarantine digests → spam + Quarantine My Folder; 40mail → Automate; channel notifications never Urgent). Live mix + Un/Rsp WINDOW from chat 93ca17e9. Supersedes AE2 routine-OTA→Bookings for quality Phase 1; does not reopen R16/R22/R23."
supersedes_partial: "docs/plans/2026-09-01-002-feat-centurion-workflow-triage-backfill-plan.md AE2/AE5/folder-mix success metric; does not supersede R22/R23 never-spam or spam_at matrix"
---

# feat: Centurion workflow triage quality — Automate, spam restore, quarantine label

## Goal Capsule

Fix live Centurion **label quality** after ops-green backfill: restore **Automated / Channel** for routine OTA/SynXis/channel/system notices, restore **Spam** for promo/cold-sales, put FortiMail **quarantine digests** in Spam with My Folder **`Quarantine`**, keep R22/R23 never-spam, then **re-backfill** with **folder-mix + spam-FN + Un/Rsp volume sanity** gates (not coverage-only audit).

Authority hierarchy: (1) this plan’s product locks, (2) R16/R22/R23 + folder-first `spam_at` matrix, (3) prior workflow triage plan for unchanged folders/tools.

Stop conditions: no pilot-RDS Vitest; no weakening never-spam; no `primaryFolder:'spam'`; no auto-send/archive; no second spam truth that contradicts `spam_at`.

## Product Contract

### Requirements

- **Q1 (lock 1A).** Routine OTA / SynXis / channel-manager / PMS system notices with **no** human quote/book/service obligation and **no** revenue SLA / unpaid / hard reply deadline → `primaryFolder=automated-channel`, empty `suggestedTools`, **not Urgent**. Bookings / Confirm / Exceptions only when human work or exception gates fire. **Supersedes** prior AE2 reading that dumped clean OTA new-reservation notices into Bookings for quality Phase 1. **This is why Automated existed** (channel notifications that must not be Urgent).
- **Q2.** Force-automate and force-spam paths **always** set `urgent=false` (and P4/P5 when forced Automate). Channel notifications must never land Urgent overlay. Do not port full legacy urgency refine — only clear urgent on forced paths + keep existing exception SLA urgent elsewhere.
- **Q3 (lock 2A).** Restore spam for: cold vendor / promo code / sales / newsletter / marketing blasts; partner booster with no booking request; cold charity. Keep R22 never-spam + staff-outbound + `spam_user_locked_at` / sender block-allow overrides. Force-spam must flip **`primaryFolder: bookings` + `isSpam: false`** model output when salesSignal matches (live failure mode).
- **Q4.** FortiMail / hard-rule **quarantine digests** (not bare “quarantine room” in guest bodies): `isSpam=true` → `spam_at`, **and** attach user label **`Quarantine`**. Not a workflow primary. Not `fileThreads`. **Nav + chrome:** reserved label routes as **`folder=spam` + `labelIds`** everywhere archive-like My Folder semantics appear (`route-filter`, `isArchiveLikeMailFolder`, filing snapshots, action availability) — not only `resolveMailRouteFilter`.
- **Q5.** `40mail` (sender/product fingerprint from Task 0 discovery) → `automated-channel` when routine; not spam unless promo body. Fold into U1 when known; do not defer past re-backfill if volume material.
- **Q6.** Workflow refine **deterministically** enforces Q1–Q4 (Q5 when known). Prompt-only is insufficient (live: Automate≈0, Spam≈9). Prompt wording may align in same U1 commit; no separate prompt-only unit.
- **Q7.** Success = **folder-mix + spam-FN quality**, not coverage-only. Floors via **re-refine on stored trigger bodies**: routine SynXis/OTA gold Automate recall ≥80%; promo/FortiMail gold spam recall ≥90%; spam-fp protected = 0; neverSpamInSpam=0. Gold fixtures: min **N≥25** routine Automate, **N≥25** promo spam, **N≥10** FortiMail digest, **N≥15** never-spam negatives — hashed IDs / synthetic bodies in committed `tests/fixtures/`; `.private/` only if raw samples needed for operator ops.
- **Q8.** Re-backfill unlocked eligible Centurion threads via existing snapshot → retag (`forceUnsettle`) → drain → audit → restore (U9/KTD21). New `KEY_PREFIX`. Abort+restore if Q7 or Q11 fails.
- **Q9.** R5 unchanged: internal property domains never `automated-channel`.
- **Q10.** Draft admission: `automated-channel` + spam → empty tools; Bookings must shed routine channel so drafting targets are human work.
- **Q11 (Un/Rsp volume sanity).** Post-backfill ops gate (fail-closed band, not exact equality): live folder counts must show Automate **≫0** (target lift ≈ SynXis/channel cohort ~249 toward Automate), Spam **≫9**, Bookings drop consistent with Automate lift. Cross-check actionable Un/Rsp/Act against defensible WINDOW baseline **Un 201 / Rsp 282 / Act 483 / uEPV R891k** (EOD 2026-09-01 exhaustive; artifacts under `.private/connected-mailbox-corpus/follow-up/defensible-daily-chart-2026-09-01-eod*`). That WINDOW **excludes** SynXis/channel auto from actionable denominator — Automate fill must not invent false “unanswered RFQs.” Method reuse: gold ledger + deterministic detectors + zero-contradiction audit (chat `93ca17e9`), not model-rebinding.

### Actors

- A1. Reservationist — sees Automate full of routine channel; Spam has promo + quarantine-labeled digests; Bookings is human work.
- A2. Operator — runs quality re-backfill with dry-run defaults; aborts on folder-mix / spam-FN / spam-FP gate fail.
- A3. Future drafting — benefits from Q10; no draft activation in this plan.

### Key Flows

- F1. Inbound → Mastra → **workflow refine (ordered forces)** → apply (`spam_at` + optional Quarantine label + primary join; urgent cleared on forced paths).
- F2. Routine SynXis confirm, no SLA → Automate, P4/P5, `urgent=false`, tools `[]`.
- F3. Promo / cold sales (even if model said bookings/non-spam) → `isSpam=true`, `spam_at`, no Quarantine label, `urgent=false`.
- F4. FortiMail quarantine digest → `isSpam=true`, `spam_at`, label `Quarantine`, `urgent=false`.
- F5. Quality re-backfill: quiesce → snapshot+manifest → retag → worker → audit (Q7 floors + Q11 volume) → restore on fail.

### Acceptance Examples

- AE-Q1. SynXis “Res Confirmed” / OTA confirmation with no unpaid/SLA/guest ask → `automated-channel`, not `bookings`, `urgent=false`, tools `[]`.
- AE-Q2. Same thread with “reply within 12h” / unpaid arrival → `exceptions-recovery` (or money/exceptions), **not** Automate.
- AE-Q3. Cold promo blast with model output `{ primaryFolder:'bookings', isSpam:false }` → refine forces `isSpam=true`, `spam_at`, no Quarantine label.
- AE-Q4. FortiMail quarantine summary → `isSpam=true`, `spam_at`, user label `Quarantine`; Quarantine My Folder lists it under spam+label.
- AE-Q5. LH From or staff-outbound + promo-looking body → **not** spam (R22).
- AE-Q6. Internal `branding.legacyhotels.co.za` → never `automated-channel`.
- AE-Q7. `40mail` routine notification → `automated-channel` once fingerprint known.
- AE-Q8. Post re-backfill: Automate ≫0; Spam ≫9; SynXis routine majority Automate; promo/FortiMail gold majority spam; spam-FP=0; neverSpamInSpam=0; Q11 volume band OK vs WINDOW.

### Scope Boundaries

**In scope:** shared predicates + workflow refine forces; prompt wording align in U1; apply Quarantine label on spam early-return; reserved Quarantine My Folder spam-scoped nav across archive-like surfaces; gold fixtures + `--quality` audit + Q11 volume gate; re-backfill runbook.

**Out of scope:** HMS/draft activation; Penny own-mailbox; ingest `mail_ingest_quarantine` drains; changing `spam_at` matrix; full Urgent redesign; conversation-link / thread-matching product work.

### Open Questions

- None blocking. `40mail` fingerprint = Task 0 discovery folded into U1 when found.

## Planning Contract

### Key Technical Decisions

- **KTD1 — Shared heuristics + force Automate.** Extract once: `isFortiMailQuarantineDigest`, `isRoutineSystemMail` (fixture-first: SynXis confirm/cancel, channel-manager confirms, FAILED TO INTEGRATE, calendar Canceled, known OTA system shapes — not open-ended sprawl), `hasRevenueRisk`, `salesSignal`. Workflow → `automated-channel` + `refine:system-mail-automated` + `urgent=false` + P4/P5 when routine, `!hasRevenueRisk`, not FortiMail digest, not series-release. Legacy keeps `ops` via same predicates.
- **KTD1b — Workflow refine order (mandatory).** (1) R22/R23 + hotel-conversation clear spam; (2) series-release → `exceptions-recovery` **before** force-automate; (3) force-spam (`refine:fortimail-spam`, `refine:promo-spam`) when not staff/never-spam/hotel-conversation — **including** when model said `isSpam:false` + `bookings`; set `urgent=false`; (4) force-automate + `urgent=false`; (5) internal-property demotion; (6) hospitality.cloud finance. Never re-spam after step 1 clears. (KTD4 folded here.)
- **KTD2 — Force spam.** FortiMail digest → `isSpam=true` without legacy `ops∧ops` gate. Digest = `fortimail` **or** `quarantine digest|quarantine summary`. Promo = legacy `salesSignal` through never-spam belts. Negatives: “quarantine room” booking; empty-body/short-personal/property-subject. Extend spam-fp-v6 workflow parity.
- **KTD3 — Quarantine label on apply (no schema field).** When `effectiveIsSpam && policyFlags.includes('refine:fortimail-spam')`: in **same transaction** as `spam_at` set, ensure-by-name `Quarantine` and merge `labelIds`. Non-FortiMail spam / non-spam full apply: strip Quarantine id if present. No `quarantineLabel` schema field. Do not reuse ingest `soft-quarantine`.
- **KTD3a — Quarantine nav + chrome.** Reserved name `Quarantine` → `folder=spam` + `labelIds` in `route-filter` **and** every archive-like consumer (`isArchiveLikeMailFolder`, filing snapshots, action availability). Callers pass reserved spam label IDs (name→UUID from labels). Tests cover list visibility + non-archive chrome.
- **KTD5 — Quality gates (fail-closed).** Extend existing `audit-centurion-triage-retag.mjs` with `--quality` (import shared refine — **no** duplicated heuristics): (a) spam-fp-v6=0; (b) Automate recall ≥80% re-refine; (c) spam recall ≥90%; (d) neverSpamInSpam=0 + staffOutboundInSpam=0; (e) **Q11** live folder-count + actionable Un/Rsp/Act band vs WINDOW. Coverage-only green = failure. Gold: committed synthetic fixture with min N (Q7); build methodology documented before ops apply.
- **KTD6 — Re-backfill.** U9/KTD21 cohorts; new KEY_PREFIX; abort+restore on KTD5 fail.
- **Prompt:** one-line align in U1 commit if needed; refine + gold floors are enforcement.

### Assumptions

- Live mix (Bookings ~1624 / Automate 0 / Spam ~9 / SynXis→Bookings ~249) still representative until re-backfill.
- User locks 1A/2A/Quarantine-my-folder/`40mail`→Automate / notifications-not-urgent reconfirmed 2026-09-02 evening.
- Defensible WINDOW Un 201 / Rsp 282 / Act 483 / uEPV R891k is the actionable Un/Rsp sanity baseline; Automate class excluded from that denominator by design.
- Disposable DB for Vitest; pilot `DATABASE_URL` only for Centurion ops scripts — never Vitest.

### Sequencing

1. Task 0 discovery: 40mail fingerprint + gold sample lists (Automate / promo / FortiMail) → committed synthetic fixtures with min N.
2. TDD U1: shared predicates + force Automate + series-release + urgent clear + optional prompt one-liner + 40mail if known.
3. TDD U2: force spam (bookings→spam flip) + FortiMail digest.
4. TDD U3: apply Quarantine on spam early-return + full spam-scoped My Folder chrome.
5. Quality audit `--quality` + Q11 volume + re-backfill runbook.
6. Dry-run → cohorts → final gates → restore on fail → live spot-check.

### Risks

- Over-forcing Automate swallows real guest asks → revenue/SLA/guest-impact gates + gold FN review.
- Promo force-spam raises FP → R22 + spam-fp-v6; never expand never-spam casually.
- Quarantine rename by user → ensure-by-name; document reserved name vs ingest soft-quarantine.
- Audit green via model rebinding (Codex failure) → gates vs gold + re-refine + Q11, never “whatever Nova emitted.”
- Quarantine nav only patching `route-filter` → archive-like chrome still wrong → KTD3a full surface.

## Implementation Units

### U0 — Discovery + gold fixtures (blocking for U4 ops)

**Files:** `apps/server-pilot/tests/fixtures/centurion-triage-quality-gold.json` (+ builder notes); optional `.private/` samples

**Scenarios:** min N per Q7; methodology note; 40mail fingerprint if present.

### U1 — Shared heuristics + workflow force Automate (+ series-release + urgent clear)

**Files:** `apps/server-pilot/src/ai/triage.ts`, `apps/server-pilot/tests/ai-triage-refine.test.ts`, optional one-line `mail-triage.ts` prompt align

**Scenarios:** AE-Q1, AE-Q2, AE-Q6; series-release → exceptions before automate; `urgent=false` on force-automate; 40mail when known.

### U2 — Workflow force spam (promo + FortiMail digest)

**Files:** `apps/server-pilot/src/ai/triage.ts`, `apps/server-pilot/tests/ai-triage-refine.test.ts`, `apps/server-pilot/tests/spam-fp-v6.test.ts`, fixtures

**Scenarios:** AE-Q3 (bookings→spam flip), AE-Q4, AE-Q5; quarantine-room negative; empty-body parity; `urgent=false`.

### U3 — Apply Quarantine label + spam-scoped My Folder chrome

**Files:** `apps/server-pilot/src/ai/triage.ts` (spam early-return + labelIds), `apps/mail/lib/mail/route-filter.ts` + archive-like helpers/tests, apply tests

**Scenarios:** AE-Q4; label lifecycle; Quarantine not archive-like; design-review gate before FE merge.

### U4 — Quality floors + Q11 volume + re-backfill runbook

**Files:** `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs`, gold fixtures, audit tests, handoff footnote AE2 superseded

**Scenarios:** AE-Q8; fail closed; restore path; WINDOW volume band.

## Verification Contract

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before every Vitest.
- Vitest: refine + spam-fp-v6 + apply/label + route-filter/archive-like on disposable DB only.
- Ops: snapshot → dry-run → restore drill → cohorts → **Q7 + Q11** before expand.
- Read-only SSM/SQL OK for live mix; no Vitest against pilot RDS.
- Design-plan review required before U3 FE merge (DoD).

## Definition of Done

- [ ] Q1–Q4, Q6–Q11 green in code + tests (Q5 when fingerprint known).
- [ ] AE-Q1–AE-Q6, AE-Q8 green; AE-Q7 when U1 fold-in lands.
- [ ] Protected spam-FP = 0.
- [ ] Re-backfill: Automate ≥80% / spam ≥90% floors + neverSpamInSpam=0 + Q11 volume band.
- [ ] Live: Automate non-zero; Spam restored; Quarantine My Folder shows FortiMail digests under spam+label; Urgent not flooded with channel notices.
- [ ] U3 design-plan review recorded.
- [ ] Pilot-RDS safety never violated.

## Appendix

### Review disposition (2026-09-02 evening refresh)

- **Eng MUST-FIX applied:** KTD3a full archive-like surface; Q2 urgent clear on forced paths; Q11 WINDOW volume gate; force-spam from bookings/non-spam; gold min-N methodology; Quarantine label on spam early-return apply.
- **Eng SHOULD-FIX applied:** broader routine-system fixture set; shared refine import for audit; Quarantine name→UUID wiring; series-release fixture; design-review in DoD; 40mail in Task 0/U1.
- **Ponytail applied:** fold prompt unit into U1; fold KTD4 into KTD1b; single committed gold fixture path; drop optional Task 6 header; no second audit driver; no quarantineLabel schema field.
- **Design-plan review:** still required for U3 before FE merge.

### Evidence

- Workflow refine: no force-to-`automated-channel`; demotes Automate→`internal-partner` for internal property only.
- Legacy owns `refine:system-mail-ops` / `refine:fortimail-spam`; promo heuristics demote from spam, do not force spam on workflow path.
- `applyDurableTriageResult` spam early-return does not touch `labelIds`; `fileThreads` clears `spam_at`.
- Default My Folder = `archive+labelIds` + `spam_at IS NULL` → Quarantine needs spam-scoped exception across chrome.
- Live post-ops-backfill: Automate **0**, Spam **~9**, Bookings **~1624**, SynXis→Bookings **~249**, Urgent joins **0**.
- Defensible Un/Rsp WINDOW: Un **201** / Rsp **282** / Act **483** / uEPV **R891k** (channel auto excluded from Act).

### Product locks (user 2026-09-02 evening)

1. **1A** — routine OTA/SynXis/channel → Automated / Channel (reason folder exists; not Urgent).
2. **2A** — restore promo/cold-sales → Spam (R22 preserved).
3. FortiMail **quarantine digests** → Spam **and** Quarantine My Folder (spam-scoped).
4. `40mail` → Automated when routine.
5. Use Un/Rsp WINDOW + exhaustive audit method as post-backfill volume sanity.