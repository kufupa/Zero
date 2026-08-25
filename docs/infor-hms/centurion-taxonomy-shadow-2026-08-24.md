# Connected reservationist-inbox taxonomy shadow — 2026-08-24

```yaml
review_status: needs_review
artifact_kind: analysis-only
runtime_use: none
gold_status: unchanged
snapshot_status: blocked_pending_metadata_scope
```

## Snapshot boundary

This catalog remains analysis-only until an approved local snapshot exists.

Before any data-derived row:

1. Complete a metadata-only read-only gate.
2. Confirm a non-empty, sorted active connected transport scope bound to one
   `asOf` value.
3. Use only the approved local private raw-dump path.

If local private DB access is unavailable, record
`BLOCKED_LOCAL_PRIVATE_DB_ACCESS_UNAVAILABLE`. Do not open mail content, create
fallback scope, or make a snapshot claim.

No catalog row, volume, pairing, classification, residual total, or other
data-derived claim belongs here until that gate passes. This document never
contains raw mail content or transport identifiers.

## Catalog template

Volume unit: inbound triggers within one approved active-transport `asOf`
snapshot. Template stays empty until permitted local review occurs.

| pattern_class | inbound_trigger_volume | triage_category | template_family | required_hms_field_ids | staff_action | hitl_advisory | source |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Controlled vocabularies

Values below are v1 schema choices, not snapshot observations. Do not add
source-specific variants.

### pattern_class

- `system-routine`
- `system-failure-no-sla`
- `system-sla`
- `guest-feedback`
- `mail-security`
- `web-form`
- `human-rfq`
- `confirmation-letter`
- `other`

### triage_category

An existing controlled application slug or `unknown`. Do not invent a new slug
inside this catalog.

### template_family

- `system-file`
- `confirmation-letter`
- `rfq-quote`
- `human-compose`
- `none`
- `unknown`

### required_hms_field_ids

Existing claim kinds only, such as `stay_dates` and `displayed_rate`, or `none`
or `unknown`.

### staff_action

- `file`
- `template-reply`
- `human-compose`
- `none`

### hitl_advisory

- `yes`
- `no`

Use `yes` for `human-compose` and `unknown`.

### source

- `deterministic`
- `local-residual-review`

`inbound_trigger_volume` must be a non-negative whole number.

## Deferred deterministic and residual path

Deferred until approved local scope exists:

1. Apply approved deterministic rules to the sealed active-transport snapshot.
2. Count inbound triggers and pair each only with its first later outbound thread
   item inside that same scope.
3. Keep unmatched items as residual only.
4. Perform any residual review locally; it may add only
   `local-residual-review` rows and cannot rewrite deterministic rows.
5. Keep gold and runtime behavior unchanged until a separately reviewed evidence
   path approves a change.
