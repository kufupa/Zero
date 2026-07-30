# Handoff — Hotel triage-v5 cutover (Task 9)

Date: 2026-07-30  
Status: **DONE_WITH_CONCERNS** (Task7 recovered on `8c386224`; exhaustive still ineligible; cutover withheld)

## SHAs / hashes

- Rejected freeze: `90e02c63` · `f894a211…`
- HMS⊕v5 merge: `a2b0b858`
- Latest candidate: `8c386224` · `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d`
- Live prod: triage-v4 (`/home/ubuntu/repos/zero`)

## Second-review

- Label fixes: **3** (`1403c5cc`, `e4d58baf`, `f8eb8e8c`)
- Model wrong remain (do not open into prompt tune from Task9 IDs): see task-9-report
- Policy unresolved: none

## Task7 reprove (latest)

- eligible=true · prot0 · disagree0 · worst cat19/urg5/joint24 vs v4 best 23/13/30
- Selected pair: `task7-v5-1` + `task7-v5-3` (agree-restore; same promptHash)
- Artifacts: EC2 `.tmp/triage-quality/reports/task7-reprove/`

## Exhaustive (candidate `5b0be70c…`, locked 234)

- eligible=false · prot2 · disagree4 · dominance would pass (24/14/37 vs 32/15/42)
- Prot IDs: `18829ff1`, `d9ff71f4`

## Cutover

**No.** Hotel on v4 until exhaustive eligible=true.

## Next

Continue Task7-safe candidate until exhaustive prot0+agree+dominance, then cutover preflight.
