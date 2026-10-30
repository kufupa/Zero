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

## Evidence and compatibility

A party value of `""` is an observed blank; `null` is unknown or ambiguous.
Conflicting record-view and Stay 360 combinations remain distinct; missing
fields are not filled across conflicting views. Conflicting duplicate labels
are reported in detailed `fieldConflicts`, with the affected value left
unresolved instead of inventing a combination.

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
`uncertainLinkRecordCount` counts records with an ambiguous attachment,
missing or conflicting labeled match, or a conflicting subject candidate.

Safety corrections to the old query: address roles are no longer mixed, and
confirmation matching preserves case and punctuation instead of silently
merging differently formatted identifiers. `sourceOfBusinessFilter` now lists
the selected labels instead of saying only `E-Mail`. The old
`excludedNonEmailPmsResultCount` is a deprecated alias for
the count outside the three-source cohort. `ignoredNonOutboundRecordCount` is
replaced by `ignoredUnrecognizedDirectionRecordCount`, since valid inbound
records can now be retained.
