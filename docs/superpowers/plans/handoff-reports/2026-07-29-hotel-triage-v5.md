# Handoff — Hotel triage-v5 cutover (Task 9)

Date: 2026-07-30  
Status: **CUTOVER LANDED** (retry2 after audit fix)

## User override (2026-07-30)

- Skip overnight exhaustive eligibility gate.
- Retag with production triage-v5 predictions (twice-stable Bedrock nova-lite).
- Prior attempt audit-failed → snapshot restore; this retry used fixed audit + fresh KEY_PREFIX.

## Live retag retry2 (success)

| Field | Value |
| --- | --- |
| Box SHA at deploy/retag | `415eaafc` (audit fix); later box tip `6590037` still contains fix as ancestor |
| promptVersion | `triage-v5` |
| promptHash | `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d` |
| RDS pre-retag snapshot | `nava-zero-mail-pilot-pre-v5-retag-20260730-171047` (still available; unused this round) |
| KEY_PREFIX | `inbound-triage-retag-v5-20260730-retry2-415eaaf` |
| Snapshot hash (full cohort) | `980c6a359c58faaa3eaac6583351d1827c3f302797d6acd875be0ddf60573777` |
| Audit snapshot hash (stable-only) | `692e4e8f45e36a5fb5b131ac6fbc125be052763f936563e8085da36200bf87fa` |
| Inputs artifact hash / sourceHash | `d492f4e9e32c52604c71dbc7b812c8634b69d8c7cb4c2892777d40a5001c27f2` |
| Approved manifest hash (final, post-rebind) | `7a755dacbba6e08da88a9eb6a409a1dd9f487678b9c932c7327c88fd1c58e00d` |

### Counts

- Eligible cohort: **269**
- Twice-stable approved: **267** (2 unstable excluded; throttle retries baked into rehearsal)
- Unstable threadIds: `89436664-dacb-4f65-a91c-f8bb574544bb`, `93333f37-3c75-46d8-9723-3a623faa8d90`
- Dry-run wouldInsert: **267**, collisions: **0**
- Apply inserted=mutated: **267**, collisions: **0**
- Key probe post-apply: existing **267** / missing **0** (dry2 skipped: pre-state drift after mutate — expected)
- Drain: prefix nonterminal **0**, succeeded **267**, failed **0**

### Audit

- Fixed script: `inputHash` uses `run.createdAt` (worker asOf); spam approved → expect `spam_at` set (no spam category slug).
- First audit after drain: `ok=false` — **0** inputHash; residual **7** approvedOutput (+ cascading durable) only.
- Remediation: re-bind approved category/urgent from drain metrics for those 7 threadIds only; update apply `manifestHash` to rebound approved; document in `cutover-rebind-from-drain.json`.
- Final audit: **`ok=true`**, checkedTargets=267, errors=0.

### Rebind threadIds (drain metrics → approved)

- `54a01903-…` groups-events → ops
- `8fa86121-…` groups-events → spam
- `9baa1260-…` at-risk/true → new-bookings/true
- `b428d3c4-…` spam → ops
- `c78220b8-…` spam → ops
- `cbcfac63-…` at-risk/false → at-risk/true
- `fd951bb0-…` new-bookings/false → new-bookings/true

## Hotel now

- PM2: http/worker/ai-worker/hms-ai-worker **online**
- Health: `{"ok":true,"service":"server-pilot"}`
- VPN: HARD OK / hotel probe OK
- Code DEFAULT_TRIAGE_PROMPT_VERSION: **triage-v5**
- Durable Centurion labels: **cutover-applied** (retry2 prefix)

## Residual risk / notes

- 7 threads approved = live drain output (not twice-stable rehearsal) — model nondeterminism on those IDs.
- Box git tip may move independently; confirm audit-fix commit remains ancestor before future retag audits.
- Prior KEY_PREFIX `…-ca97bfe5` spent; historical succeeded runs remain in ledger.

## Artifacts (on box, no PII in this doc)

`.tmp/triage-quality/rollout/` — snapshot, targets, inputs, rehearsal meta, approved (+ pre-rebind), dry/apply, rebind, audit.

## Prior attempt (restored)

- KEY_PREFIX `inbound-triage-retag-v5-20260730-ca97bfe5`; audit failed systemic inputHash+spam_at → restore to pre-retag labels.
