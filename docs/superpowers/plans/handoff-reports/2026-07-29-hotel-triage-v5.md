# Handoff — Hotel triage-v5 cutover (Task 9)

Date: 2026-07-30  
Status: **DONE_WITH_CONCERNS** (freeze rejected; labels relocked; new candidate not yet Task7-green; cutover withheld)

## SHAs / hashes

- Rejected freeze: `90e02c63` · `f894a211…`
- HMS⊕v5 merge: `a2b0b858`
- Latest candidate: `4df3d1dd` · `17311310b54f1505d45da32dde33ab8c30f393f522d7488af4982b4e9ef3472a`
- Live prod: triage-v4 (`/home/ubuntu/repos/zero`)

## Second-review

- Label fixes: **3** (`1403c5cc`, `e4d58baf`, `f8eb8e8c`)
- Model wrong remain (do not open into prompt tune from Task9 IDs): see task-9-report
- Policy unresolved: none

## Task7 reprove (latest)

- eligible=false · prot2 · disagree2 · metrics cat21/urg8/joint28
- Artifacts: EC2 `.tmp/triage-quality/reports/task7-reprove/`

## Exhaustive (rejected hash, post-relock rescore)

- eligible=false · prot3 · disagree3 · dominance would pass

## Cutover

**No.** Hotel on v4 until exhaustive eligible=true.

## Next

Continue Task7-only candidate until prot0+agree+dominance, then exhaustive read-only, then cutover preflight.
