---
title: "feat: Da Vinci full-field provisional booking from email (one pass)"
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
property: HRDAV
---

# Da Vinci full-field provisional booking (one pass)

## Goal

A real Faith (Da Vinci) booking email opens in the pane with every staff field filled. Staff click Book, and HMS gets one provisional booking per room. Each booking matches what Faith would type. HMS sends its own confirmation letter in the background.

Every "add one field" step has been proven before: Labtest create E3/E4 (2026-10-25/27), multi-room quote P0a6, booker email #654. This plan does not re-prove them. It ships **all known field gaps in one pass** and proves them with **one hard live booking** that HMS has never seen.

## Why (evidence)

| Gap | Evidence | Effect today |
|---|---|---|
| CMS Message Id blank | Not filled anywhere in code; E3 screenshots show it blank ([letter proof](../research/2026-10-27-hms-quote-letter-proof.md)) | Letter probably never queued |
| Children refused | `apps/server-pilot/src/ai/pane-stay-save.ts` `paneStayModeRefusal`; card hides Book on child rooms | Any family booking is typed by hand |
| Agency not picked | `create-request.mjs` types the `ta1` name and tabs out, marked LIVE-UNVERIFIED | Agency may not bind, so rate and letter go wrong |
| Agency rate doesn't reach the booking card | Prep already runs for bookings with the agency; the V2 party result lacks propertyCode and the strategy match fails (U2) | Wrong or empty rate plan in the pane |
| CCIATA guarantee refused | `HRDAV.json` offers it; `create-tool.schema.json` enum lacks it | Book fails at schema load |
| HRDAV required fields | HMS requires Market Segment + Terms (`guestoptin4`); pane treats them as optional | Save refused `refused_save_blank_required` |
| Pane order and editability | Room type, rate plan, adults and children are read-only in the booking card; agency is free text in 3rd place | Staff can't fix a wrong default where they book |
| Proof runner drops fields | `apps/server-pilot/src/ops/hms-proof-run.ts` `STAY_KEYS` lacks marketSegment, guestoptin4, confirmationRecipient | CLI proofs needed sidecars |
| No CMS readback | Only `emailaddress` is read back after Save | "Letter will send" is never verified |

## Settled facts (do not re-research)

- **CMS Message Id options, HRDAV.** Read live 2026-10-28, and identical to the owner's HRCEN screenshots: [codes](../research/2026-10-28-hrdav-cms-message-id-codes.md).
  - Faith mostly uses **01** (guest booking, with payment link) and **03** (agency/company booking, with payment link + proforma). Both are provisional-booking letters.
  - 012/014 are payment proof (later workflow). 05 is online check-in. 08 is agency booking, NO RATE.
- **Owner rule:** CMS Message Id is **never blank** on a Nava create.
- **Send Mail `udfchkbox04`** is an Ext button-style checkbox. `tickCmsSendMail` already handles that path.
- **Children:** the HMS popup takes one age per child and HMS does the 0-2/3-12/13-17 banding. The runner's `applyChildAges` already types ages.
- **Book per room** already exists. Each room has its own Book button, and "Book this stay" books the rooms one after another (`booking-card.tsx` `bookThisStay`). No new multi-room code is needed.
- **Same component on both surfaces.** `BookingCards` renders in both the Outlook pane and the webmail panel.

---

## Key decisions

| Decision | Why |
|---|---|
| One pass, 3 lanes, each owning its own files | Every gap is already scoped. One lane per file, so no merge conflicts and no fix-lane churn. |
| Message Id default: agency/company bound → `03`, else `01`; staff can switch to `08`; Book refused when blank (server and runner) | Owner rule plus Faith's usage. A double check costs about 5 lines. |
| Store Message Id options in the property profile (`cms.messageIds`, `cms.defaultAgency`, `cms.defaultGuest`) | Each hotel has its own codes; never hard-code Centurion. |
| Staff type children as ages, not bands | HMS bands them itself, so there is no mapping code and nothing to get wrong. |
| Pick the agency `ta1` from the HMS lookup row (reuse the party-lookup dialog pattern), not type and tab | The rate and the letter both depend on the agency actually binding. |
| New-booking rate default = the agency-entitled rate HMS returns for the bound party; if not ready, "rates loading", never a guess | Reuses the quote read path; no census needed. |
| **No** booking-card split PR first | One lane owns the file, so splitting only adds a review cycle. Split after the proof if it is still painful. |
| Coders: Claude Code, `claude-fable-5-1` slot = **GPT-6.1 Terra xhigh** | Owner 2026-10-28: smarter and cheaper than Grok for coding. |
| Review: Greptile Apex once + coordinator reads every product diff; no Grok/Argon round | Saves ~30–60 min. Write-path risk is covered by the live proof and readback. |
| Tests run on Product EC2 only, one per behaviour at the seam | VPS rule (no local tsc or tests). |

