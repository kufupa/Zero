---
title: "feat: Centurion workflow triage quality — Automate, spam restore, quarantine label"
date: 2026-09-02
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
origin: "User locks 2026-09-02 (1A routine channel→Automated; 2A restore promo/cold/FortiMail spam; quarantine My Folder + spam_at; 40mail→Automated). Live mix evidence from chat 93ca17e9. Supersedes AE2 routine-OTA→Bookings reading for quality Phase 1; does not reopen R16/R22/R23."
supersedes_partial: "docs/plans/2026-09-01-002-feat-centurion-workflow-triage-backfill-plan.md AE2/AE5/folder-mix success metric; does not supersede R22/R23 never-spam or spam_at matrix"
---

# feat: Centurion workflow triage quality — Automate, spam restore, quarantine label

## Goal Capsule

Fix live Centurion **label quality** after ops-green backfill: restore **Automated / Channel** for routine OTA/SynXis/channel/system notices, restore **Spam** for promo/cold-sales/FortiMail quarantine digests (with My Folder `Quarantine` on hard-rule quarantine), keep R22/R23 never-spam, then **re-backfill** eligible unlocked threads with a **folder-mix + spam-FN gate** (not coverage-only audit).

Authority hierarchy: (1) this plan’s product locks, (2) R16/R22/R23 + folder-first `spam_at` matrix, (3) prior workflow triage plan for unchanged folders/tools.

Stop conditions: no pilot-RDS Vitest; no weakening never-spam; no `primaryFolder:'spam'`; no auto-send/archive; no second spam truth that contradicts `spam_at`.

## Product Contract

### Requirements

- **Q1 (lock 1A).** Routine OTA / SynXis / channel-manager / PMS system notices with **no** human quote/book/service obligation and **no** revenue SLA / unpaid / hard reply deadline → `primaryFolder=automated-channel`, empty `suggestedTools`, not Urgent. Bookings / Confirm / Exceptions only when human work or exception gates fire. **Supersedes** prior AE2 reading that dumped clean OTA new-reservation notices into Bookings for quality Phase 1.
- **Q2.** Notifications that previously could not be Urgent stay non-urgent; Automated / Channel is the home for that class (reason Automated existed).
- **Q3 (lock 2A).** Restore spam for: cold vendor / promo code / sales / newsletter / marketing blasts; FortiMail / quarantine **bulk digests**; partner booster with no booking request; cold charity. Keep R22 never-spam + staff-outbound + `spam_user_locked_at` / sender block-allow overrides.
- **Q4.** FortiMail / hard-rule quarantine digests: set `isSpam=true` → durable `spam_at`, **and** attach Centurion user label **`Quarantine`** so digests are separable from cold-sales spam. Do **not** invent a workflow primary slug `quarantine`. Do **not** use `fileThreads` (archives + clears `spam_at`). **List contract:** Quarantine nav must resolve to **`folder=spam` + `labelIds=[quarantineLabelId]`**, not default My Folder `archive+labelIds` (otherwise threads with `spam_at` are invisible).
- **Q5.** `40mail` (sender/product fingerprint confirmed in discovery) → `automated-channel` when routine notification-shaped; not spam unless promo/sales body. Non-blocking for U1–U5; fold into Automate force once fixture exists.
- **Q6.** Workflow refine must **deterministically** enforce Q1–Q4 (and Q5 when known). Prompt-only is insufficient (live proof: Automate≈0, Spam≈9 after model+demotion-only refine).
- **Q7.** Success metric for this plan = **folder-mix + spam-FN quality**, not “eligible coverage + neverSpamInSpam=0” alone. Concrete floors: routine SynXis/OTA gold Automate recall ≥80%; promo/FortiMail gold spam recall ≥90%; protected spam-FP = 0; neverSpamInSpam=0. Gates compare **deterministic re-refine** on stored trigger bodies / policy flags — not raw model output.
- **Q8.** Re-backfill unlocked eligible Centurion threads via existing snapshot → retag (`forceUnsettle`) → drain → audit → restore rails per prior U9/KTD21 (quiesce, restore drill, cohorts 50→250→remainder, Bedrock throttle). New `KEY_PREFIX`. Skip `spam_user_locked_at` and sender block/allow. Preserve R22 clear-spam-on-never-spam. Abort+restore if Q7 fails.
- **Q9.** R5 unchanged: internal property domains never `automated-channel` (`refine:internal-property-source` demotion stays).
- **Q10.** Draft admission: `automated-channel` and spam keep empty tools; Bookings pollution from routine channel must drop so drafting targets are human work.

