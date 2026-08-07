# Phase B autonomous live completion — 2026-08-06

Supersedes the “human next” close of
[`2026-08-06-phase-b-overnight-handoff.md`](./2026-08-06-phase-b-overnight-handoff.md)
and the early live-blocker dossier
[`2026-08-06-phase-b-live-blocker.md`](./2026-08-06-phase-b-live-blocker.md):
Tasks 11–17 shipped operator + live drivers; Task 18 reconciled activation
truth, fixed fail-closed preserve-actives, and closed the empirical handoff
under accepted named blockers.

## Commit / deploy

| Item | Value |
|------|-------|
| Feature branch | `phase-b-autonomous-read-expansion` |
| Task 18 HEAD (laptop) | `c2795e1b64aad61e8329b2e065dfd5aa10af06dd` |
| BASE (Task 17 Approved) | `1e66e739` |
| EC2 HEAD (post-deploy) | `c2795e1b64aad61e8329b2e065dfd5aa10af06dd` |
| Deploy | `GIT_BRANCH=phase-b-autonomous-read-expansion` via `ops-deploy.sh` (bundle; no force; no `HMS_REGISTRY_CANDIDATE`) |
| `/health` | 200 `{"ok":true,"service":"server-pilot"}` |
| VPN | `VPN_HARD_OK` |

## Registry reconcile (critical)

**RCA — Task 17 `productionActiveReadToolIds: []` was not a deploy wipe.**

1. EC2 `/opt/nava/shared/hms-active-registry/active.json` retained six actives through Task 17/18 plain source deploys (fingerprints match; generation 13).
2. Laptop `ops-hms-proof.sh status|doctor` reads that absolute path locally. On Windows it is **missing** → soft-empty snapshot masqueraded as wiped actives.
3. Doctor also ignored the loaded snapshot when painting tool rows (`toolStatusRow(toolId)` without snapshot) — fixed in Task 18.
4. Plain `ops-deploy` does **not** touch `active.json` when `HMS_REGISTRY_CANDIDATE` unset.
5. Fail-closed fix: `assertCandidatePreservesActiveTools` in `runSourceRegistryTransaction` refuses candidates that drop currently-active tools (empty/sparse CAS can no longer wipe).
6. Status/doctor now emit `registryLoadState: ok|missing|invalid`.

### EC2 active set (truth)

| Tool | activeReleaseId | Notes |
|------|-----------------|-------|
| `hms_find_reservation` | `0b552676-8d1d-45a6-b64c-65b763d46797` | retained |
| `mail_read_artifact` | `9f332933-f31d-4bed-9af9-ace8cb951b25` | retained |
| `hms_quote_stay` | `1a487e1e-5daa-48df-9f19-cce996552f3c` | retained; private artifact present |
| `hms_sent_email_audit` | `1f5616f2-f9cd-4413-a3e5-78a97452364a` | retained; private artifact present |
| `hms_list_documents` | `0cac1b46-19d4-4e83-83ec-ccaef95f5139` | sent-email branch only |
| `hms_read_folio` | `94f30a6d-6cf9-4173-9291-746f6412eb37` | folio_summary only |
| `hms_company_account_read` | null | blocked |
| `hms_group_block_read` | null | blocked |
| `hms_event_read` | null | blocked |

No re-proof of valid current releases. Rollback→re-promote evidence remains from Tasks 14–16 reports (independent per tool).

## Private artifacts (PII-free)

EC2 status (on-box): quote / sent-email / list-documents each bind `privateArtifactIds` length 1 (UUIDs only; 24h media TTL under root-only store). Folio/find/mail may show empty private IDs until masked materializers land — not a promotion revoke.

Do not fetch raw trace/video in this handoff.

## Local gates

| Gate | Result |
|------|--------|
| Task 18 Vitest suite (22 files) | 413 pass / 15 skip |
| `pnpm build` | ok |
| `bash -n` ops-hms-proof + hms-read-gate | ok |
| `hms-read-gate.sh --fixture-only --wave B6` | PASS |
| Disposable `TEST_DATABASE_URL` | **missing** — full DB gate blocked only |
| CE review | CLEARED |
| Ponytail | Lean already. Ship. |

Also shipped: quote/folio facades (production `*-driver.ts` raw-page ban), contracts allowlist test aligned to empty static live flags, health JSON read retry on Windows.

## Portfolio verification

```text
eval:hms-portfolio-ablation
  denominator: 56
  baseline deltaFull: 1
  promotedReleaseOrder: []   # source static allowlist empty by design
  portfolioPromotionBlocked: true

eval:hms-shadow
  denominatorSize: 56
  labelledEligible: 35
  strictFullRate: ~0.029
  hardGates: all true
  passed: true
```

Product impact: ablation baseline `ΔFull=1` vs frozen foundation math, but **promoted-tool steps empty** in source ablation (registry actives not mirrored into `READ_TOOLS.promotionEvidence.live`). Treat **portfolio product completion as unproven** for Phase C expansion gate; keep EC2 tools independently active.

Shadow consecutive holdout ≥30 for `shadow_enabled` successor: not created (fixture shadow eval ≠ post-freeze holdout bound to fingerprints).

## Accepted true blockers (user-accepted scope)

- `BLOCKED_TAX_INVOICE_SURFACE_UNPROVEN` — re-confirmed 2026-08-07 (entitlement)
- ~~`BLOCKED_DEPOSIT_LEDGER_RESERVATION_SCOPE_UNPROVEN`~~ — **CLEARED 2026-08-07** (OSLEDG.DLD + promote gen 16)
- `BLOCKED_COMPANY_READ_SURFACE_UNPROVEN` — re-confirmed (billing trio absent)
- `BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN` — re-confirmed (list-only)
- `BLOCKED_EVENT_READ_SURFACE_UNPROVEN` — re-confirmed (Events menu absent)
- Missing disposable non-production DB (full gate only)

## Addendum 2026-08-07 — deposit unlock + folio upgrade

| Item | Value |
|------|-------|
| Laptop / EC2 HEAD | `a5a9945c` (`fix(hms): set folio release predecessor…`; prior `b7fb667f` DLD) |
| Deploy | `GIT_BRANCH=EC2-pilot` `ops-deploy.sh` ok; health + VPN HARD ok |
| Folio active | `668c7395-795a-400d-9881-52082d68b5c7` (gen **16**) |
| Branches | `folio_summary` + `deposit_ledger_summary` |
| Predecessor | `94f30a6d-…` / `restore_predecessor` (rollback drill → re-promote ok) |
| Evidence | `.superpowers/sdd/deposit-ledger-reprove-2026-08-07.md`, `.superpowers/sdd/blocker-reprove-brief-2026-08-07.md` |

Remaining external blockers: Tax Invoice entitlement, Company billing trio, Group Block-tab aggregates, Event Events menu. No further Phase B surface expansion without hotel grant / contract change.

## User wake-up

**Empty.** No true unresolved blocker requiring human action tonight beyond accepting the named surface blockers already in plan scope. Phase C write portfolio stays separate.

## Solutions / docs touched

- Runbook: `docs/infor-hms/phase-b-read-portfolio-operator-runbook.md` (capability table + laptop vs EC2 status)
- Task report: `.superpowers/sdd/task-18-report.md`
