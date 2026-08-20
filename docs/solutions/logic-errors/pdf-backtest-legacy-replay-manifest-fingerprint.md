# Legacy PDF Backtest Replay Fingerprint

## Symptom

Patched candidate replay rejected every completed historical run with
`PDF_BACKTEST_REPLAY_SOURCE_SHA256_DRIFT`, before any S3 object was fetched.

## Cause

Early live manifests had no S3 identity at snapshot time and serialized
`SHA-256("")` from a placeholder `bytesBase64: ""`. The actual first-read object
identity and SHA-256 were correctly persisted in the completed terminal record.
Treating the placeholder as a real object hash made replay reject an otherwise
immutable source run.

## Fix

Replay recognizes only the combined legacy signature:

- no non-empty `expectedSourceIdentity`; and
- `sourceFingerprint === SHA-256("")`.

It then uses the completed terminal's source identity and SHA-256 for the
candidate manifest. Any modern non-empty fingerprint mismatch, non-empty
expected-identity mismatch, incomplete terminal, or prior identity-drift
terminal still fails closed.

## Verification

- Fixture regression proves a legacy terminal can replay.
- Existing replay swap test still rejects same-key, same-size byte changes.
- EC2 patched-candidate replay completed `302 / 302` records with zero identity
  drift.
