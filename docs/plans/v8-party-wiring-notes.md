# v8 party picker: wiring notes

Branch `feat/v8-party` supersedes PR #48 (`origin/feat/luna-v5-b`). It ports the party search and fixes the runner. It
does not touch `outlook-pane/page.tsx`, `quote-workflow-panel.tsx`, `session.ts` or `staff-quote-workflow.ts`, which other
lanes are editing. Until the wiring below lands, the picker is not shown and no quote sends a `party`.

## 1. Ready on this branch (no wiring needed)

- Server route `panePartyLookup.findParty` takes `{ name }` (strict). It returns
  `{ outcome, results: [{ kind: 'company'|'agency', nativeId, name }], truncated }`. It runs one HMS lookup per kind
  (company, then agency) under the property lock, and merges them. Refused under `QUOTE_RATE_CONTEXT=off`.
- `apps/mail/lib/quote-workflow/party-lookup.ts`: `partyFinderFromTrpc(trpcClient)` returns a `PartyFinder`
  `(name) => Promise<PartyFindReply>`, or null when the route is missing. Also `partyNoCandidateNote`,
  `PARTY_TRUNCATED_NOTE`, `partyChipText`, `partyKindLabel`.
- `apps/mail/components/quote-workflow/party-picker.tsx`: `PartyPicker({ name, party, find, onPick, onClear })`. One
  Find in HMS button covers both kinds. Each candidate shows its kind. A picked party shows as a chip with Clear.
- `apps/mail/lib/quote-workflow/types.ts`: `StaffQuoteParty`, and `StaffQuoteHeader.party?`. An absent party means
  public rates, as before.
- `apps/mail/lib/quote-workflow/staff-quote-bind.ts`: `ExecuteStaffQuoteInput.party?`. The bind sends `party` only when
  `header.party` is set.
- `apps/server-pilot/src/ai/quote-rate-switch.ts`: `quoteRateContextEnabled()`. It moved out of `staff-quote-workflow.ts`,
  which #48 imported it from.
- `apps/server-pilot/src/ai/reservationist-business-services.ts`: from #48. It reads `staffApproval.rates`. When that is
  absent, party lookup runs as it did before.
- `apps/mail/lib/trpc-request-timeout.ts`: 6 minutes for `panePartyLookup.findParty`.
- `apps/server-pilot/src/ai/party-aliases.ts`: `suggestPartyFromSender(sender)` and `extractPartyMentions(body)`. Not
  called anywhere yet.

## 2. Wiring for `outlook-pane/page.tsx` and `quote-workflow-panel.tsx`

Source for the #48 versions: `git show origin/feat/luna-v5-b -- <file>` (diffs from merge-base 0fe5c894).

1. `page.tsx`: import `partyFinderFromTrpc` from `@/lib/quote-workflow/party-lookup`. At module scope, next to
   `PANE_STAY_CLIENT`, add `const PANE_PARTY_FINDER = partyFinderFromTrpc(trpcClient);`. Pass
   `findParty={PANE_PARTY_FINDER}` to `<QuoteWorkflowPanel>`.
2. `quote-workflow-panel.tsx`:
   - Add a `findParty?: PartyFinder | null` prop to `QuoteWorkflowPanel` and to `StaffHeaderFields`. Pass it through.
   - Render ONE `<PartyPicker>` (#48 used two, one per field, and that no longer applies). Put it under the Agency
     field. Props: `name={header.company.trim() || header.agency.trim()}`, `party={header.party}`, `find={findParty}`,
     `onPick={(party) => onPatch?.({ party, ...(party.kind === 'company' ? { company: party.name } : { agency: party.name }) })}`,
     `onClear={() => onPatch?.({ party: undefined })}`.
   - On the Company and Agency `onChange`, drop the pick when the typed text no longer equals `party.name`. #48 did this
     per field: `...(header.party && header.party.kind === 'company' && value !== header.party.name ? { party: undefined } : {})`.
   - Render the picker only when `findParty` is non-null. Otherwise the header stays plain text.

## 3. Quote path: needed before a picked party changes any quote

Not on this branch. These sit in `staff-quote-workflow.ts` and `workstation.ts`, which are out of bounds for this lane.
Source: `git show origin/feat/luna-v5-b -- apps/server-pilot/src/ai/staff-quote-workflow.ts` (+89 lines) and the
`executeStaffQuote` hunk in `apps/server-pilot/src/trpc/routes/workstation.ts`.

- `staffQuoteInput` is `.strict()`. Add `party: z.object({ kind: z.enum(['agency','company']), nativeId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), name: z.string().min(1).max(256) }).strict().optional()`.
  Without it, the bind's `party` key is rejected. That only happens once a party is picked.
- Import `quoteRateContextEnabled` from `./quote-rate-switch.js`, not from the workflow file.
- Add the rate-context helpers: `StaffQuoteRates`, `partyRateContext`, `isPartyRateFailure`, `partyRateFallbackNote`,
  `quoteWithPartyFallback`, and `prepareStaffQuote(..., rates = 'party')`. Its approval object sets `rates`.
- `workstation.ts` `executeStaffQuote`: wrap the quote in `quoteWithPartyFallback` and carry its `note` into
  `extrasReviewItems`. This hunk does not compile without the helpers above, so it was not ported.

## 4. Session

`patch_staff_header` already merges any header field, so `party` passes through. `emptyStaffQuoteHeader()` has no
`party` key. `session.ts` needs no change for the picker.

## 5. Contract changes from #48 (for the wiring lane)

- `findParty` input: `{ name }`. There is no `kind`. The reply uses `results[].name`, not `displayName`. There is a new
  `truncated` flag.
- `PartyPicker` props: no `kind`. The copy says "about a minute", because the search runs two HMS lookups.
- Runner output (`party-lookup.mjs`) keeps `candidates[].displayName`, because `quote-contract.mjs`, the agent
  `party_lookup` tool and `staff-quote-installation.ts` read it. It adds a `truncated` boolean. The schema is updated.
- A filter that did not reach the HMS window now returns `execution_failure` with
  `issues[].reason = 'filter_not_applied'`. Before, the unfiltered grid could come back as `no_match`.
  `staff-quote-installation.ts` calls `lookupParty` in-process and throws `staff_quote_party_invalid` for any outcome
  other than `resolved`, `ambiguous` or `no_match`. That code is in #48's `PARTY_RATE_FAILURE_CODES`, so once section 3
  lands, a picked party falls back to public rates with a review note. Before this change, a filter miss could read as
  `no_match` and quote at BAR with no party.

## 6. Open items

- Live HMS checks are for Opus. The runner's DOM flow changed in three places: the filter is read back before Run, every
  kind waits for the store, and a 50-row store is marked truncated.
- Sender aliases: nothing calls `suggestPartyFromSender` or `extractPartyMentions` yet. Wire them as a text hint that
  pre-fills the query. Never set `party` from an alias. Only the aliases with `idStatus: 'listed'` carry an HMS id. The
  rest have `nativeId: null` and need Find in HMS.
- Listed ids in `party-aliases.ts`: CWT JNB 290, Nexus 27, 360 degrees Travel 113, Tourvest 206. The others are
  unverified.
