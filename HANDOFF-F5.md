# HANDOFF-F5 — billing + payment-proof to-do card

Updated: 2026-10-16T01:48Z

## Done

PR https://github.com/kufupa/Zero/pull/341 (`feat/g-F5-10152332`, `b4e9c7d31`)

Staff open POP or billing mail → existing to-do card shows:

| Workflow | Title | Card shows |
|---|---|---|
| `payment_ack` or `hms_todo`+`post_payment` | Post payment | Amount/currency/date/ref from **current** mail + attachments only. Matched stay when pane find rows are passed in. Else mail conf# + **find the stay**. Unsure match → **check conf#**. |
| `send_document` or `hms_todo`+`document` | Send document | Asked kind, stay, `pickReplyLine` S, **HMS → Documents**. |

No HMS write. No new HMS readers.

## Proof

- server-pilot `tests/hms-todo-card.test.ts` 23 passed; aop match/pick/reply 49 passed
- mail `tests/hms-todo-card.test.tsx` 6 passed
- remote typecheck `--baseline`: mail 0 new (62/62), server-pilot 0 new
- Greptile round 1: fixed amount-from-thread P1, pro forma overlap, billing dates, guest≠payer. Left stayCandidates (watchdog: no new HMS readers).
- Greptile round 2: **P2 only** (invoice+credit-note overlap; billing follow-up kind from thread). Left as-is (≤2 rounds, same as F2).

## Next (not this lane)

1. **Stay candidates:** pass pane-stay-lookup find rows (`conf#` or surname+arrival) into `buildHmsTodoCard({ stayCandidates })`. Analyse has the field; the pane tRPC route does not send it. Until then every live POP card says **find the stay**.
2. **`pickBillingDocument`:** `src/hms/live-document-list-driver.ts` has no production caller. Wire only when a document list already reaches the server. v1 lists ask kind and **HMS → Documents**.
3. **Live proof (orchestrator):** 2 recent POP + 2 billing mails on prod pane; screenshot; HMS read-only conf#/amount check.
4. **val300 offline:** 50 POP + 70 billing rows, attachment-aware. Gate: 0 wrong amounts; wrong stay ≤ 2.

## Not doing

Deploy, env, live HMS write, new HMS readers.
