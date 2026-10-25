# P4 sizing: re-check a thread after a staff reply (ask 221)

Lane: GPT-6 Luna max, read-only, 2026-10-25 ~00:10Z, origin/main `1656bca50`. Coordinator note: the lane assumed an owner-supplied hotel→mailbox map is missing; the U1 registry supplies it. The lane counted a separate migration; the plan stores the outcome on the existing work-item row (no new table) where possible — Grok review decides.

**TL;DR —** C2 closes by sender and time, not reply meaning. Full cross-mailbox scope: roughly **330–535 product LOC**, **235–385 test LOC**, plus an **80–130 LOC offline eval script**.

Read `PRODUCT.md`, `ACTIVE.md`, `OWNER-ASKS.md`, research README, `AGENT.md`, `FACTS.md`, and `CATALOG.md`. `origin/main` is `1656bca50`; cwd is clean at `23b71fa40`, one commit behind. Codegraph ran first, but its index points at the parent checkout; source checked from `origin/main`.

### Findings

| Slice | Evidence / answer |
|---|---|
| Reply identity | [`outboundSentAfter`](../../apps/server-pilot/src/ai/work-items.ts:818) is a time predicate. [`knownSenders`](../../apps/server-pilot/src/ai/work-items.ts:1089) trusts exact From addresses seen outbound on that **same transport**; reply-all copies count only with that evidence. |
| Actual close | [`planThreadWork`](../../apps/server-pilot/src/ai/work-items.ts:1212) reads one transport/thread. Latest hotel mail after the request and later than guest mail closes it; acknowledgements count, no content check ([1262](../../apps/server-pilot/src/ai/work-items.ts:1262), [1269](../../apps/server-pilot/src/ai/work-items.ts:1269)). It writes `done` and `hotel_replied` ([1391](../../apps/server-pilot/src/ai/work-items.ts:1391), [1405](../../apps/server-pilot/src/ai/work-items.ts:1405)). |
| Quote clock | Eligible reply-closed quotes/bookings get the existing **66h** clock ([constant](../../apps/server-pilot/src/ai/quote-followup.ts:70), [due time from `sentAt`](../../apps/server-pilot/src/ai/quote-followup.ts:942)); sweep enqueues its own run ([1014](../../apps/server-pilot/src/ai/quote-followup.ts:1014)). |
| Outbound path | Extraction rejects non-inbound triggers ([reservationist-extraction.ts:99](../../apps/server-pilot/src/ai/reservationist-extraction.ts:99), [111](../../apps/server-pilot/src/ai/reservationist-extraction.ts:111)). Causal triage input itself keeps outbound rows ([triage-input.ts:100](../../apps/server-pilot/src/ai/triage-input.ts:100)); worker treats sent copies as analytics-only ([worker.ts:4645](../../apps/server-pilot/src/ai/worker.ts:4645)). |
| Job path | DB enum is the job-kind registry ([mail.ts:65](../../apps/server-pilot/src/db/schema/mail.ts:65)). `enqueueAiRun` supports idempotency ([run-ledger.ts:412](../../apps/server-pilot/src/ai/run-ledger.ts:412), [conflict handling](../../apps/server-pilot/src/ai/run-ledger.ts:515)); worker claims and dispatches jobs ([5660](../../apps/server-pilot/src/ai/worker.ts:5660), [5490](../../apps/server-pilot/src/ai/worker.ts:5490)). Unknown kinds fail. |
| Cheapest triage path | Lowest configured profile: `nova_lite` → `amazon.nova-lite-v1:0`, Bedrock Converse ([factory.ts:72](../../apps/server-pilot/src/ai/bedrock/factory.ts:72)). Missing profile defaults to GPT-6 Luna ([env.ts:29](../../apps/server-pilot/src/env.ts:29)); live env not checked. Existing system/user prompt and adapter call: [mail-triage.ts:158](../../apps/server-pilot/src/ai/workflows/mail-triage.ts:158), [341](../../apps/server-pilot/src/ai/workflows/mail-triage.ts:341), [824](../../apps/server-pilot/src/ai/workflows/mail-triage.ts:824). Reuse adapter/profile; make a new reply prompt/schema. |
| Cross-mailbox gap | No hotel group on [`mailboxTransport`](../../apps/server-pilot/src/db/schema/mail.ts:176); threads are transport-scoped ([320](../../apps/server-pilot/src/db/schema/mail.ts:320), [375](../../apps/server-pilot/src/db/schema/mail.ts:375)). Need owner-supplied trusted hotel→mailbox/sender mapping plus RFC reply correlation; domain-only matching unsafe. |
| `handled` | Keep `done`; eligible quote/booking keeps existing reply-rooted 66h clock. |
| `waiting_on_guest` | Keep `done`; same clock. This honors the requested mapping, including “we’ll revert.” |
| `needs_more_action` | Reopen same item as `needs_you`, show reason/evidence, clear clock until a later complete hotel reply. |
| Queue/safety | Enqueue in close transaction, also on newer reply-link repoint. Key: `reply-check:${workItemId}:${replyMessageId}`. Analyze causal thread through reply ID; apply only if it remains latest. Gate quote sweep while check pending; failure → `review`, never silent done or auto-send. |