### Actors

- A1. Reservationist — sees Automate full of routine channel; Spam has promo + quarantine-labeled digests; Bookings is human work.
- A2. Operator — runs quality re-backfill with dry-run defaults; aborts on folder-mix / spam-FN / spam-FP gate fail.
- A3. Future drafting — benefits from Q10; no draft activation in this plan.

### Key Flows

- F1. Inbound → Mastra workflow triage → **workflow refine with force-automated + force-spam + quarantine label flag** → apply (`spam_at` + optional Quarantine label + primary join).
- F2. Routine SynXis confirm, no SLA → Automate, P4/P5, tools `[]`.
- F3. Promo / cold sales → `isSpam=true`, `spam_at`, no Quarantine label.
- F4. FortiMail quarantine digest → `isSpam=true`, `spam_at`, label `Quarantine`.
- F5. Quality re-backfill: quiesce → app snapshot+manifest → retag unsettle → worker → audit with folder-mix+spam gates → restore on fail.

### Acceptance Examples

- AE-Q1. SynXis “Res Confirmed” / OTA confirmation with no unpaid/SLA/guest ask → `automated-channel`, not `bookings`, not urgent, tools `[]`.
- AE-Q2. Same thread with “reply within 12h” / unpaid arrival → `exceptions-recovery` (or money/exceptions per existing gates), **not** Automate.
- AE-Q3. Cold promo / promo-code sales blast → `isSpam=true`, durable `spam_at`, no Quarantine label.
- AE-Q4. FortiMail quarantine summary → `isSpam=true`, `spam_at`, user label `Quarantine` present on thread.
- AE-Q5. LH From or staff-outbound thread with promo-looking body → **not** spam (R22); workflow primary per never-spam remap.
- AE-Q6. Internal `branding.legacyhotels.co.za` delivery/ops → never `automated-channel`.
- AE-Q7. `40mail` routine notification → `automated-channel` once fingerprint locked in discovery fixture.
- AE-Q8. Post re-backfill: SynXis routine cohort majority in Automate; promo/FortiMail gold majority in spam; protected spam-FP suite still 0 regressions; never-spam not left in `spam_at`.

### Scope Boundaries

**In scope:** `refineWorkflowTriageOutput` deterministic promotes; prompt v6/v7 wording aligned to Q1; apply path attaching Quarantine label; seed/ensure label; fixtures + refine/spam-fp/folder-mix gates; retag/audit extensions for quality gates; operator re-backfill runbook.

**Out of scope:** HMS tool activation; draft generation; Penny own-mailbox transport; ingest quarantine table drains; changing `spam_at` folder matrix; Urgent product redesign beyond “notifications not urgent”; conversation-link / thread-matching.

### Open Questions

- **Deferred (non-blocking):** Exact `40mail` From/domain/subject fingerprint — Task 0 discovery; one refine fixture when known; does not block U1–U5 DoD.

## Planning Contract

### Key Technical Decisions

