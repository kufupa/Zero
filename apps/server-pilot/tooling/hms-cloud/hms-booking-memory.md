# HMS booking memory

`hms-booking-memory.mjs` exports `buildHmsBookingMemory`, `loadHmsBookingMemory`,
and `queryHmsBookingMemory`. The former `playwright-quote/hms-booking-memory.mjs`
path re-exports the same functions. Node 22 is required.

Inputs, the returned memory, and detailed query results are private: they can
contain guest, address, booking, and message identifiers. Do not log them or
commit them. Build one memory per property; the caller must partition inputs
without a declared `propertyCode` before loading them.

`loadHmsBookingMemory({ propertyCode, pmsPath, outboundPdfPath })` reads a PMS
snapshot JSON and message/PDF JSONL. `pmsPaths` and `outboundPdfPaths` accept
multiple files. Outbound files are optional. `buildHmsBookingMemory` also accepts
the existing `pmsSnapshot`, `pmsSnapshots`, and `outboundPdfRecords` inputs and
`messageRecords` for explicitly directed inbound or outbound messages in the
same record format. Its result is JSON-serializable and can be retained for
repeated queries.

To extend memory with a later verified PMS observation, append another private
snapshot using `pmsSnapshots` or `pmsPaths`. Keep its actual source-of-business
field, observation date, `sourceType`, and any `result.provenance`; do not
fabricate a PMS read. Newly supplied evidence is caller-verified, and staff
feedback is not automatically collected or learned.

Confirmation numbers can identify more than one stay. If a confirmation is
repeated across inputs, every observation must include the same caller-verified
`result.provenance.verifiedStayId`; otherwise the build fails closed. Partition
distinct stays that share a confirmation into separate inputs or resolve their
identity before combining them. Do not infer a stay ID from contact details.
This safety correction prevents histories from being silently mixed.

The hint counts below use **distinct observed confirmations**, not independently
verified stay IDs. Matching native confirmation fields corroborate the sampled
read, but do not establish global uniqueness. The lookup may have reported
multiple matches. No stay ID is fabricated from a confirmation, guest, or contact.

## Queries and roles

Search using a string or `{ email }`, `{ domain }`, or `{ name }`. Address
matching is exact and case-insensitive; domain searches do not include
subdomains. Name searches cover agency, contract, organization, and A/R.

For an address query, pass `role` in the query or options:

- `outbound-recipient`: the historical outbound To, Cc, or Bcc address.
- `outbound-sender`: the historical outbound sender.
- `inbound-sender`: a sender on a record explicitly marked inbound.

For compatibility, an omitted role selects **outbound-recipient** and returns
`roleDefaulted: true`. Every address result states its selected `role`; roles
are never combined. An outbound recipient is not evidence of an inbound sender.
The supplied PDF corpus is outbound, so it does not establish general inbound
sender history. Inbound matches require separately supplied inbound records;
guest-profile addresses and linked outbound recipients are not promoted to
inbound senders.

`options.sourceOfBusiness` accepts one label or an array of `E-Mail`,
`Voice Call`, and `Call Center`; the default is all three. The filter applies
to observations, candidates, conflicts, and query counts. Each observation
retains its actual source. Result and candidate `sourceOfBusinessCounts` count
distinct confirmations per source; a confirmation observed under multiple
sources may appear in more than one count. `linkage.pmsSourceCounts` counts
loaded PMS observations before the query filter, including repeated reads.

The default candidate and conflict limits are 25; `limit` and `conflictLimit`
are capped at 200. `includeEvidence: true` (or `includeDetail`) returns private
evidence; `evidenceLimit` defaults to 20 and is capped at 100 per list.
Nested evidence lists are also limited. A confirmation record or conflict
evidence reports `truncated` and maps each truncated list's path to its full
count in `nestedEvidenceTruncations`. Counts deduplicate confirmation support,
not evidence records. Counts and ordering are historical evidence, not an
automatic choice, proof of identity, or proof that an HMS selection is currently
valid.

## Historical rate, room and guarantee hints

Every query returns separate `historicalHints.ratePlan`, `.roomType`, and
`.guaranteeType` frequency lists. They summarize all selected-source observations
for the matched confirmations, including later observations, independently of
the party combinations. They are not a mapping between a party, rate, room,
or guarantee and do not select a value. Historical values do not prove current
availability, rate eligibility, or guarantee requirements.

Each value includes distinct `confirmationCount`, `pmsObservationCount`,
`sourceOfBusinessCounts`, and its field sources. One confirmation can support
multiple values, including conflicting values or values observed at different
times; source counts can overlap. For address queries,
`uncertainLinkConfirmationCount` identifies confirmations with an uncertain
matching address link. The existing role and link-provenance rules still apply.
The three dimensions are never combined into a cross-product.
Frequency values normalize whitespace and group case-insensitively using NFKC;
private evidence retains the original field-source values.

