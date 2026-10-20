# Architecture research lanes, 2026-10-20 (asks 155–161)

Luna max lanes (codex, read-only, local corpus 2026-07-30..10-13) + Exa agent runs. Opus critique below; final synthesis comes after L1, L2, L6 and the Grok 4.7 xhigh review.

| File | Lane | Status | Opus verdict |
|---|---|---|---|
| [l0-known-facts.md](l0-known-facts.md) | Reuse of existing docs | done 12:28Z | Good. Confirms: human Infor screen order never documented; missing-info questions never studied; architecture never owner-approved |
| [l4-infor-order-dropped.md](l4-infor-order-dropped.md) | Infor order + dropped HMS fields | done 12:30Z | Good. Key: all-room-type rate prefetch helper exists (`hms-availability.ts:102`) but pane never consumes it. Screen order only from our script, not a human |
| [l3-missing-info-rooms.md](l3-missing-info-rooms.md) | Clarifications, room pick, rates | done 12:35Z | Mixed, see C1–C3 |
| [l5-reservationist-workflow.md](l5-reservationist-workflow.md) | Da Vinci interview | done 12:45Z | Honest: interview never showed Infor screens. Infor order still unknown |
| [exa-ultra-memory-frameworks.md](exa-ultra-memory-frameworks.md) | Exa ultra, 2026-dated sources, $6.13, 66 searches | done ~12:45Z | Good; corrects first run (see below) |
| [l1-linkage-domains.md](l1-linkage-domains.md) | Ask → reply → HMS letter linkage, top-30 sender domains | done 13:47Z | Good, see C6–C7 |
| [l2-amend-payment.md](l2-amend-payment.md) | Amend / cancel / payment state | done 13:01Z | Good, see C8–C9 |
| [l6-precedent-baseline.md](l6-precedent-baseline.md) | BM25 precedent-retrieval baseline | done 12:55Z | Good, changes the memory A/B metric, see C10 |

## Opus critique

- **C1 (L3 undercount, real).** "Explicit Agency/Company line on 39/1,179 letters" counts only *labelled* lines. Letters print the agency and company as unlabelled lines under the hotel address (owner-pasted example). Quick check: 1,066/1,248 letter texts have non-hotel header lines. Re-count needed (folded into L1 follow-up) before using letters as party truth.
  - **Resolved by Opus recount (13:55Z, local corpus):** 1,001/1,174 HRCEN letters carry an unlabelled party line between the hotel block and "Dear …"; the only labelled line is "VAT number" (1,128/1,174). The party line never shares a word with the Dear (guest) line (0/1,001). Words in it: travel 374, ltd 176, pty 158, department 86, municipality 78. So the letter prints the bill-to party (agency or company) on ~85% of letters. Usable as party truth per booking; L3's 39/1,179 is withdrawn.
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

## Opus critique of L1, L2, L6 (13:55Z)

- **C6 (L1, linkage).** Core external non-OTA quote/booking asks: 189. Staff reply found for 103/189; an HMS letter within ±30 min of that reply for 39/103 (38%), +3 days 31/88. Manual check 30/30 links correct (precision only). The other 78/189 asks have no reply anchor in this mailbox, so they were answered elsewhere (phone, another mailbox) or not at all. Earlier prod-SQL figure (53/92 within ±30 min) used a different cohort; both say the letter is the usual next artefact, not the universal one.
- **C7 (L1, domains → default party).** Mixed for big domains: gmail 34 profile variants / 108 letters, Nexustravel 5/35 (top 12/35), Atlantis Corporate 5/37 (top 27/37). Small agencies are consistent (sa.kobo-safaris 7/7, letscruize 5/5). **Domain = ranked suggestion, never a silent default.** Multi-guest threads: 9/164, each guest/date always got its own confirmation (9/9) → one stay card per guest/date.
- **C8 (L2, amend = edit in place).** Of 74 amend asks with a usable prior letter, 14 got a later letter with the **same** confirmation number, **0** with a new one, 60 no letter in 3 days. Answers the owner's "delete + recreate?" question: evidence points to modify-in-place; not proof of the HMS write.
- **C9 (L2, payment state is mostly invisible in mail).** At amend time: paid evidence 44/223, unpaid 54/223, **unknown 125/223**. Letters say deposit 0 on 1,114/1,174. So paid/unpaid must come from an HMS read (deposit / folio / guarantee), not mail. Travel-agent voucher threads: 181, of which travelit.co.za 154; prepaid wording 0/181.
- **C10 (L6, precedent baseline).** BM25 top-5 majority predicts the first-reply answer type on 302/411 held-out asks vs 301/411 for "always text only". Answer type is a bad target (text-only 73%). Human check: useful top-3 precedent 6/20, useful-or-partly 19/20. **Consequence for the Hindsight A/B:** score human-judged useful@3 (and fact recall: rate, board, party), not answer type. BM25 useful@3 = 6/20 is the bar to beat.

## L7 decision-memory baseline (15:40Z) — parked with ask 162

- [l7-decision-memory-baseline.md](l7-decision-memory-baseline.md). Wide cohort (exact recipient within 72 h before letter, unreviewed): 191/655 conf IDs linked, test 60 rows / 38 asks. Strict L1 cohort: 0 index rows → unusable.
- Sender→domain history on letter party line: right 11/56, **wrong 17/56**, abstain 28/56; confident-only 5 right / 1 wrong / 50 abstain.
- **C11 (Opus): conflicts with L0 party history 109/150 right, 0 wrong.** Different truth: L7 compares the whole normalised letter party block (1–3 lines, agency + company joined) as one exact string; L0 compared HMS profile picks. Wrong-17 likely includes partial matches (same agency, different company line). Do not quote L7 party numbers until scored per line (agency vs company). Test set n=60 < 100 bar anyway.
- Useful: current ask disagrees with sender history on nights 15/18 and board 5/16 → current mail must override precedent (design rule already in ARCHITECTURE §3).
