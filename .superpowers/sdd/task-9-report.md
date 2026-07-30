# Task 9 Report — Exhaustive production proof and manifest-scoped rollout

Date: 2026-07-30  
Branch: `triage-v5-quality`  
Rejected freeze: `90e02c63` / promptHash `f894a211…`  
Merge HMS⊕v5: `a2b0b858`  
Release candidate (prompt blob): `8c386224` / promptHash `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d`  
Docs HEAD: `693638e7` (restores `8c386224` prompt after aborted `88eebd2c`/`9bfb83cc`)  
Pushed: yes (branch only)

## Status

**BLOCKED** — Task7 still eligible on restored `8c386224`/`5b0be70c…`. Exhaustive **not** eligible after agree-restore + label relocks. Hotel stays triage-v4. Cutover **no**.

## Aborted candidates (prompt surgery cap)

| SHA | promptHash | Why aborted |
|-----|------------|-------------|
| `88eebd2c` | `708d95b4…` | Task7 eligible briefly; exhaustive urg worse than v4 best + disagree |
| `9bfb83cc` | `7e838663…` | Task7 run1 **prot1** regression — stopped; no further prompt iteration |

Restored prompt files from `8c386224` in `693638e7` (blob match proven on EC2).

## Second-review (model-blind)

| Verdict | IDs |
|---------|-----|
| label wrong (relocked) | `1403c5cc`, `e4d58baf`, `f8eb8e8c` (earlier); **`d9ff71f4`**, **`c45892cd`** (asOf-drift urg); **`42f91149`**, **`fdc8f690`** (TAC→ops) |
| model wrong | `18829ff1` (sticky; do not retune), `e820fc45`, TAC/groups flakes (`7b6ea082`, `2674962f`, …) |
| policy_unresolved | **none** |

Audit: EC2 `.tmp/triage-quality/reports/task9-exhaustive/second-review-final-audit.json`  
Label fixes this session: **4** (asOf-drift×2 + TAC×2)

## Task7 (restored green)

eligible=true · cat19/urg5/joint24/prot0/disagree0 · pair `task7-v5-1`+`task7-v5-3` (prior agree-restore on `5b0be70c…`)  
Artifacts: EC2 `.tmp/triage-quality/reports/task7-reprove/` (pre-abort archive retained)

## Exhaustive after restore (`5b0be70c…`, locked 234; reuse v4×2 rescored)

eligible=false · best partial after agree-restore (v5-exh-1+3): prot3 · disagree1 · worst 26/14/39 vs v4 best 34/13/42.  
Fail reasons: protected regressions; urgentErrors worse than v4 best (14>13); residual disagree.  
Sticky prot includes `18829ff1` (model_wrong). TAC/`e820fc45` spam flakes → prot when labels ops.  
Artifacts: EC2 `.tmp/triage-quality/reports/task9-exhaustive/`

## Cutover

**NOT STARTED.** Live hotel triage-v4.

## Residual / next

1. Do **not** retune prompt on Task9 IDs; surgery cap hit this session  
2. Exhaustive eligible requires clearing sticky `18829ff1` without Task7 regress (future general rule only) + Nova agree + urg≤v4 best  
3. Else keep hotel on v4  

Nova non-determinism; Multi-AZ off; S3 30/90; wiped instance retained.