For hint counts, the input confirmation must match Record View's native
`confirmationInRecord` and Stay 360's native `confirmationInHeader`, the
Record View tab must be active, and the Stay 360 read must have succeeded.
A conflicting echoed confirmation also excludes that observation. The
`identityCoverage` counts excluded missing, mismatched, or unverified reads,
reported multiple-match selections, complete, incomplete and unknown lookup
completeness, and supplied `verifiedStayId` values. These counts can overlap
across observations. An unknown lookup is not known to be complete. A missing
multiple-match flag does not prove the confirmation is globally unique.
Lookup completeness is the reader's reported result coverage within its
searched date range, not global uniqueness; the range is retained in private
evidence when supplied.
For a name query, at least one name-matching observation must meet these native
confirmation checks. For an address query, a matching address link must point
to such an observation. Matches without this anchor are counted in
`unverifiedMatchConfirmationCount`; their hint coverage is unknown. This check
does not make an attachment or confirmation-candidate link independent proof.
The multiple-match signal and selection description come from
`result.stay360.matchSelection`; the description is retained in private
evidence. A reader's hint-based selection is not an independently verified
unique stay ID.
Repeated confirmations still require the existing shared caller-verified stay ID.

Each field's `coverage` distinguishes an observed blank (`""`) from a missing
field and an unavailable value (`null`). Missing and unavailable field-source
counts identify Record View and Stay 360 separately; `conflictingConfirmationCount`
includes different known values, including blank versus nonblank. Coverage
categories can overlap across sources and observations. Older memories without
hint fields return empty lists and report unknown historical coverage.
An absent or non-array field collection is an unknown source, not a missing
field. A partially captured card collection also reports that source as unknown
while retaining values from the cards that were captured. `missingFieldSourceCounts`
only counts eligible captured collections lacking the label; `unknownFieldSourceCounts`
counts uncaptured or partial collections even when identity is unverified, and
`unavailableFieldSourceCounts` counts eligible observations with present labels
whose values are unavailable. `unknownFieldConfirmationCount` also includes
observations lacking hint data or eligible identity evidence.

`hintLimit` defaults to 25 and is capped at 200 values per dimension; each list
reports its full `valueCount` and `valuesTruncated`. Values longer than 256
characters are truncated with `valueTruncated`, full length and SHA-256 so
distinct values with the same prefix remain distinguishable. With `includeEvidence`, each
value includes bounded private confirmation records, observation timestamps,
source-of-business, native identity status, original field-source values, and
matching address-link provenance. The existing `evidenceLimit` applies to each
list; nested string truncations report the full length by path. `recordView`
and `stay360` field sources correspond to `recordView.details.fields` and
`stay360.details.cards[].fields` respectively.

## Evidence and compatibility

A party value of `""` is an observed blank; `null` is unknown or ambiguous.
Conflicting record-view and Stay 360 combinations remain distinct; missing
fields are not filled across conflicting views. Conflicting duplicate labels
are reported in detailed `fieldConflicts`, with the affected value left
unresolved instead of inventing a combination. Across snapshots, a missing
value and a later known value remain distinct but do not count as a conflict;
different known values, including an observed blank, do.

An `attachment-id` link inherits the upstream PMS-to-PDF association; it is
not independent proof. `confirmation-number-candidate` is a fallback only when
the PDF has exactly one candidate. Detailed `linkProvenance` records whether
the linked confirmation matches a labeled PDF candidate, a recognized filename
or subject candidate, whether a recognized subject candidate conflicts, and
the upstream snapshot's aggregate PDF evidence. `ambiguousAttachment` flags
an attachment associated with multiple in-scope confirmations or supplied
message records; it cannot rule out collisions outside the loaded scope.
Overlapping exports of the same message are deduplicated while retaining their
distinct `sourceSnapshotIds`; conflicting copies of a record ID are rejected.
A `null` match means no candidate was available for that check. These are
source-quality signals, not independent identity verification. Candidate
`uncertainLinkRecordCount` counts confirmation-only links, ambiguous
attachments, missing or conflicting labeled matches, and conflicting subject
candidates.

Safety corrections to the old query: address roles are no longer mixed, and
confirmation matching preserves case and punctuation instead of silently
merging differently formatted identifiers. `sourceOfBusinessFilter` now lists
the selected labels instead of saying only `E-Mail`. The old
`excludedNonEmailPmsResultCount` is a deprecated alias for
the count outside the three-source cohort. `ignoredNonOutboundRecordCount` is
replaced by `ignoredUnrecognizedDirectionRecordCount`, since valid inbound
records can now be retained.
