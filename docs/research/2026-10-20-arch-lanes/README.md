# Architecture research lanes, 2026-10-20 (asks 155–161)

Luna max lanes (codex, read-only, local corpus 2026-07-30..10-13) + Exa agent runs. Opus critique below; final synthesis comes after L1, L2, L6 and the Grok 4.7 xhigh review.

| File | Lane | Status | Opus verdict |
|---|---|---|---|
| [l0-known-facts.md](l0-known-facts.md) | Reuse of existing docs | done 12:28Z | Good. Confirms: human Infor screen order never documented; missing-info questions never studied; architecture never owner-approved |
| [l4-infor-order-dropped.md](l4-infor-order-dropped.md) | Infor order + dropped HMS fields | done 12:30Z | Good. Key: all-room-type rate prefetch helper exists (`hms-availability.ts:102`) but pane never consumes it. Screen order only from our script, not a human |
| [l3-missing-info-rooms.md](l3-missing-info-rooms.md) | Clarifications, room pick, rates | done 12:35Z | Mixed, see C1–C3 |
| [l5-reservationist-workflow.md](l5-reservationist-workflow.md) | Da Vinci interview | done 12:45Z | Honest: interview never showed Infor screens. Infor order still unknown |
| [exa-ultra-memory-frameworks.md](exa-ultra-memory-frameworks.md) | Exa ultra, 2026-dated sources, $6.13, 66 searches | done ~12:45Z | Good; corrects first run (see below) |
| l1 / l2 / l6 | linkage+domains / amend+payment / BM25 precedent baseline | running | — |

## Opus critique

- **C1 (L3 undercount, real).** "Explicit Agency/Company line on 39/1,179 letters" counts only *labelled* lines. Letters print the agency and company as unlabelled lines under the hotel address (owner-pasted example). Quick check: 1,066/1,248 letter texts have non-hotel header lines. Re-count needed (folded into L1 follow-up) before using letters as party truth.
- **C2 (L3 clarification detector weak).** 79/3,151 is regex-only and L3 says so. Family mix (payment/guarantee 42%, dates 15%, dinner 10%) is directional only. Needs an LLM-labelled sample before driving "ask instead of default" rules.
- **C3 (L3 strong signal).** ZAR 1,700 DBB is the most common letter price: 367/1,130 letters (32%). Government asks → 1,700 DBB 19/22 letters. Supports #422 (government DBB) as the highest-volume rate, not an edge case.
- **C4 (rooms).** Extractor "single" → Standard Queen 6/12, Standard Twin 5/12. Staff split evenly → pane must show both with availability, never pick silently. n=12, small.
- **C5 (Infor order still unknown).** Neither docs (L0), code (L4) nor the Da Vinci interview (L5) show a human creating a booking in Infor. Cheapest fix: ask a Centurion reservationist to screen-share one real booking creation in today's client call, or one read-only DOM walk on Labtest.

## Exa ultra vs first run (what changed)

- First run's blanket "memory layer not decisive" was too strong. Precedent retrieval (U1) **is** a memory-framework use case; Zendesk (Aug 2026) and Intercom Fin Memory (Jul–Aug 2026) ship it.
- mem0 caveat updated: OSS benchmark artifacts exist since 2026-04-09 (LongMemEval 91.0%, vendor-run).
- New candidate: **Hindsight 1.0.0** (2026-10-13, MIT, Postgres + pgvector, TS client, no graph DB). Graphiti 0.31.1 needs Neo4j/FalkorDB.
- No 2026 controlled study shows graph memory beating BM25+vector hybrid on email/ticket corpora.
- Recommendation: keep Mastra + Postgres; app-owned case/booking/fact model; A/B **Postgres hybrid vs Hindsight** on ~120 chronological held-out queries; adopt only if ≥10 pt recall@5 gain and zero safety failures.
