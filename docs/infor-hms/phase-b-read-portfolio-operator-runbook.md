# Phase B HMS read portfolio operator runbook

Status: kernel stub + Task 10 portfolio grammar. Phase B tool actions
(`read-discovery|read-proof|read-promote|read-rollback`) run fail-closed
evidence preflight before any AWS/HMS. Missing role-proof-v2 / reviewed
request manifest / fixture-only registry state emit **named** `HMS_WAIT`
codes. `PHASE_B_BLOCKED` only after evidence passes but live browser action
still unwired. Do not invent live proofs.

## Capability reality (Task 10)

| Tool | State | Production active-read |
|------|-------|------------------------|
| `hms_find_reservation` | live_verified (prior) | yes |
| `mail_read_artifact` | artifact chain / not live allowlisted | no |
| `hms_quote_stay` … `hms_event_read` | fixture_verified | no |

Full portfolio promotion is **blocked** pending role-proof-v2 + discovery for
fixture-only tools. User may accept named blockers and revised scope.

Cumulative ablation / load-capacity replay runs against **currently promoted
releases only** (`hms_find_reservation`). Never gate portfolio pass on
company/group/event/folio/quote live promotion.

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
bash apps/server-pilot/deploy/ops-hms-proof.sh doctor
bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only --tool hms_find_reservation
bash apps/server-pilot/deploy/ops-hms-proof.sh read-discovery hms_find_reservation
bash apps/server-pilot/deploy/ops-hms-proof.sh read-proof hms_find_reservation
bash apps/server-pilot/deploy/ops-hms-proof.sh artifacts hms_find_reservation --latest
bash apps/server-pilot/deploy/ops-hms-proof.sh read-promote hms_find_reservation
bash apps/server-pilot/deploy/ops-hms-proof.sh status --tool hms_find_reservation
bash apps/server-pilot/deploy/ops-hms-proof.sh read-rollback hms_find_reservation
```

Linux Bash on EC2 uses same commands from release worktree. Never source
`.env.production` into shell running Vitest. Before every test command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

## Phase B operator grammar (stubs)

Public contract (help/grammar perform no AWS call; unknown IDs exit `2`):

```text
ops-hms-proof.sh --help
ops-hms-proof.sh doctor [--json]
ops-hms-proof.sh status [--tool <tool-id>|--wave <subwave-id>] [--json]
ops-hms-proof.sh read-discovery <tool-id> [--json]
ops-hms-proof.sh read-proof <tool-id> [--json]
ops-hms-proof.sh read-wave <subwave-id> [--resume] [--json]
ops-hms-proof.sh artifacts <tool-id> [--latest] [--json]
ops-hms-proof.sh fetch-artifact <uuid> <receipt|video>
ops-hms-proof.sh fetch-artifact <uuid> trace --confirm-sensitive
ops-hms-proof.sh read-promote <tool-id> [--json]
ops-hms-proof.sh read-rollback <tool-id> [--json]
ops-hms-proof.sh rearm
```

Preflight env (never auto-created):

- `HMS_READ_ROLE_PROOF_V2_PATH` — file must parse `hmsReadRoleProofV2Schema`
- `HMS_REVIEWED_REQUEST_MANIFEST_PATH` — file must parse `requestPolicyManifestSchema`

Named wait codes (exit `3`, no Chromium/HMS):

| Code | Meaning |
|------|---------|
| `BLOCKED_NO_ROLE_PROOF_V2` | path absent, symlink, invalid, or expired |
| `BLOCKED_NO_REVIEWED_REQUEST_MANIFEST` | path absent/invalid after role-proof ok |
| `BLOCKED_TOOL_FIXTURE_ONLY` | registry `fixture_verified` (no discovery digest) |
| `PHASE_B_BLOCKED` | evidence ok; live discovery/proof CLI still unimplemented |

`doctor|read-wave|artifacts|rearm` stay `PHASE_B_BLOCKED` stubs.
`status` is offline registry-only: exits `0` with `HMS_OK code=STATUS_OK` and
emits capability rows (`capabilityState`, promotion flags, digest presence).
No AWS/HMS. Filter with `--tool` / `--wave` (`B0`–`B6`); unknown wave exits `2`.
Waves `B0`–`B6` are grammar-valid IDs only.

Closed `CandidateReadPlan`: one branch; reservation followups max two unique;
no model-driven tool loops. Model selects whole claim IDs only (including
optional `workflow_summary`).

## RCA dossier v1

Machine-readable closed schema: `apps/server-pilot/src/hms/rca-dossier.ts`
(`rcaDossierV1Schema`, optional `loadRcaDossier(toolId)`). Stub JSON lives under
`apps/server-pilot/evals/hms/rca-dossiers/<toolId>.json` for each empirical-loop
tool. Schema is `.strict()` — no PII fields, no free-form private-looking keys.
`unresolvedGaps` holds named `BLOCKED_*` codes only. Digests are sha256 hex;
`liveArtifactIds` are UUIDs only.

Each tool dossier is private-value-free Markdown plus machine-readable digest refs:

1. Tool ID/version and sanitized symptom.
2. Real structural observation: route class, envelope discriminator, key-only fingerprint.
3. Assumptions verified and invalidated.
4. Causal chain from trigger to invalid transition to symptom.
5. Falsifiable prediction.
6. Failing regression test and RED command/result.
7. Minimal fix and GREEN command/result.
8. Verification commands and PII-free outcomes.
9. Live artifact IDs/digests and expiry.
10. Unresolved gaps/blockers.
11. Native-request differential: ordered multimap digest comparison for method, path/query,
    key order/multiplicity, encoding, content type, required header/token digests, session
    binding, operators/joiners, request count, and trigger sequence.
12. `NegativeResultCertificateV1` digest refs for all eight gates. Never record free-form
    pass booleans or classify `BUSINESS_NOT_FOUND` before independent validation.

Raw SSM commands belong in restricted debug appendix, not operator terminal records.
