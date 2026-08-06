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

| Tool | State | Production active-read |
|------|-------|------------------------|
| `hms_find_reservation` | live_verified (prior) | yes |
| `mail_read_artifact` | artifact chain / not live allowlisted | no |
| `hms_quote_stay` … `hms_event_read` | fixture_verified | no |

Full portfolio promotion is **blocked** pending role-proof-v2 + discovery for
fixture-only tools (Task 13+). User may accept named blockers and revised scope.

```bash
cd "/c/Users/gamin/Desktop/projs/emails hotels uis/zero/apps/server-pilot"
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
npm run eval:hms-portfolio-ablation
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
