# 2 Corpus

Checks: `corpus.demand`, `corpus.key.min` (stop condition)

Inputs:
- Demand: `.private/cli-coverage/COVERAGE.md` + `.private/cli-coverage/extracts/*.jsonl` (`gaps[]` per inbound: tool, field, kind, evidence).
- Mail + PDFs: `.private/centurion-corpus/`, `.private/connected-mailbox-corpus/`, `.private/connected-mailbox-corpus-pdf/`, `.private/cli-coverage/pdfs/`.
- Mail → stay join: `apps/server-pilot/scripts/hms-connected-case-from-corpus.mjs` (confirmation / external ref, or surname + both dates), `apps/server-pilot/scripts/gold-fact-live-collect.mjs` (`confirmation_candidates`).

Method:
1. Demand = inbound guest/agent mail only. Staff replies are answer keys, never demand.
2. Pick cases whose mail needs this tool. Join each to a real stay.
3. Answer key: Astra xhigh opens each joined stay **read-only**, dumps the tool-relevant keys (shape: `ReservationDetailDumpV1`, `searchExactThenDetailDump` in `apps/server-pilot/src/hms/live-guest-stay-driver.ts`). No Save. Close.
4. Split keyed cases: ~1/3 `tune`, rest `test`. Rerun test freely; never edit prompts/code to one test case.

Output `02-corpus.json`:

```json
{
  "demand": { "inboundOnly": true, "total": 195, "byField": { "organization": 118 } },
  "cases": [
    { "id": "<message id>", "split": "tune", "stayRef": "<confirmation>", "answerKey": { "company": "<native id>" } }
  ]
}
```

- `answerKey: null` = joined but nothing linked (still useful for `no_match`).
- Fewer than `minKeyed` keyed → hook stops; user decides.