### Touch map — rough added LOC

| Files | Estimate |
|---|---:|
| [`schema/mail.ts`](../../apps/server-pilot/src/db/schema/mail.ts), new `drizzle/0052_reply_check.sql`, [`_journal.json`](../../apps/server-pilot/drizzle/meta/_journal.json), [`db/provision.ts`](../../apps/server-pilot/src/db/provision.ts), [`db/seed.ts`](../../apps/server-pilot/src/db/seed.ts) | `+3–5; +4–8; +7; +10–20; +10–25` |
| [`work-items.ts`](../../apps/server-pilot/src/ai/work-items.ts) | `+130–210` |
| New `src/ai/reply-check.ts` | `+120–180` |
| [`worker.ts`](../../apps/server-pilot/src/ai/worker.ts) | `+20–30` |
| [`quote-followup.ts`](../../apps/server-pilot/src/ai/quote-followup.ts) | `+20–35` |
| [`backend-bind.ts`](../../apps/mail/lib/quote-workflow/backend-bind.ts), [`needs-you.tsx`](../../apps/mail/components/nava-pane/screens/needs-you.tsx) | `+2–4; +5–10` |
| New `scripts/reply-check-eval.ts`; private human-label data, not Git | `+80–130; 100+ rows` |

### Tests — rough added LOC, separate

| Test files | Estimate |
|---|---:|
| New `tests/reply-check.test.ts`; [`ai-triage-input.test.ts`](../../apps/server-pilot/tests/ai-triage-input.test.ts) | `+100–150; +10–15` |
| [`work-items.test.ts`](../../apps/server-pilot/tests/work-items.test.ts); [`quote-followup.test.ts`](../../apps/server-pilot/tests/quote-followup.test.ts) | `+60–100; +25–45` |
| [`ai-worker-contract.test.ts`](../../apps/server-pilot/tests/ai-worker-contract.test.ts); [`migration-compatibility.test.ts`](../../apps/server-pilot/tests/migration-compatibility.test.ts) | `+20–35; +10–20` |
| [`needs-you.test.tsx`](../../apps/mail/tests/needs-you.test.tsx) | `+10–20` |

Baseline: strip quoted history/signature; direct guest question/request or explicit “we’ll revert” → `waiting_on_guest`; partial/pending without that cue → `needs_more_action`; complete answer/no open cue → `handled`; unclear → abstain/review.

Truth set: read-only cohort of ≥100 distinct `(workItemId, replyMessageId)` prod rows, selected independently of predictions; include mature follow-up timelines and cross-mailbox/reply-all cases. Two humans, blind to rules/model, label from later human-authored messages/actions; adjudicate conflicts. Do not use current `done` status or model output as gold; freeze IDs, report `n` and source.

Need owner’s trusted mailbox map, read-only prod-export approval, and two labelers. No ledger-matched elapsed-to-production ETA from this sizing pass; mapping → export/labels → implementation → review/deploy are serial dependencies. Rule baseline is zero model-call cost; Nova Lite is fallback if rules miss the bar.

No files changed; no prod query or tests run.
