# Da Vinci readiness for the Faith call — evidence (2026-10-26)

Nine read-only lanes plus coordinator checks on prod `f70fbae67` → `d4b37acbc`. Prod SQL was read-only (`hitl_tool_run`); no guest data is kept here. Lane transcripts stay private.

## 1. Quote outage (fixed)

| Fact | Evidence |
|---|---|
| 0 successful quotes after 12:00Z; the last success was 10:37Z; 16 staff clicks (faith) all refused | `hitl_tool_run` kind=quote, 2026-10-26 |
| Cause: `/tmp/or2/disk-clean.sh:32` `docker image prune -af` at 11:31:26Z deleted the pinned Poppler image `sha256:f1c3376c…` used by the policy-PDF step | docker events; `staff-quote-installation.ts:248` (pre-fix) |
| Hidden as a generic `refused`: the reason code was not in `QUOTE_REFUSAL_REASONS` | `hitl-tool-run.ts:211-259`, `:303-310` |
| Fix #614 (bwrap sandbox, same host `/usr/bin/pdftotext`) deployed 17:19Z; all 3 installed policy PDFs give `reason=text` on prod | ops-deploy log; on-box extraction probe |
| Not yet proven: a priced quote end to end after #614 | — |

## 2. Why Da Vinci rates fail (wholesale and other non-BAR)

| Gate | file:line | Effect |
|---|---|---|
| Public scope is hard-coded `BAR/BARRO/WAL` | `fetch-quote.mjs:544` | DV WS/NC/AIR/GOV rows are never public; they verify only through an agency bind (`:602`) |
| GOV verification uses a Centurion label regex | `fetch-quote.mjs:601` | DV GOV partial (cause unverified) |
| A first window over 5 rows skips detail reads, so the outcome is forced to `partial` | `fetch-quote.mjs:657-658`, `:799-803` | WS (17 rows on 10-25) is always partial |
| NR boards are unmapped | `rate-options.ts:3` | `Bed & Breakfast NR` is never sellable |
| `partial` goes to the generic throw | `reservationist-evaluation-composition.ts:255` | 128 HRDAV `capture_scope_or_completeness_invalid` today, 0 HRCEN |
| HRDAV tax/levy terms docs `documents: []` (observed 10-26) | `reservationist-rate-policy-source.ts:84-125` | Blocks any priced DV quote, including BAR (needs a live check after #614) |
| Staff see "Search failed"; the reason is only in a tooltip | `quote-workflow-panel.tsx:1233` | Faith cannot tell why |

The per-hotel data exists (HRDAV profile: 9 strategies, `observedStrategyRatePlans.WS` = BWS1B/2B/3B…, `stoMapping`) but no code reads it (#528).

## 3. Room type toast and profile

- `hrdavKnownCode` uses an exact code or an exact lowercased label, so "STANDARD TWIN ROOM" fails (`staff-quote-bind.ts:~426`, error at `:505`).
- "Room profile out of date": the `matchesProfile` pooling guard (`quote-contract.mjs:621-700`). HRDAV capacities come from one night's max inventory.

## 4. Create + come back later

| Step | State |
|---|---|
| Prefill → preview → Book → Save → readback → work item | wired in code, both hotels; CLI Labtest PASS 10-25 (HRCEN 67907179-1, HRDAV 96077329-1); **pane never proven** |
| Before/after screenshots | 30-min in-process Map, then deleted (`pane-stay-save.ts:36`, `:466-474`); the work item keeps only a ref |
| Book receipt after reload | browser memory only; the server `stayPreviews` grant is never read by the client |
| Confirmation email recipient | no code routes it; which HMS field Infor mails is unknown. Booker Contact `udfchar06` is written (LIVE-UNVERIFIED) |
| Flags | `PANE_WRITE_CREATE=on`, `HMS_DAVINCI_CREATE=on` since the 10-23 run (owner 10-26: fine, nobody uses the pane) |

Mailbox facts (staff call, ASR): DV has one hotel mailbox that only Iain accesses; Faith works from her own mailbox and wants confirmations there first, then forwards. Centurion: Bongi works the shared mailbox and sends to the client.

## 5. Amend / cancel

| Case | Write | Live |
|---|---|---|
| Amend provisional | Labtest Save + readback in code | **never passed** (occupancy combobox and date don't stick); DV always refused because the spawn env strips write flags (`pane-stay-spawn-env.ts:81-91`) |
| Amend paid | refused by design | — |
| Cancel provisional | reason + OK, **plus Waive/OK on penalty dialog** (`cancel-stay-rules.mjs:320`, d82533a23) | PASS both hotels 10-25 on `7dd78a67b`; current SHA unproven |
| Cancel paid | refused before reason/OK | unit tests only |

Paid detection: `guaranteetype` paying values, `depositreceived > 0`, `status` (`pane-stay-lookup.ts:205-352`). `CANCEL_UNPAID=on` makes real-guest unpaid cancel reachable, and the cited approval "ask 200" does not exist. The penalty click conflicts with the PRODUCT.md hard rule. No notice-window check (DV staff: 48 h; late = 1 night; groups = whole stay).

## 6. Background prefill and suggestions

- Server jobs survive click-off. The quote session resets on mail switch; outage parks show "Retrying" (copy never reaches the client).
- The DEV gate blocks across properties (`run-ledger.ts:638-646`): parked HRCEN work holds DV dev canaries.
- Learned party history chip is inert in the pane: the suggest route passes no `propertyCode` (`pane-party-lookup.ts:21,35`), a 1-line fix.
- Rate picks only reorder background shops and are never shown. Auto-start runs are logged as staff picks (gap).
- Best unbuilt suggestion: per-mailbox × party rate suggestion. The DV case only (HRCEN staff 23/23 BAR); needs an explicit-pick flag and a ≥100-row eval.

## 7. Staff call (2026-10-26, Da Vinci, ASR)

29 items, 9 missed by the earlier analysis. New since that analysis:
- Guest may pay by a link that includes accommodation.
- The transport desk posts the shuttle charge at check-in.
- Staff think accounts pays transport.
- "Readiness" text and what Create booking does are confusing.
- Faith wants to revisit a created booking's confirmation later.
- Her colleague runs the hotel mailbox.

Full table: lane output, summarised in the plan.

## 8. Centurion HMS

Network path OK (tun0; TLS reached; login page 200). The authenticated shell times out (`AUTHENTICATED_SHELL_TIMEOUT`) after the 08:00–14:00Z maintenance. A slot restart at 17:24Z did not fix it. Owner: lowest priority; diagnose from a screenshot, never by retry.

## 9. Subagent speed (process)

Pre-cut-source lanes: 9–14 min with 7–11 calls. Open code-trace lanes: 60–70 min with 97–262 calls, mostly duplicated serial `grep -r`. Rule saved in MISTAKES and memory: anchors in the brief, ≤25 calls, cut at 10 min.
