# Handoff — Hotel triage-v5 cutover (Task 9)

Date: 2026-07-30  
Status: **BLOCKED** (Task7 green on restored `8c386224`; exhaustive ineligible; cutover withheld)

## SHAs / hashes

- Rejected freeze: `90e02c63` · `f894a211…`
- HMS⊕v5 merge: `a2b0b858`
- Release candidate prompt blob: `8c386224` · `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d`
- Branch HEAD: `693638e7` (restore after aborted `88eebd2c`/`9bfb83cc`)
- Live prod: triage-v4 (`/home/ubuntu/repos/zero`)

## Second-review

- Label fixes this session: **4** (`d9ff71f4`, `c45892cd` asOf-drift; `42f91149`, `fdc8f690` TAC→ops)
- Earlier fixes: 3 (`1403c5cc`, `e4d58baf`, `f8eb8e8c`)
- Model wrong sticky: `18829ff1` (do not open into prompt)
- Policy unresolved: none

## Task7

- eligible=true on `5b0be70c…` · prot0 · disagree0 · worst cat19/urg5/joint24 vs v4 best 23/13/30
- Aborted later agency-invoice commits after Task7 prot regression

## Exhaustive (`5b0be70c…`, locked 234)

- eligible=false · best partial prot3 disagree1 · worst 26/14/39 vs v4 best 34/13/42
- Fail: prot (incl. sticky `18829ff1`) + urg 14>13 + residual disagree

## Cutover

**No.** Hotel on v4 until exhaustive eligible=true.

## Next

Keep `8c386224`/`5b0be70c…` as candidate. Clear exhaustive without Task9-ID prompt tickets; else stay on v4.