## Shared contract (lanes code against this; L1 owns it)

New optional fields on the pane stay input (tRPC zod + `PaneStay` + runner request schema):

- `cmsMessageId: string`: must be a code in the property profile's `cms.messageIds`. Required at Book when `confirmationSendMail` is true.
- `childAges: int[]` with ages 0–17, max 16 (already in the type; refusal removed).
- `guaranteeType`: a label from the profile (CCIATA allowed).
- `bookingAgency`: `{ name, id? }`. When `id` is present the runner picks that lookup row.

---

## Implementation units

### U1. Write path: CMS, children, required fields (L1)

**Goal:** the runner and server accept and fill every field, and refuse with a named reason when something is missing.
**Files:**
- `apps/server-pilot/src/ai/pane-stay-save.ts`
- `apps/server-pilot/src/trpc/routes/quote-workflow.ts` (zod)
- `apps/server-pilot/tooling/playwright-quote/create-request.mjs`
- `apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs`
- `apps/server-pilot/tooling/playwright-quote/create-tool.schema.json`
- `apps/server-pilot/tooling/playwright-quote/property-profile.mjs`, `property-profile.d.mts`
- `apps/server-pilot/tooling/playwright-quote/property-profiles/HRDAV.json`, `HRCEN.json` (cms block)
- `apps/server-pilot/src/ops/hms-proof-run.ts`

**Tests:**
- `apps/server-pilot/tests/pane-stay-save.test.ts`
- `apps/server-pilot/tests/hms-proof-run.test.ts`
- `apps/server-pilot/tests/create-request-confirmation.test.ts`
- `apps/server-pilot/tooling/playwright-quote/create-request.test.mjs`
- `apps/server-pilot/tooling/playwright-quote/create-tool.schema.test.mjs`
- `apps/server-pilot/tooling/playwright-quote/property-profile.test.mjs`

**Approach:**
- **Profile `cms` block:**
  - The block holds codes plus descriptions, `defaultAgency: "03"` and `defaultGuest: "01"`.
  - The validator rejects any default code that is not in the list.
- **Runner fills `udfchar09`** using the lookup dialog, following the existing `pickTrackLookup` pattern: open trigger, find the row by code, click, then OK.
  - Do not type the code into the field: HMS lookups validate the picked row.
- **Readback after Save:**
  - Read back `udfchar09`, `udfchar13` and the Send Mail checked state.
  - On a mismatch, return `saved_cms_mismatch`. The booking stays saved, and staff see the mismatch.
- **Children:**
  - Delete the `pane_save_children_unsupported` refusal.
  - Bound ages to 0–17 in zod.
  - Read back the HMS child counts (`child1/2/3`) and compare them to the banded expected counts.
- **CCIATA:** check the guarantee label against the profile's options instead of the hard-coded enum.
- **Server-side required fields:**
  - Refuse in `stayBookFieldRefusal` when `requiredCreateFields` from the profile are blank.
  - For HRDAV that means reservationnote, marketsegment and guestoptin4, each named.
- **`ta1`:**
  - When `bookingAgency.id` or a name is given, open the agency lookup and pick the exact row (reuse the `party-lookup.mjs` dialog helpers).
  - If there is no unique row, refuse with `agency_not_unique`; never guess.
- **`STAY_KEYS`:** add marketSegment, guestoptin4, confirmationRecipient and cmsMessageId.
  - Keep the rule that a recipient needs explicit send authorization ([letter proof](../research/2026-10-27-hms-quote-letter-proof.md) proof-runner section).

**Test scenarios:**
- Happy: a HRDAV stay with an agency, `cmsMessageId 03`, 2 adults and ages [5] passes all refusals, and the request JSON carries every field.
- Blank Message Id with Send Mail on → `cms_message_id_required`, refused before the lock.
- Message Id `99` (not in profile) → `cms_message_id_unknown`.
- Ages [18] → zod refuses; ages [] → no child popup.
- CCIATA label on HRDAV → accepted; an unknown label → refused.
- HRDAV with blank market segment → `pane_save_market_segment_required`; blank note → `pane_save_reservation_note_required`.
- Proof-run request with marketSegment, guestoptin4 and recipient keeps all three; recipient without send authorization → refused.
- Profile with `defaultAgency: "77"` that is not in the codes → the validator throws.
- Readback comparison is a pure function: expected {09: 03, 13: x, send: true} vs actual blank 09 → `saved_cms_mismatch`.

