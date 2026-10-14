# Plan: one-click case card (quote, new booking, amend, cancel, payment) — 2026-10-14

Owner goal: every actionable email reaches a state where staff could act in one click. Nava has already classified it, extracted everything, looked up HMS in the background, and pre-filled a case card in the order a reservationist decides. Staff verify and pick; HMS writes stay behind approval. Target after that: autonomy per workflow once the pass bars hold.

Sources: lanes P1 (capability matrix), P2 (test sets), R-casecard (decision order + spec), R-meta (CI, merge gate, memory). Raw reports are private in `/tmp/plan14/*.out`, to be copied to `/home/orca/nava-research/reports/plan-20261014/`.

## 1. Decision order (what a reservationist does) → case card sections

| # | Section | Source | Today |
|---|---|---|---|
| 1 | Header: mailbox, email, read-as, job status, fact freshness | classifier + jobs | exists |
| 2 | **Party + contact** (company / agency / A/R separate from quote contact) | email + HMS party lookup (`pane-party-lookup.ts`, `party-lookup.mjs`) | exists; prefetch gated |
| 3 | **Rate authority**: negotiated eligibility vs BAR, "Authorised by" for overrides | HMS rate context (`staff-quote-workflow.ts`) | selected allocation only |
| 4 | **Stay**: dates, nights, room-type rows, counts, occupancy; unknowns explicit; no headcount→rooms split | extraction (`requirement-card.tsx`) | exists; panel shows stay before party |
| 5 | **Availability × price grid**: every room type × night: stock vs requested, contract price, BAR price, freshness | HMS all-room read (`hms-availability.ts`, `fetch-quote.mjs`) | **reader has it; stored projection drops nightly stock and prices** (why the owner sees no twin/queen/king prices) |
| 6 | Extras (dinner) + shortage alternatives (pane-only until "Use this") | config + HMS | exists, alternatives show average/night only |
| 7 | One missing-info ask + documents (PDF, Excel, unsent reply) | session + document review | exists |
| 8 | **One primary action** for the current state | per workflow | quote: prepare · create: preview+book per room · amend: none · cancel: disabled · voucher: find only |

Same skeleton for new booking (+ duplicate/existing-reservation check, guarantee), amend (find → requested vs booked diff → re-rate only if affected → apply), cancel (request vs notification → find → status/penalty → staff decides), payment/voucher (voucher ≠ POP → find → compare → act).

## 2. Slices (each ≤ ~500 product lines, one behaviour, own PR). ★ = shared file, one owning lane

| ID | Slice | Files | HMS? | Status |
|---|---|---|---|---|
| S0a | Pre-stay self-mail = existing stay | triage/routing | no | lane running |
| S0b | Missing-details reply on Luna-read fallback | `session.ts` | no | PR #227 |
| S0c | Room-type resolution (count prefix, joined labels) | `room-types.ts` ×2, config | no | PR #228 |
| C1 | Party-first card order + single blocker/action | ★ `quote-workflow-panel.tsx` | no | next |
| C2 | Selected quote nightly prices shown clearly; averages labelled | `rate-cards.tsx` (+ panel, after C1) | no | after C1, same lane |
| C3 | Keep all-room nightly facts (stock, price, eligibility, currency, freshness) in the availability projection | ★ `hms-availability.ts`, `types.ts` | code offline with DOM fixtures; verify live | next |
| C4 | Party-scoped rates for every type/night (contract vs BAR) | ★ `staff-quote-workflow.ts`, `hms-jobs.ts` | yes | after HMS + C3 |
| C5 | Render the grid + shortage alternatives | ★ panel, `nava-pane.tsx` | data needs HMS | after C3/C4 |
| C6 | Background find for amend/cancel on strong identity | `pane-stay-lookup.ts`, `amend-lookup-panel.tsx` | yes for proof | after HMS |
| C7 | Grouped one-click create (partial-failure semantics) | ★ `booking-card.tsx` | yes | **owner decision** |
| C8 | Amend writer scope; cancel live authorisation | `pane-hms-write.ts` | yes | **owner decision** |
| I1 | Local CI queue: flock + memory guard (≥ 8 GB free) + affected tests + `local-ci/presubmit` commit status | `scripts/ci/` | no | next |
| I2 | Worktree bootstrap: `pnpm exec husky` so pre-commit hooks run in `.worktrees/` | script | no | next |
| I3 | `gate.sh <pr>`: local CI status + Greptile P0/P1 = 0 + Haiku review → `gh pr merge --auto --merge` | `scripts/ci/` | no | after I1 (branch-protection status requires owner OK) |
| L1 | nava-admin review/label mode for the 400 eval emails (owner labels there) | ★ `workflow-folder-desk.tsx`, `work-items.ts` | no | session `-70` or a lane |

## 3. Test sets and bars (PRODUCT.md "Pass bars")

- **Labels:** staff outbound gives a defensible label for few threads (same-thread cue 401/5,371; any conversation signal 1,868/4,580). "No reply" is **not** a no-action label: the snapshot lacks reply headers and is right-censored. The owner labels the semantic classes in nava-admin (L1); outbound rules pre-fill where they exist.
- Quote: staff price/rate plan on ≥ 10 plannable threads (after HMS). Plannable ceiling if the room-type, room-count and occupancy blockers are solved: ~85–92% of the 39 recent asks.
- Classifier: ≥ 90% / ≤ 1% failures on owner-confirmed labels; model evals run on EC2 (this VPS lacks the app's model config).
- Pre-stay: 0 false creates on the 69 pattern candidates in the corpus.

## 4. How we run it

- One orchestrator session (fresh, reads this file) + Luna max lanes, one per slice, no shared ★ files in parallel. Haiku max reviews each diff. Greptile runs on every PR, with 2 rounds then validate/adjudicate.
- Heavy checks one at a time (I1). Lanes run targeted tests only. Commit + push every green slice; deploy in batches when the owner wants to look (nava-admin).
- HMS back ~13:05Z → live work in this order: quote-ready proof batch, C3 verify, C4, C6.
- Owner touchpoints: C7/C8 decisions; labelling in L1; looking at the case card in nava-admin after each deploy batch.
