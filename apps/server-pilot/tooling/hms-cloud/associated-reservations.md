# Associated Reservations reader

`readAssociatedReservations(page, confirmation)` opens the Associated
Reservations tab of the already-open matching stay and returns its visible grid
columns and rendered rows, plus loaded/total counts and any handled notes. Use
it after `readShallow` and `readRecord`, on the same authenticated page.

This is a read-only module, separate from the Documents reader. A row may be
the current stay, so compare confirmation numbers before treating it as a linked
stay. `possiblyTruncated` flags count mismatches, but matching counts do not
prove completeness: `coverage.complete` and `refreshVerified` remain unknown
and false. Unrendered rows and unloaded pages are not captured.

A 60-stay Centurion sample found empty grids or the current stay only. This
reader has not yet been verified against a Centurion grid containing another
confirmation. Keep output private because it may contain guest information.

For a standalone read, provide JSON on standard input:

```sh
node apps/server-pilot/tooling/hms-cloud/read-associated-reservations-ui.mjs --json-stdin < /private/lookup.json > /private/result.json
```

The input can include `confirmation`, `guestName` and `arrivalDate`. The legacy
`playwright-quote/` module and CLI paths remain available as wrappers.