- **KTD1 — Shared heuristics + force Automate.** Extract shared predicates once (`isFortiMailQuarantineDigest`, `isRoutineSystemMail`, `hasRevenueRisk`, `salesSignal`) used by legacy + workflow. Workflow promote → `automated-channel` + `refine:system-mail-automated` when routine system mail, `!hasRevenueRisk`, not FortiMail digest, not series-release. Fixture-driven OTA patterns only (no open-ended regex sprawl). Legacy keeps `ops` assignment via same predicates.
- **KTD1b — Workflow refine order (mandatory).** (1) R22/R23 + hotel-conversation clear spam; (2) port `refine:series-release-at-risk` → `exceptions-recovery` **before** force-automate; (3) force-spam (`refine:fortimail-spam`, `refine:promo-spam`) only when not staff/never-spam/hotel-conversation; (4) force-automate; (5) internal-property demotion; (6) hospitality.cloud finance. Never re-spam in same pass after step 1 clears.
- **KTD2 — Force spam.** FortiMail digest → `isSpam=true` without legacy `ops∧ops` gate. Digest detector = `fortimail` **or** `quarantine digest|quarantine summary` (not bare `\bquarantine\b` in guest bodies). Promo force reuses legacy `salesSignal` regex inverted through never-spam belts. Negative fixture: booking thread mentioning “quarantine room” → not spam. Extend spam-fp-v6 with workflow empty-body / short-personal / property-subject parity before ship.
- **KTD3 — Quarantine label on apply (no schema field).** Attach solely when `effectiveIsSpam && policyFlags.includes('refine:fortimail-spam')`. Ensure-by-name user label `Quarantine`; merge into `labelIds` without clearing `spam_at`. On full apply **else** remove Quarantine label id if present. **No** `quarantineLabel` output field (schema stays `.strict()`). Do not reuse ingest `soft-quarantine` name.
- **KTD3a — Quarantine nav list contract.** FE `route-filter` + listThreads: reserved Quarantine label routes as **`folder=spam` + labelIds filter**, not `archive+labelIds`. Tests: spam+Quarantine visible in Quarantine nav; cold promo spam has no Quarantine label; archive-only label queries exclude `spam_at` rows.
- **KTD4 — Do not port legacy urgency refine wholesale.** Forced Automate / FortiMail / promo paths set non-urgent.
- **KTD5 — Quality gates (fail-closed).** Extend `audit-centurion-triage-retag.mjs` with `--quality` + gold fixture JSON (not a second full audit driver): (a) spam-fp-v6 = 0 protected regressions pre-apply; (b) routine OTA/SynXis gold Automate recall ≥80% via **re-refine**; (c) promo/FortiMail gold spam recall ≥90%; (d) neverSpamInSpam=0 + staffOutboundInSpam=0. Coverage-only green is failure.
- **KTD6 — Re-backfill.** Follow prior U9/KTD21 cohort/throttle/restore; new KEY_PREFIX; abort+restore on KTD5 fail.
- **KTD7 — Prompt alignment.** Update `mail-triage.ts` so routine system notices → Automate (Q1); keep true guest/agency book/quote in Bookings. Note in prior triage handoff: AE2 superseded for routine system notices by this plan.

### Assumptions

- Live mix (Bookings 1624 / Automate 0 / Spam ~9) still representative until re-backfill.
- User locks 1A/2A/quarantine-my-folder are final for this plan.
- Disposable DB available for Vitest; pilot ops scripts may use pilot `DATABASE_URL` read/write for Centurion retag only — never Vitest.

### Sequencing

1. Discovery: 40mail fingerprint + sample gold lists (Automate / spam / quarantine).
2. TDD: workflow refine force-automated + force-spam + quarantine flag.
3. TDD: apply Quarantine label with spam_at.
4. Prompt + contract tests align.
5. Quality gate harness + audit extensions.
6. Dry-run retag → cohort apply → full eligible → audit gates → restore drill documented.

### Risks

- Over-forcing Automate swallows real OTA guest asks → mitigate with revenue/SLA/guest-impact gates + gold FN review.
- Promo force-spam raises FP → keep R22 belt + spam-fp-v6 protected set; never expand never-spam casually.
- Quarantine label drift if renamed by user → ensure-by-name per transport on apply; document reserved name.
- Audit green via model rebinding (past failure) → gates must compare to **gold/cohort heuristics**, not “whatever Nova emitted.”

## Implementation Units

### U1 — Shared heuristics + workflow force Automate (+ series-release)

**Files:** `apps/server-pilot/src/ai/triage.ts`, `apps/server-pilot/tests/ai-triage-refine.test.ts`

**Scenarios:** AE-Q1, AE-Q2, AE-Q6; held-series release → `exceptions-recovery` not Automate; policy `refine:system-mail-automated`; 40mail when fingerprint known (fold-in).

