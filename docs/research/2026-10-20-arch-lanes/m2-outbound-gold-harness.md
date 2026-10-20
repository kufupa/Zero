## Answer

| Piece | What it does | Path | Reusable for |
|---|---|---|---|
| Input capture | Loads synced selection with attachment text; current triage export disables vision. Fresh extractor calls extraction, not the pane agent. | [export.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/export.ts:119), [golden-fresh-extract.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/golden-fresh-extract.ts:284) | Inbound extraction replay; **not** exact pane-input parity. |
| Pane prompt | `selectionToAgentPrompt` builds trigger, prior context, and attachment text. | [agent-pane-adapter.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/src/ai/agent-pane-adapter.ts:151) | Correct target for same-input replay. |
| Action eval | Frozen test has 431/431 predictions; labels mostly silver. Evaluation varied action-classification rules, not the whole extraction prompt. | [triage eval](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:15) | Action regression check, with label/parity limits. |
| Outbound linker | Links replies, HRCEN letters, Quote PDFs, and Proforma markers by thread/recipient/time plus guest/date signals. | [L1 appendix](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:20) | Pair inbound ask to outbound truth; **not** a field parser. |
| Quote outcome | Joins prepared and staff-final work events; scores dates, occupancy, party, contact, and room-line totals—not nightly rate grids. | [quote-outcome-eval.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/quote-outcome-eval.ts:87), [quote-outcomes.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/src/ai/quote-outcomes.ts:96) | Existing field-comparison base; not raw outbound-PDF grading. |
| Backtests + labels | Reservationist scorer has field-level checks; owner-label sheet has 40/40 rows but 0/40 filled owner cells. | [reservationist-backtest.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/src/ai/reservationist-backtest.ts:90), [owner sheet](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-chat-d-owner-label-sheet.md:3) | Generic scorer only; sheet is not 40 gold labels. |

**Verdict:** Pieces exist; full outbound-gold harness does not. No component yet replays exact pane input, pairs all outbound artifacts, parses them into Nava’s field shape, and scores each field. [R4 test plan](/tmp/opus-run-1020/research/r4-test-plan.md:45)

## Method

Local docs and corpus only; no network, inference, production, HMS, or git calls. Historical counts retain their source windows and reproducers; L1’s Python counter is embedded in its appendix. [common.md](/tmp/opus-run-1020/research/common.md:18) [L1 script](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:230)

## Outbound schema

Nava’s current quote shape already has dates, room quantity/type, board, party, rate, nights, and totals. It lacks guest, confirmation number, bill-to, deposit, and per-night/date price grid. [quote-outcomes.ts](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/src/ai/quote-outcomes.ts:10)

| Fields | What local evidence supports today |
|---|---|
| `action` | Reply regex flags only: booking-status 45/95 and any future-document signal 40/95 first replies; full corpus 2026-07-30–10-13. Not semantic labels. [L1 findings](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:69) |
| `guest`, `conf#` | HRCEN email subject guest parse: 1,127/1,180; filename 8-digit token: 1,174/1,180; distinct IDs: 655/1,180. Full corpus 2026-07-30–10-13; L1 Appendix parser. [L1 inventory](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:23) |
| `arrival`, `departure` | HRCEN PDF arrival parsed: 1,179/1,180; full corpus 2026-07-30–10-13. Departure parse coverage: not found. [L1 inventory](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:23) |
| `room types + counts`, `board` | HRCEN/Quote PDFs contain tables, but parser coverage not measured. In 200/200 sampled HRCEN letters since 2026-09-09, 123/200 had B&B table variant and 56/200 DBB variant; this is sample content, not parser coverage. [lifecycle evidence](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-stay-request-lifecycle-evidence.md:25) |
| `rate plan`, `nightly price` | Quote backtest compared plan class/board/room on 8/8 individual future-stay threads; exact price matched 2/8. Last 45 days as of 2026-10-20. Not a nightly-grid score; parser coverage not measured. [_backtest-reprice_ report](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-quote-backtest-pool.md:37) |
| `bill-to party`, `deposit` | Bill-to parse/coverage: not found. HRCEN PDF profile line exists, but its bill-to meaning is unverified (inference). Deposit printed as zero in 200/200 sampled letters since 2026-09-09; 0/200 showed deposit above zero. Letter deposit does **not** establish paid/unpaid state. [L1](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:221) [lifecycle evidence](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-stay-request-lifecycle-evidence.md:33) |