**Verification:** EC2 remote tests pass; the runner source picks `udfchar09` through the lookup; there is no path where Send Mail is ticked while 09 is blank.

**Size:** ~180–260 product lines.

### U2. New-booking agency rate prefetch (L2)

**Goal:** when a HRDAV mail is triaged as a new booking, Nava binds the party and reads the agency-entitled rates before staff open the pane. The card defaults the rate plan from that read.
**Scope correction (code scan 2026-10-28):** rate preparation on ingest has admitted new-booking mail since #349 (`hms-jobs.ts` `scheduleQuotePreparationForExtraction` → `quote-ready.ts` `quotePrepareKindReason`). Prepared runs already pass the bound V2 party as travelAgencyID/organizationID (`staff-quote-run.ts` → `partyRateContext` → `fetch-quote.mjs`). [prefetch-parity](../research/2026-10-27-next-run/prefetch-parity.md) claims booking gets no prep; that is true only for availability prefetch. The real gaps are smaller:

| Gap | Where | Lines |
|---|---|---|
| V2 party result has no `propertyCode`, so the pane picker refuses it on a property pane. Pane parties then never match the party-bound prepared run, and the agency rate never hydrates. | `apps/server-pilot/src/hms/hms-jobs.ts` V2 party result build | 5–15 |
| Booking card puts `room.request.ratePlan` before `quotedRateCode` | `apps/mail/components/quote-workflow/booking-card.tsx` ratePlan line (U3 owns; one line) | 1–3 |
| Prepared run matches the pane only on equal `salesStrategy` + `parties`. Pane default BAR/Government means only the BAR shop matches. | `apps/mail/lib/quote-workflow/staff-quote-bind.ts` run match | 20–40 |
| Agent voucher references in `payload.confirmationNumbers` block prep | `apps/server-pilot/src/ai/quote-ready.ts` refuse only HMS-shaped confirmations | 5–8 |
| HRDAV draft options default to HRCEN lists | `apps/server-pilot/src/ai/booking-draft.ts` `createRequestFieldOptions` | 10–20 |
| HRDAV rate policy: HRDAV needs `ratePolicyByOwnerRef` and a non-empty corpus, or it fails `staff_quote_policy_scope_invalid` | prod config, no code | 0 |

**Files:**
- `apps/server-pilot/src/hms/hms-jobs.ts`
- `apps/server-pilot/src/ai/quote-ready.ts`
- `apps/server-pilot/src/ai/booking-draft.ts`
- `apps/mail/lib/quote-workflow/staff-quote-bind.ts`
- **Not** `fetch-quote.mjs`: the `wt-avail` lane owns it.

**Tests:**
- `apps/server-pilot/tests/quote-ready.test.ts`
- `apps/server-pilot/tests/hms-party-job.test.ts`
- `apps/server-pilot/tests/booking-draft.test.ts`
- `apps/mail/tests/staff-quote-bind.test.ts`
- `apps/mail/tests/party-picker-results.test.tsx`

**Approach:**
- Add `propertyCode` from the read target to the V2 party result.
- Let a party-bound prepared run hydrate when its party matches the pane's bound party, whatever the pane's default strategy.
- Narrow the confirmation-number refusal to HMS-shaped numbers.
- **Preflight (coordinator, no code):** check `/proc` on all 4 procs for `HMS_DAVINCI_READS`, `HMS_DAVINCI_MAKE_QUOTE`, `HMS_QUOTE_PREPARE` and `PARTY_MATCH_V2`, and that the HRDAV staff-quote config has a rate policy. A flag flip needs the owner's go in chat.
- **Default rate plan:**
  - Use the agency's contract rate when the party is bound.
  - Otherwise use BAR B&B.
  - If neither is ready, leave it empty, labelled "rates loading".
- Make `createRequestFieldOptions` return the HRDAV rate-plan list from the profile. It must not default to HRCEN when the property is known.

**Test scenarios:**
- A new_booking mail on HRDAV with a bound agency → a prefetch job is enqueued with that agency id.
- An OTA/no_action mail → no job.
- A quote mail → unchanged behaviour (regression).
- HRDAV draft options → contain HRDAV rate plans and room types, not Centurion codes.
- A prepared result with the contract rate → `group.rateCode` = contract code; no prepared result → rate plan empty, not BAR-guessed.

