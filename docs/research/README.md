# Research index

Read conclusions and the evidence for the current decision, not every archive. `docs/context/ACTIVE.md` holds living state; `PRODUCT.md` holds owner requirements. This index is a navigation map, not fresh production proof.

| Report                                                                      | Use for                                                                                                               | Evidence status                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [2026-10-20 overnight quote-run retro](2026-10-20-overnight-quote-retro.md) | Overnight quote score, queue/lab gates, ETA closeout, verified misses and next-run rules | 5/8 on class+board+room; minimum n=10 not met; load does not prove staff use |
| [2026-10-20 quote planning evidence](2026-10-20-quote-plan-evidence.md) | Current quote-ready seams, Opus critique, conditional ETA basis and safe cleanup | Planning only; automatic PDF gap confirmed, delivery not promised |
| [2026-10-19 party strategy decision](2026-10-19-party-strategy-decision.md) | Hybrid party lookup (history → v3 search → staff pick); big-set score 109/150 agencies, 0 wrong; live replays §5d; owner calls D1–D4 | Live at `78c29b5ae`; evening retro: [ledger](../context/ledger/2026-10-19-evening-retro.md) |
| [2026-10-19 party bind eval](2026-10-19-party-eval-72h.md) | Prod party auto-bind vs R7 55/95; 121-job sender-domain split; miss buckets B1–B4 | Offline rerun `37ebf68d4` = 38/95 fallback; prod party-bearing auto-bind 4/18; confirmation-PDF route closed (R2 30/1,179) |
| [2026-10-19 HMS queue wait diagnosis](2026-10-19-hms-queue-wait-diagnosis.md) | Party wait 411 s = overnight backfill burst; prepared-quote dead letters = CDP attach under burst; party run time ~75% repeat login/nav | Read-only prod SQL + EC2 evidence timestamps, 2026-10-19 |
| [2026-10-19 ready-before-open scoreboard](2026-10-19-ready-before-open.md) | First recorded pane-open HMS readiness by action; ranked non-ready reasons; limited observed completion waits | Read-only production aggregates, snapshot 15:33Z; quote counts persisted receipts, not full pane usability; action-at-open labels missing on 73/78 rows; no recorded post-15:00Z rollout sample |
| [2026-10-19 leak-free triage eval](2026-10-19-leak-free-triage-eval.md) | Classifier accuracy on frozen silver test, leak size, rule changes v1–v4, Da Vinci transfer, owner decisions | Frozen 431-row test; text-only (no vision); silver labels, 8 owner rows |
| [2026-10-19 Chat D triage holdout status](2026-10-19-chat-d-triage-gepa-safety-gate.md) | Aug–Sep D0/D3 progress, unresolved quote-reply linkage, D5 parity hold | 1,374 silver labels at $9.74 API spend; D5 not run because vision input is missing, no production score |
| [2026-10-19 Exa MCP and Dynamic Highlights audit](2026-10-19-exa-mcp-dynamic-highlights-audit.md) | Four local Exa MCP registrations, API-key source equality, Dynamic Highlights support, upstream package version | Read-only local CLI/config audit and official Exa/client docs; no client config changes |
| [2026-10-14 product/delivery assessment](2026-10-14-product-assessment.md)  | Full product, owner/agent retro, routing seams, priorities, testing, conditional budgets and model/session discipline | Decisive code claims checked at deployed `15e5bb63b`; runtime dated 2026-10-14; incomplete readiness explicit |
| [2026-10-14 source index](2026-10-14/README.md)                             | Exact source/version/locator, method, contradiction and refresh trigger                                               | Reuse these locators before broad exploration                                                                 |
| [2026-10-14 sanitized runtime evidence](2026-10-14/evidence.json)           | Health, startup flags and delivered assets observed during assessment                                                 | Historical snapshot, no guest data, not current authorization                                                 |
| [2026-10-13 corpus/research library](2026-10-13/README.md)                  | Staff outbound/PDF conventions, workflow mix, party truth, earlier architecture and UI requests                       | Private corpus snapshot; old code/usage/quality claims can be superseded                                      |
| [2026-10-14 session-entry snapshot](../context/SESSION-ENTRY-2026-10-14.md) | Reconstruct what this assessment knew                                                                                 | Historical; current sessions begin with ACTIVE.md                                                             |

## Bounded startup

- Batch-read mandatory rules and current context. Check revision and relevant deltas.
- Use the source index to open the smallest relevant file/section. Prefer current code and safe runtime evidence over a dated summary.
- Reuse settled product decisions and prior research. A new session is not a reason to re-audit every transcript or corpus.
- Investigate a gap only when it changes the action, when evidence contradicts itself, or when the owner asks for new research.
- Do not treat an absent search match as proof of absent behavior. Trace the actual reader/writer and preserve counterevidence.
- Keep private mail, PDFs, guest identities, raw model responses, credentials and full transcripts outside git. Commit conclusions, provenance and sanitized observations.
- Refresh price/inventory facts, runtime state and current adoption when needed. Historical scores do not certify live readiness.
- Add a dated report and source-index row when findings materially change. Update ACTIVE.md for living state rather than growing an all-purpose root context file.