### U2 — Workflow force spam (promo + FortiMail digest)

**Files:** `apps/server-pilot/src/ai/triage.ts`, `apps/server-pilot/tests/ai-triage-refine.test.ts`, `apps/server-pilot/tests/spam-fp-v6.test.ts`, fixtures

**Scenarios:** AE-Q3, AE-Q4, AE-Q5; bare “quarantine room” negative; workflow empty-body/short-personal parity.

### U3 — Apply Quarantine label + spam-scoped My Folder nav

**Files:** `apps/server-pilot/src/ai/triage.ts`, `apps/mail/lib/mail/route-filter.ts`, mail list filter tests, apply tests

**Scenarios:** AE-Q4; label lifecycle remove when not FortiMail; Quarantine nav uses spam+labelIds.

### U4 — Prompt / contract alignment for Q1

**Files:** `apps/server-pilot/src/ai/workflows/mail-triage.ts`, `apps/server-pilot/tests/ai-triage-contract.test.ts`

### U5 — Quality floors on audit + re-backfill runbook

**Files:** `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs` (+ gold fixture JSON under `.private/` / hashed committed stubs), tests, handoff note that AE2 routine-system reading is superseded

**Scenarios:** AE-Q8; fail closed; restore path.

## Verification Contract

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before every Vitest invocation.
- Vitest: refine + spam-fp-v6 + contract + apply/label + route-filter tests on disposable DB only.
- Ops: snapshot → dry-run retag → restore drill → cohorts → **quality floors** before expand.
- Read-only SSM/SQL OK for live mix; no Vitest against pilot RDS.

## Definition of Done

- [ ] Q1–Q4, Q6–Q10 green in code + tests (Q5/40mail when fingerprint known).
- [ ] AE-Q1–AE-Q6, AE-Q8 green; AE-Q7 when U1 fold-in lands.
- [ ] Protected spam-FP regressions still 0.
- [ ] Re-backfill audit passes Automate ≥80% / spam ≥90% floors + neverSpamInSpam=0.
- [ ] Live spot-check: Automate non-zero; Spam restored; Quarantine nav shows FortiMail digests under spam+label.
- [ ] Pilot-RDS safety never violated.

## Appendix

### Review disposition (2026-09-02)

- **Eng MUST-FIX applied:** KTD3a spam-scoped Quarantine nav; refine order + series-release; KTD5 concrete floors; no `quarantineLabel` schema field.
- **Eng SHOULD-FIX applied:** label lifecycle; narrower FortiMail digest detector; spam-fp workflow demotion parity; KTD21 re-backfill; AE2 supersede note; 40mail non-blocking.
- **Ponytail applied:** shared predicates; reuse salesSignal; extend existing audit (no second driver); cut quarantineLabel; fold U6; apply-time ensure-by-name only.
- **Design-plan review:** required for U3 Quarantine nav (spam-scoped My Folder exception) before FE merge.

### Evidence (2026-09-02)

- Workflow refine has **no** force-to-`automated-channel`; only demotes Automate→`internal-partner` for internal property (`triage.ts` `refineWorkflowTriageOutput`).
- Legacy `refine:system-mail-ops` / `refine:fortimail-spam` live only on legacy category path.
- Promo heuristics on legacy path **demote from spam**, do not force spam; workflow spam is prompt-only.
- `applyDurableTriageResult` does not touch `labelIds`; `fileThreads` clears `spam_at` — forbidden for Q4.
- Default My Folder routes are `archive+labelIds` and require `spam_at IS NULL` — Quarantine needs spam-scoped exception.
- Live mix after ops backfill: Automate **0**, Spam **~9**, Bookings **~1624**; SynXis→Bookings **~249**.

### Product locks (user 2026-09-02)

1. **1A** — routine OTA/SynXis/channel → Automated / Channel.
2. **2A** — restore promo/cold-sales/FortiMail/quarantine → Spam (R22 preserved).
3. Quarantine digests → Spam **and** Quarantine label (spam-scoped nav).
4. `40mail` → Automated when routine (non-blocking fingerprint).