**Verification:** EC2 tests pass; a shadow read on one historical HRDAV new_booking returns rates for the bound agency. This is read-only, under the HRDAV lock.

**Size:** ~40–90 product lines (was 80–150 before the scan).

### U3. Pane booking card in Infor order (L3)

**Goal:** staff see and can edit every field in HMS staff order, with children bookable and the CMS block always filled.
**Files:**
- `apps/mail/components/quote-workflow/booking-card.tsx`
- `apps/mail/lib/quote-workflow/pane-stay-bind.ts`
- `apps/mail/lib/quote-workflow/reservation-note.ts` (template only if needed)

**Tests:** these files assert the UI, so the lane must update them.
- `apps/mail/tests/booking-card.test.tsx`
- `apps/mail/tests/booking-card-reload.test.tsx`
- `apps/mail/tests/confirmation-recipient.test.tsx`
- `apps/mail/tests/quote-workflow-luna-render.test.tsx`
- `apps/mail/tests/nava-pane-render.test.tsx`
- `apps/mail/tests/requirement-card.test.tsx`

**Approach:**
- **Per-room order:**
  1. Primary booking agency (picked party, with an HMS id)
  2. Guarantee type
  3. Room type (select, from `draft.options`)
  4. Rate plan (select, defaulted by U2)
  5. Adults + child ages
  6. Guest name
  7. Source of business / track / market segment / Terms
  8. Reservation note
- **CMS block at the top of the card:** Send Mail ✓, Message Id select (01/03/08, from profile; default from the agency rule) and booker email.
- **Remove the child-room gates:** the Book button, the `bookableRooms` filter, the "enter in HMS for now" copy and the Book-all bar exclusion.
- **Fix the required-field bug:**
  - Map each required name to its value and only flag blanks.
  - Show the real field label.
  - For HRDAV, market segment and Terms show as required.
- **Removed:** no Centurion room/rate fallback when the property is HRDAV.

**Test scenarios:**
- An HRDAV card renders fields in the order above; the CMS block shows `03` when the agency is bound and `01` when there is none.
- Staff change the Message Id to 08 → the stay input carries `08`.
- A room with ages [5] shows Book and sends `childAges: [5]`.
- Required market segment filled → no "required hotel field" warning; blank → named warning, Book disabled.
- 2 rooms → 2 Book buttons; "Book this stay" books both in turn and shows Booked 2 of 2.
- An HRDAV card never shows Centurion room codes.

**Verification:**
- EC2 tests pass.
- Webmail viewer run on the deployed bundle.
- An nginx load of the new pane bundle after the deploy (pane pass bar).

**Size:** ~200–300 product lines.

### U4. Live proof (coordinator)

**Goal:** one real Faith email edited to Labtest becomes 2 HRDAV bookings with every field right, and the letter arrives.
**Dependencies:** U1, U2, U3 merged and deployed.

**Input:**
- A real historical Faith new-booking email with an agency, 2 rooms and 1 child.
- Guest renamed "Proof Labtest", dates moved to 2027, recipient navaai@legacyhotels.co.za.

**Pass (all must hold):**

| # | Check | Read from |
|---|---|---|
| 1 | 2 bookings, 1 per room | HMS find by Labtest |
| 2 | Agency `ta1` bound to the right party; rate plan = agency rate | HMS readback |
| 3 | Children banded right | HMS child1/2/3 |
| 4 | Guarantee type and market segment as chosen | readback |
| 5 | Reservation note filled | readback |
| 6 | CMS Send Mail ✓, Message Id `03`, booker email = navaai@ | readback + screenshot |
| 7 | Letter received in navaai@ | mailbox read |

**Rules:**
- Max 2 attempts.
- On the 2nd failure, write a DOM diagnosis from the screenshot and stop.
- Cleanup cancel must never accept the penalty dialog.

---

## How we run it (worktrees, Orca, models)

| Lane | Orca worktree (new, from `origin/main`) | Coder | Owns |
|---|---|---|---|
| L1 | `hrdav-book-write-20261028` | Claude Code `--model claude-fable-5-1 --effort xhigh` (Terra) | U1 files |
| L2 | `hrdav-book-rates-20261028` | same | U2 files |
| L3 | `hrdav-book-pane-20261028` | same | U3 files |
| Coordinator | this chat (Opus) | | contract, diffs, merge, deploy, U4 |

