# Phase B HMS read portfolio operator runbook

Status: Task 12 live operator wired. Shared argv parser + atomic operation
store + terminal matrix. Offline doctor keeps rich `phase-b-doctor.ts` path;
mutating Phase B actions use `local-operator` with resume + durable store.
Named terminal codes only — never a generic blocked stub. Live browser
discovery/proof still reuse Phase A login/chrome/guard/capture via
`hms-live-proof.ts` (sole proof CLI). Do not invent live proofs or
auto-approve unknown request rules. Full live browser discovery remains
Task 13+ (drivers + EC2 evidence).

## Capability reality

| Tool | State | EC2 `active.json` |
|------|-------|-------------------|
| `hms_find_reservation` | fixture_verified contract; live release active | yes |
| `mail_read_artifact` | fixture_verified; live release active | yes |
| `hms_quote_stay` | fixture_verified; live release active | yes |
| `hms_sent_email_audit` | discovery_verified; live release active | yes |
| `hms_list_documents` | discovery_verified (sent-email branch); live release active | yes |
| `hms_read_folio` | discovery_verified (folio_summary); live release active | yes |
| `hms_company_account_read` | fixture_verified | **blocked** `BLOCKED_COMPANY_READ_SURFACE_UNPROVEN` |
| Tax Invoice branch | — | **blocked** `BLOCKED_TAX_INVOICE_SURFACE_UNPROVEN` (2026-08-07 menu-first re-prove: Front Desk > Tax Invoice absent; Stay 360 tile absent) |
| Deposit ledger branch | — | **blocked** `BLOCKED_DEPOSIT_LEDGER_RESERVATION_SCOPE_UNPROVEN` |
| `hms_group_block_read` | fixture_verified | **blocked** `BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN` |
| `hms_event_read` | fixture_verified | **blocked** `BLOCKED_EVENT_READ_SURFACE_UNPROVEN` |

**Laptop vs EC2 status:** `ops-hms-proof.sh status|doctor` reads
`/opt/nava/shared/hms-active-registry/active.json` on the local machine.
On Windows laptop that path is missing → `registryLoadState=missing` and
empty `productionActiveReadToolIds` (not a live wipe). Trust EC2 on-box
status for activation truth. CAS refuse candidates that drop current actives.

Accepted named blockers revise portfolio DoD; Phase C expansion stops until
product holdout `ΔFull > 0` with promoted tools in ablation (source static
allowlist stays empty by design).

```bash
cd "/c/Users/gamin/Desktop/projs/emails hotels uis/zero/apps/server-pilot"
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm eval:hms-portfolio-ablation
```

## Golden path

Windows Git Bash (repository path may contain spaces):

```bash
cd "/c/Users/gamin/Desktop/projs/emails hotels uis/zero"
bash apps/server-pilot/deploy/ops-hms-proof.sh --help
bash apps/server-pilot/deploy/ops-hms-proof.sh doctor --json
bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only --tool hms_find_reservation
bash apps/server-pilot/deploy/ops-hms-proof.sh read-discovery hms_find_reservation --json
bash apps/server-pilot/deploy/ops-hms-proof.sh read-proof hms_find_reservation --json
bash apps/server-pilot/deploy/ops-hms-proof.sh artifacts hms_find_reservation --latest-usable --json
bash apps/server-pilot/deploy/ops-hms-proof.sh read-promote hms_find_reservation --release <uuid> --json
bash apps/server-pilot/deploy/ops-hms-proof.sh status --tool hms_find_reservation --json
bash apps/server-pilot/deploy/ops-hms-proof.sh read-rollback hms_find_reservation --json
```

Follow each returned `nextCommand`. Never source `.env.production` into a
shell running Vitest. Before every test command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

## Phase B operator grammar

Public contract (help/grammar perform no AWS call; unknown IDs exit `2`):

```text
ops-hms-proof.sh --help
ops-hms-proof.sh doctor [--offline] [--tool <tool-id>|--wave <subwave-id>] [--action <action>] [--json]
ops-hms-proof.sh status [--tool <tool-id>|--wave <subwave-id>|--operation <uuid>] [--json]
ops-hms-proof.sh read-discovery <tool-id> [--resume <operation-id>] [--json]
ops-hms-proof.sh read-proof <tool-id> [--resume <operation-id>] [--json]
ops-hms-proof.sh read-wave <subwave-id> [--resume <operation-id>] [--json]
ops-hms-proof.sh artifacts <tool-id> [--operation <uuid>|--release <uuid>|--latest-usable] [--json]
ops-hms-proof.sh fetch-artifact <uuid> receipt
ops-hms-proof.sh fetch-artifact <uuid> <trace|video> --confirm-sensitive
ops-hms-proof.sh read-promote <tool-id> --release <release-id> [--resume <operation-id>] [--json]
ops-hms-proof.sh read-rollback <tool-id> [--resume <operation-id>] [--json]
ops-hms-proof.sh rearm <tool-id> --operation <superseded-operation-id> --after-source <revision> [--resume <successor-operation-id>] [--json]
```

One TypeScript parser (`phase-b-operation.ts`) validates argv locally and on
EC2. Bash has no second Phase B `case` grammar or per-tool behavior. `--json`
emits exactly one `PhaseBOperatorResult` on stdout.

### Terminal ownership (fixed)

| Exit | Codes | Owner | Retry |
|------|-------|-------|-------|
| 0 | COMPLETE / NOOP_ALREADY_APPLIED / NEXT_ACTION_READY | none | none |
| 2 | USAGE_ERROR | agent | none |
| 3 | MANIFEST_SOURCE_CHANGE_REQUIRED / AGENT_REPAIR_REQUIRED | agent | after_source_change |
| 3 | BLOCKED_NO_POSITIVE_CONTROL / BLOCKED_EXTERNAL | external | after_external_recovery |
| 10 | POLICY_OR_EVIDENCE_REJECTED / BLOCKED_REQUEST_SEMANTICS_UNPROVEN | safety | none |
| 20 | ROLLBACK_INCOMPLETE | safety | none |
| 70 | TRANSPORT_UNCERTAIN | agent | same_operation |

Unknown request rules are never auto-approved. Missing pre-transmission
evidence → `BLOCKED_REQUEST_SEMANTICS_UNPROVEN`. Missing control oracle →
`BLOCKED_NO_POSITIVE_CONTROL`. Mask before capture; raw media `0700/0600`,
24h purge, confirm-sensitive fetch audited.

## RCA dossier v1

Machine-readable closed schema: `apps/server-pilot/src/hms/rca-dossier.ts`
