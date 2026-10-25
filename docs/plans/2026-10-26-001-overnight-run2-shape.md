---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
status: shaping (grilling round 1 answered, round 2 open)
asks: [223, 224]
---

# Overnight run 2 — shape (draft, 2026-10-26 00:10 UK)

Evidence lanes: /tmp/shape1025/L1–L5.md (Luna max, read-only, 2026-10-25 23:33–23:55 UK) + prod read-only SQL/env. Evidence doc: docs/research/2026-10-25-pane-prefetch-and-ui-evidence.md.

## 1. Root cause found (P0)

- Prod processes carry `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION` (Centurion install file `.private/quote-pilot-release-20261006/installation.json`) but **no `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV`**. `assertPropertyQuoteReady` (apps/server-pilot/src/hms/hms-read-target.ts:63-79) refuses `not_set_up`; the background scheduler swallows it (hms-jobs.ts:2675) → 0 background quotes on all 3 DV quote mails today. Same class as MISTAKES 2026-10-23 ("flag on, no HRDAV quote installation") — a **repeat**.
- Fix: provision HRDAV install file + env on http/worker/ai-worker, `/proc` check, one DV canary; persist every prepare skip reason (L2: ~90–130 LOC); background refusals surface as an alert, not silence.

## 2. Owner decisions (round 1)

| # | Decision |
|---|---|
| 1 | Side pane in Outlook is the product (webmail/browser only stands in for Outlook). Undo/redo + provenance stored **server-side per to-do** |
| 2 | Sparkle on AI-filled fields, hover = source; typed = no icon; reset-to-AI per section header; undo/redo at top of pane |
| 3 | Availability & rates merge into the Stay card as room × rate grid (price + rooms left); tap cell = room + rate |
| 4 | Custom rate / typed code / Authorised by: keep, but as an "Other rate…" option at the bottom of the rate dropdown or an edit (pencil) button — clearly a typed rate |
| 5 | **Unanswered** (Guest & contact merge) |
| 6 | HMS note moves into Book in HMS as Reservation Note — evidence: HRDAV create requires Reservation Note (docs/research/2026-10-25-hrdav-dom-read.md:47-82); the note text is generated before stay/rates but includes rates + extras, so it goes stale (L5, quote-workflow-panel.tsx:1130) |
| 7 | Prefill Book fields from history then hotel default — open: how big is agency history tracking (round 2) |
| 8 | Agency: pre-look up always; match → show recommended + why; no match → "No match found", closest candidates, pick or type. Re-verify against HMS profile, not email legal name (round 2 design) |
| 9 | PDF + Book preview + commit = persisted server jobs (survive click-off) |
| 10 | No screenshot gate. Merge and deploy whenever optimal; owner reviews after. Max parallel, smartest models, test fast |
| 11 | Needs-you: leave it (owner wants disable cost: hide entry ≈10–30 LOC). Opening a specific email in Outlook is already coded once: rates-ready-notice.ts:73 `Office.context.mailbox.displayMessageForm` |
| 12 | Order: background quotes → pane UX → generic HMS session; caps alongside |
| Holds | Book in HMS = Labtest only. Flags/env: owner OK switching on (still canary per property after). Never send mail |
| Review | Adversarial review = Gemini 4 Argon High (agy), free on subscription; report its quality after the run |

## 3. Rate prefetch (ask 224 item 3) — evidence and pushback

- S5 (30 days to 2026-10-24, 6 mailboxes, regex rate words on 1,458 quote-like outbound): see chat table. Label words, not validated staff choices; BAR inflated by HMS confirmation letters; only 24% joined to inbound.
- DV fan-out today = 9 strategy shops/stay; G9 timings 30–41 s each, 5.4 shop-min/stay (n=1 per strategy).
- At ~2–3 DV quote mails/day, all 9 = ~11–16 HMS-min/day. Pruning to top-3 saves ~7–11 min/day. **Recommend: shop all strategies in background, ordered BAR → mailbox/party likely → rest, so likely rows are ready first; log every staff pick (strategy, party, mailbox, user, mail type) to build the tally; prune only when volume or a measured queue wait needs it.** Tally ~120–180 LOC (L3).

## 4. Scope (LOC from L2/L3/L4/L5, [U] estimates)

| Slice | LOC | Deps |
|---|---:|---|
| P0 HRDAV install + skip-reason ledger | 90–130 + env | — |
| Caps → gate on live admission, remove/defer | 80–140 | — |
| Generic kept-alive HMS session (slot-owner lease, all tools, registry-driven, no HRCEN default) | 140–260 | — |
| Rate tally + ordered all-strategy prefetch | 120–180 | P0 |
| Pane A half-date guard + debounce | 80–150 | — |
| Pane B HRDAV create contract (Market Segment, T&C) | 120–260 | — |
| Pane C one status line | 70–130 | — |
| Pane D extras inside Stay border + "Duplicate stay" | 40–90 | — |
| Pane E note → Book | 30–70 | D |
| Pane F availability-grid prefetch per stay | 150–280 | A |
| Pane G grid cell = room+rate+board | 180–320 | D,F |
| Pane H provenance per field | 230–390 | B,G |
| Pane I reset-to-AI per section | 120–240 | H |
| Pane J server undo/redo | 180–360 | I |
| Pane K persisted PDF job | 150–280 | J |
| Pane L persisted Book preview | 120–260 | B,G,H |
| Pane M idempotent Book commit job | 220–390 | B,L |
| Party pre-lookup readback (24 h window hits old mail) + no-match UX | [U] 80–160 | — |
| PR triage closes/salvage (L1) | 0 product | — |

Total ≈ 2.3k–4.2k product LOC ≈ 16–26 PRs. Last run: 26 PRs in 18.5 h (retro). Ballpark full scope 16–24 h serial-ish; downscope in round 2.

## 5. PR triage (L1; GitHub/Orca unreachable from the lane — verify heads/Greptile in run)

Close: #2 (Apr perf, stale), #48 (party v3 superseded), #223 (old notes), #335 (core superseded), #488 (create passes; salvage logger on recurrence), #307/#320 (verify superseded). Salvage: #189 (Needs-you Run HMS chip), #196 (typecheck baseline), #218 (golden set, split), #336 (stale-result guard), #420 (unique facts), #463 (rate intent, needs truth input). Rebase+review: #462 Wednesday pause (next Wed 2026-10-28). Merge: #552 (retro docs). 13 worktrees preserve-first.