**Do not touch:**
- `recover-parse-failure` Pomerado terminal: it holds the HRCEN browser.
- `dv-amend` (#651, `amend-stay*.mjs`).
- `wt-avail` (`fetch-quote.mjs`).
- Pane demo worktrees: they only touch `apps/mail/prototypes/`.

**Cleanup before start:** close the idle census and email-pairs worktrees.

**HMS:** only U4 and the U2 shadow read touch HRDAV, through its own lock. Pomerado stays on HRCEN, so there is no shared browser.

**Gates per lane** (run in parallel, in the background):
- Remote typecheck on EC2.
- Targeted EC2 tests.
- `greptile review` against fresh `origin/main`.
- Coordinator reads the diff.

**Merge order:** L1 → L2 → L3. L3 rebases onto L1's contract if it changed.

**Deploy:** one deploy via `apps/server-pilot/deploy/ops-deploy.sh` from a clean `recover-parse-failure`. Record the last-good SHA first.

## ETA

| Part | Minutes | Basis |
|---|---|---|
| 3 lanes in parallel | 75–110 | Field PRs took 15–43 min each (#587, #590, #593, #636); code-server ledger median 0.85 |
| Gates + coordinator review | 20–30 | Apex ~3 min, remote typecheck 25 s |
| Deploy | 15–30 | Measured 13–30 |
| Live proof (≤2 tries) | 30–60 | Labtest saves took 20–34 |
| **Total** | **140–230** | Past overnight runs ran 2.8× over → bad case ~7 h |

## Risks

| Risk | Mitigation |
|---|---|
| Message Id lookup behaves differently on Save (code typed vs picked) | Pick through the dialog; read it back after Save |
| Agency lookup returns several rows | Refuse `agency_not_unique`; staff pick in the pane |
| Prepared rates are slow (3–82 s observed) | Pane shows "rates loading"; Book is disabled until the rate plan is set |
| Letter still not sent with 03 set | Check the HMS CMS Message List / Sent Email for that booking, read-only |
| The `recover-parse-failure` deploy tree is dirty (other chats' docs) | Deploy from a clean checkout of that path, or ask before stashing |
| Outlook surface unseen tonight | Webmail proof tonight; Outlook bundle load in the morning |

## Out of scope (deferred)

- Centurion create (Pomerado owns the HRCEN browser).
- Payment-proof letters 012/014 and online check-in 05.
- Amend/cancel (#651 lane).
- Splitting `booking-card.tsx`.
- Real-guest writes: `PANE_WRITE_CREATE` stays `lab`.

## Open question (default taken)

- **How the edited Faith email gets into the pane.**
  - Default: the owner forwards the edited email to Faith's HRDAV mailbox, so it is ingested as HRDAV.
  - Avoid navaai@ for this: it is the BCC collector with no hotel, so the pane would not know the property.
  - Alternative: a DB-side copy of the message row with the guest swapped to Labtest.

## If we finish early (ROI order)

1. **Golden-set field score.** Use `find-batch.mjs` on ~30 real HRDAV staff bookings (523 confirmation numbers are ready) to compare Nava's prefilled fields against what Faith actually saved, field by field. This is the PRODUCT.md "done" metric, and it shows which defaults are still wrong.
2. **Outlook surface proof.** An nginx bundle load plus one Outlook pane open on the new card.
3. **Provisional quote = this flow.** A 01/03 provisional booking with a payment link *is* the HMS quote. Check one quote-class Faith mail end to end through the same Book path.
4. **Centurion parity prep** (code only, no HRCEN browser): the HRCEN profile `cms` block and an HRCEN unit test; the live canary waits until Pomerado frees the HRCEN browser.
5. Split `booking-card.tsx` (no behaviour change).

## End state vs 10/10

| Dimension | After this run | 10/10 |
|---|---|---|
| Hotels | Da Vinci | Da Vinci + Centurion + next hotel from a profile |
| Booking fields | All staff fields, CMS 01/03, children, agency pick | Same, scored ≥95% field parity on a golden set |
| Letter | 01/03 sent by HMS, proven once | Proven on every create; failures shown to staff |
| Rates | Agency-entitled default when prepared | Ready before the pane opens on ≥90% of mails |
| Proof | 1 hard live Labtest + webmail | Golden-set score + Outlook + live staff use |
| Real guests | Off (`lab`) | On, after the owner's go |
| Amend / cancel / payment proof | Not in this run | All four workflows |
