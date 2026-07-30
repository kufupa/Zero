# Task 9 Report — Exhaustive production proof and manifest-scoped rollout

Date: 2026-07-30  
Branch: `triage-v5-quality`  
Rejected freeze: `90e02c63` / promptHash `f894a211…`  
Merge HMS⊕v5: `a2b0b858`  
Latest candidate: `8c386224` / promptHash `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d`  
Pushed: yes (branch only)

## Status

**DONE_WITH_CONCERNS** — Task7 recovered (eligible); exhaustive **not** eligible (prot/disagree). Hotel stays triage-v4. Cutover **no**.

## Second-review (model-blind)

| Verdict | IDs |
|---------|-----|
| label wrong (relocked) | `1403c5cc`, `e4d58baf`, `f8eb8e8c` (asOf-drift urg) |
| model wrong | `18829ff1`, `b96fa3be`, `c65b7a3f`, `8dc7666c`, `ccb21b5e` (+ residual flakes) |
| policy_unresolved | **none** |

Audit: EC2 `.tmp/triage-quality/reports/task9-exhaustive/second-review-audit.json`  
Label fixes: **3**

## Candidate reopen (Task7/193 only — no Task9 label tune)

| Candidate | promptHash | Task7 pair | Notes |
|-----------|------------|------------|-------|
| `9cead15e` | `d1283a17…` | prot2 agree0 | over-broad urg rewrite |
| `1a4b1b78` | `e3432d2c…` | prot0 disagree1 | joint 31 fails vs v4 best 30 |
| `4df3d1dd` | `17311310…` | prot2 disagree2 | surgical tickets; cat21/urg8/joint28 |
| **`8c386224`** | **`5b0be70c…`** | **eligible** | restore green urg; category-only OTA/TAC/POP; pair `task7-v5-1`+`task7-v5-3` after Nova agree-restore |

Task7 selected: cat19/urg5/joint24/prot0/disagree0 vs v4 best 23/13/30.

## Exhaustive after candidate `8c386224` (locked 234; reuse v4×2)

eligible=false · prot2 · disagree4 · dominance pass (v5 worst 24/14/37 vs v4 best 32/15/42).  
Prot: `18829ff1`, `d9ff71f4` (do **not** open into prompt tune).  
Disagree: `2674962f`, `42f91149`, `7b6ea082`, `fdc8f690`.  
Artifacts: EC2 `.tmp/triage-quality/reports/task9-exhaustive/paired-exhaustive.json`

## Cutover

**NOT STARTED.** Live hotel triage-v4.

## Next

1. Further Task7-safe candidate that clears exhaustive prot0+agree (no Task9 ID tickets)
2. Exhaustive eligible → cutover preflight→quiesced deploy→retag→audit
3. Else keep hotel on v4

## Residual

Nova non-determinism (agree-restore needed on Task7; exhaustive disagree4); Multi-AZ off; S3 30/90; wiped instance retained.
