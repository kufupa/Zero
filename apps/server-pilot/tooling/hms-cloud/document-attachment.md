# Cloud document attachment

`attachLabtestDocument(page, expected, file, options)` attaches one explicitly supplied file to an already-open HRCEN Proof Labtest stay. The current implementation intentionally refuses real guests and is not an authorization to enable real-guest writes. `expected` is the saved-record identity accepted by `currentLabtestRecord`; `options.expectedOrganization` is required when the verified record includes an expected organization.

Create the page with `withCenturionStay360Page(..., { blockServiceWorkers: true })`, then use the existing shallow and record readers. The context must own one page and have service workers blocked before page creation. Provide an absolute, private `evidenceRoot` directory with no group or world permissions. Each action creates its own private evidence directory, saves before/after screenshots, and records dispatch intent before the upload can leave the browser.

Supply `file.name`, `file.documentCode`, `file.description`, `file.mimeType`, and `file.bytes` as a Buffer. The file name is a simple basename, the code is uppercase, and the byte limit is 10 MiB. The adapter copies the Buffer, binds the native check and upload to the verified stay, current session token, exact child frame, selected file and bytes, and allows only a matching Documents refresh. It leaves its request fences installed until the page closes. Do not reuse the page for another write.

- `not_dispatched` means no upload was released by this adapter. A validation request may still have reached HMS.
- `awaiting_readback` means the upload and matching refresh received HTTP 200 and no blocking UI or unexpected request was observed. It is not proof of persistence or stored-byte equality.
- `uncertain` means an upload may have reached HMS but its outcome is not established. Never retry it blindly.
- Independently re-open and verify the same stay in a fresh session after any possible dispatch. Compare metadata and stored bytes separately when a verified read method is available. A loaded tree, including an empty tree, does not establish complete coverage.

The current live discovery verified one earlier synthetic file's metadata and bytes. It did not establish the prior dialog's cause, complete tree coverage, or general support for every property, document type or HMS version. No email, cancellation, payment or real-guest action is included.
