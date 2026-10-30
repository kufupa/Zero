# HMS Cloud readers

`hms-readers.mjs` exports the composable Stay 360 readers. The
`read-confirmation-ui.mjs`, `read-record-view-ui.mjs`,
`read-guest-details-ui.mjs`, and `read-guest-form-ui.mjs` runners combine them
with the shared Centurion browser. Existing `playwright-quote/` imports and
runner paths, including their shorter aliases, remain supported.

Notes captured by the shared handler remain under the same private capture
root. Reader output can contain guest information; keep it private.
