# v8 party picker and contract rates: wiring notes

Branches: `feat/v8-party` (PR #61) ports the party search and the runner fixes. `feat/v8-party-rates` (stacked on #61)
adds the quote path, the panel header and the suggestions. This file lives on `feat/v8-party-rates`.

## 1. What is wired now

- Panel header (`quote-workflow-panel.tsx`): when `findParty` is passed to `QuoteWorkflowPanel`, a `PartyPicker` shows
  under each field. The Company picker searches the Company text and holds only companies; the Agency picker searches the
  Agency text and holds only agencies. Each keeps its own results, pick and suggestions, and a pick sets `header.parties`
  and its field's name. Editing a field away from its picked name drops that pick. Without `findParty` the header stays
  plain text.
- Quote path (`staff-quote-workflow.ts`, `workstation.ts`): `staffQuoteInput.parties` (company and/or agency, plain HMS
  ids). The route re-checks each picked id in HMS before the quote lock (`verifyPartyPick`). A pick HMS does not return
  is refused. With `QUOTE_RATE_CONTEXT=off` nothing is looked up and the quote is public, with a review note.
- Rate context: `partyRateContext` sends `organization` for a company and `agency` for an agency, both when both are picked.
  Nothing else (no commission, no A/R account) reaches the request.
- Contract rows: `partyContractChoice` (business services) offers only HMS-flagged rows (`rateScope === 'contextual'`,
  from `isNegotiatedRate`). With none flagged it offers the public BAR rows. Rate names never decide.
- No contract: `partyContractReviewNote` adds "No contract rate found for <party>; this quote uses our best available
  rate." to the review items. A fallback to public rates after an HMS pricing failure gets its own note.
- Suggestions: `panePartyLookup.suggest({ sender, body })` (read-only) returns sender-alias and body-name suggestions.
  Only a listed alias id is attached. A body name never has an id.

## 2. Still to wire (`outlook-pane/page.tsx`, not edited here)

The page owns the tRPC client and the selected email, so it must:

1. Bind the finder once at module scope, next to `PANE_STAY_CLIENT`:
   `const PANE_PARTY_FINDER = partyFinderFromTrpc(trpcClient);` and pass `findParty={PANE_PARTY_FINDER}` to
   `<QuoteWorkflowPanel>`.
2. When the selected email changes, call `partySuggesterFromTrpc(trpcClient)?.({ sender, body })` and keep the result as
   `partySuggestions` (`reply.suggestions`). Pass it to `<QuoteWorkflowPanel partySuggestions={...}>`. Do not pick
   anything from the result: staff click "Use" for a listed id, or search an unverified name.
3. Bind the typeahead once, beside the finder: `const PANE_PARTY_INDEX = partyIndexFromTrpc(trpcClient);` and pass
   `partyIndex={PANE_PARTY_INDEX}` to `<QuoteWorkflowPanel>`. Without it, or without the index file, the picker shows only
   the live search.

## 3. Contract to keep (for the wiring lane and reviewers)

- A picked id is always re-checked. `verifyPartyPick` binds HMS's own id and name. The quote validator compares the
  name HMS reports, so the client's text never decides it.
- Both ids go in one request. The Rate Shop applies organization and agency together.
- Contract = `rateScope 'contextual'` only. A row named after the party but not flagged (for example NGD10B "Woolworths"
  for org #49) is never offered as a contract, however cheap.
- The public rows (`BAR`, `BARRO`) are offered only when no row is flagged.
- Rates change nothing else: commission and A/R are not read or written by the quote.

## 4. Live checks (Opus lane)

- Org #49 (Woolworths): flagged rows BCO1B and NCOR2B. Agency #569: flagged WSF2B and BWS2B. Agencies #113, #290 and #27
  have no flagged rows, so their quotes price BAR with the note.
- Confirm the picked-id re-check and the Rate Shop criteria read back both `organizationID` and `travelAgencyID`.
- The "New Record" click in `party-lookup.mjs` predates this work; check it on the live form.
- Index (section 7): after the sweep, type a name HMS has, check the matches and the age label, pick one, and confirm
  the quote re-checks the id before it binds.

## 5. Changes from #48 (for the wiring lane)

- `StaffQuoteHeader.party` is gone. It is `parties?: { company?, agency? }`. The bind sends `parties` only when a pick
  with a plain HMS id exists, so an unverified suggestion is never sent.
- `PartyPicker` props: `name`, `parties`, `find`, `onPick`, `onClear(kind)`, `suggestions?`, `onSearchName?(name, kind)`.
- `findParty` input is `{ name }`. The reply is `results[].{kind,nativeId,name}` plus `truncated`.
- Options carry `rateScope` (`public` | `contextual` | `unknown`). Fixture options in
  `reservationist-business-services.test.ts` now carry it, as the runner emits it.
- `StaffQuoteInput.parties` is `.strict()` at both levels. A stale client that still sends `party` is rejected, by design.

## 6. Open items

- A filter read-back, a settled grid and the row check are proven only against a fake page. The live run confirms them.
- The kill switch gates the quote path now. The header still shows Search HMS now when the switch is off, and the picker
  says rates are not checked.
- Lookup timeouts: the per-run bound is 150 s, two runs per search. A re-check at quote time adds one more run per picked
  kind, inside the 20 min quote deadline.

## 7. Party index: instant typeahead from the HMS list

- Build (EC2, operator only; no staff action): `pnpm -C apps/server-pilot exec tsx scripts/party-index-sweep.ts --delay-ms 20000 --max-runs 150`.
  It reads HMS one property-locked run at a time: A to Z per kind, then two-letter prefixes where a letter's grid was
  truncated. Run it again to resume. Exit 0 index written; 3 paused at `--max-runs`, run again; 4 stopped on a run that was
  not a clean answer, fix the cause (see the log) and run again; 2 configuration error. `--fresh` starts over.
- Output: `.private/pms-pipeline/party-index/party-index.json`, mode 600, beside its progress file. `PARTY_INDEX_PATH`
  chooses another file. The sweep never writes to HMS. The index is written only when the sweep completes.
- Typeahead: the picker asks `panePartyLookup.typeahead` 250 ms after typing stops. The server answers from the file
  only: top 10 per kind, accent- and case-insensitive, exact name first, then prefix, word start, containment.
- The matches show under "From HMS list (updated <age>)". After 7 days the heading adds ", may be out of date".
  "Search HMS now" still runs the live search.
- A pick from the list is a candidate only. The quote re-checks its id in HMS before any rate binds (`verifyStaffParties`),
  and an id HMS does not confirm is refused.
- No file: no matches section, and the live search works as before.
- Known limit: a two-letter prefix still truncated when the sweep ends cannot be listed further. The sweep reports how many
  remain, and those names need the live search.