## Feature comparisons

| Build feature | Compare / truth | Available n |
|---|---|---|
| Multi-ask cards | Each input ask/card vs staff reply and linked letter/Quote artifact. | 17/164 core threads had multiple asks; 9/164 had multiple linked guest/date letter cases, with separate conf IDs in 9/9. Corpus 2026-07-30–10-13; L1 Python. [L1](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:187) |
| BAR grid price | Per-night date + plan + board + room/occupancy + price vs staff PDF/reply. | 8/8 priced future-stay threads; 5/8 plan/board/room matches, 2/8 exact price. Last 45 days as of 2026-10-20; `_backtest-reprice-20261020.ts`. [Pool](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-quote-backtest-pool.md:44) |
| Party rank | Candidate rank vs party staff used in outbound artifact. | Outbound rank comparisons: 0/0 scored. Separate 194/194-row HMS party answer key exists, but is not staff-outbound rank truth. [R4](/tmp/opus-run-1020/research/r4-test-plan.md:39) |
| CHECK link | Found/ambiguous/not-found stay identity vs reply and read-only HMS evidence. | 3/3 behavior states proposed; not a scored outbound set. [R4](/tmp/opus-run-1020/research/r4-test-plan.md:77) |
| Unpaid amend | Same stay identity + payment state vs staff-verified before/after and HMS status. | Outbound gold pairs: 0/0 found. Two Labtest controls proposed, not run; letter deposit cannot supply payment truth. [R4](/tmp/opus-run-1020/research/r4-test-plan.md:78) |
| Action after extraction-prompt change | Fresh action vs linked staff reply/letter/Quote truth; hold vision and inputs constant. | Frozen v4: 431/431 predictions, 8/8 owner labels overlap overall (6/8 agree with silver); not a full extraction-prompt change. Later Aug–Sep holdout: 436/477 silver labels, but no score due missing vision; parity-clean subset had 7/359 quote labels. [eval](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:19) [safety gate](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-chat-d-triage-gepa-safety-gate.md:37) |

## Minimal harness

- New `scripts/outbound-gold-backtest.ts`: freeze input/artifact links, replay exact pane prompt, write masked field diffs; new `src/ai/outbound-gold-features.ts`: normalize reply/HRCEN/Quote fields; fixture tests for cross-thread ties and missing fields. **~200–300 LOC (inference)**; plan already estimates 60–100 LOC for nightly-grid capture/scoring plus 40–60 LOC for multi-ask comparison. [R4 plan](/tmp/opus-run-1020/research/r4-test-plan.md:72)
- Offline link/parse tests can use local corpus. Run production-path inference on Product EC2 with `readQuoteAttachments` → `selectionToAgentPrompt`, vision parity enabled as prod requires; read-only only. [export location](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/export.ts:11) [run rule](/tmp/opus-run-1020/research/r4-test-plan.md:49)
- HRCEN linkage is partial: ±30m after first reply linked a letter for 39/103 core asks and a hand Quote PDF for 14/103; full corpus 2026-07-30–10-13. [L1](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:50)

## Open gaps

- No semantic outbound parser or exact nightly grid scorer; quote pool remains 8/8 vs proposed 10/10 bar. [pool](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-20-quote-backtest-pool.md:63) [R4](/tmp/opus-run-1020/research/r4-test-plan.md:72)
- Owner sheet’s message window is not stated; its 40 rows are blank owner-label slots, not validated gold. [sheet](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-chat-d-owner-label-sheet.md:3)

## Appendix: counting script

L1’s corpus counts use its embedded Python appendix above. This snippet counts owner-label cells; prints no row IDs or mail content.

```python
from pathlib import Path
p = Path("/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-chat-d-owner-label-sheet.md")
rows = []
for line in p.read_text().splitlines():
    if line.startswith("| ") and not line.startswith(("|---", "| Row ID")):
        c = [x.strip() for x in line.strip("|").split("|")]
        if len(c) >= 5:
            rows.append(c)
print(f"owner_labels={sum(bool(r[4]) for r in rows)}/{len(rows)}")
```