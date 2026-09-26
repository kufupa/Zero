# Inbound attach to Guest Stay Documents (`hms_attach_guest_stay_document`)

Date: 2026-09-11. Scope for Direct HMS Sync (Nava thread → Infor Guest Stay Documents tab). Complements, does **not** replace, `docs/superpowers/plans/2026-09-10-last-tools-email-automation.md`.

No live writes. No PII. Antigravity chat claims are treated as hypotheses.

## Verdict

**Yes, catalogue this as a HITL write. Do not build it on the current Codex read-only lane. Do not treat it as a read. Do not use IDM/Ming.le or `/web/reservation/detail` as the Centurion target until live probe proves them.**

It is the **inbound inverse** of `mail.send_with_attachments` / HMS Email Documents:

| Direction | Tool | What staff do today |
|---|---|---|
| Outbound | generate/email folio, confirmation, quote; Nava SMTP | send PDF to guest/agent |
| Inbound | **this tool** | copy guest/OTA/voucher/POP file from mail onto the **Guest Stay Documents tab** so check-in/finance see it without Outlook |

`documents_list_existing` / `documents_read_existing` **read** what this would **write**. They are not the upload.

## Antigravity claims vs this repo + official HMS

| Claim | Status |
|---|---|
| `adapter.ts:65-76` already uploads / IDM REST | **Disproved.** That block is `HmsReadAdapter.findReservation` + `quoteStay` only (`apps/server-pilot/src/hms/adapter.ts:65-75`). |
| `centurion.manifest.json` Documents dropzone at `/web/reservation/detail` | **Half.** Fixture GET `/web/reservation/detail` exists (`centurion.manifest.json:133-147`). **No Documents tab, no upload rule, no multipart.** Live Guest Stay search is `/web/base/OSRESS.search` (`live-read-manifest.ts:19-20`). |
| `tenantId: HMS_LEGACY` | **Supported** in fixture binding (`centurion.manifest.json:6`). |
| `rawMimeS3Key` exists | **Supported** (`apps/server-pilot/src/db/schema/mail.ts` `raw_mime_s3_key`). |
| Already building attach on this branch | **Disproved.** Sep-06 plan PMS reads only. Zero `hms_attach_*`. `productionActiveReadToolIds()` empty. Runtime start canary **requires** `view_only` (`runtime.ts:1365-1368`). |
| IDM Ming.le right-rail dropzone is how Centurion attaches | **Disproved for this deployment until contrary live proof.** IDM in-context drag/drop + Outlook add-in are **Infor OS / Ming.le / IDM** products ([IDM user guide](https://developer.infor.com/tutorials/document-management.md); Outlook add-in uploads **to IDM**, not HMS Guest Stay). HMS_LEGACY + `/web/base/OSRESS.*` = standalone HMS web. |
| Folio has an Attachments dropzone for inbound .eml | **Disproved as primary.** Folio **Email Documents / Print Documents** send **outbound** folios ([working with folios](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html); [email folio params](https://docs.infor.com/hms/2026.08/en-us/hmsolh/msh1719480545520.html)). Not a receive-email dropzone. |
| Notes/traces store the .eml | **Disproved.** U15 notes = bounded text. |
| Official HMS upload UI | **Supported.** Generic **Documents tab** on pages that support documents: Create/Upload Document → Document Code + Description → Upload Document or create file-system doc → Save. ([Creating/Uploading documents](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428568335.html)). Guest Stay Documents tab is also where **generated** confirmation/folio/reg card land when `STORECONF` / `STOREFOLIO` / `STOREREGCARD` are on ([property parameters](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428546494.html)). |
| Chrome extension as equal default | **Reject as primary.** User wants Direct HMS Sync. Extension does not give idempotent audit in Nava. Keep as fallback only if Playwright upload form cannot be inventoried. |

## Where staff upload (ranked)

1. **Primary (official HMS):** Front Desk → Guest Stay → open stay → **Documents** tab → **Create/Upload Document** modal (code + description + file) → Save. Same tab also stores HMS-generated PDFs when STORE* flags on. Upload is **browse/file**, not documented as Outlook-to-grid HTML5 drop. Fluid “drag from Outlook into the grid” is **unresolved** (modal already open, or IDM if they actually have Ming.le, or OS-level drop into the file picker).
2. **Same Documents tab, link existing:** **Add a Document** links a file already in Administration → Setup → Documents. Second click-path, not a second store.
3. **Not folio inbound.** Folio email/print = send.
4. **Not traces.**
5. **IDM sidebar / Outlook→IDM add-in:** only if Centurion actually runs Ming.le+IDM. Current manifests do not. Treat as **unresolved / probably absent**.
6. **Guest profile Documents / passport scan:** different record (`P5SCANNEDDOCUMENT` / USESCANMANDATORY). Not reservation correspondence.

## Why 3949/420 undercount this

3949 = **Sent** gold. Attach-to-HMS happens on **inbound** (OTA amend, voucher, POP). Sent labels show staff already processed; they do not count “I also dropped the inbound .eml on Documents.”

420: mail-artifact **216** = Nava already holds inbound files (`mail_attachment` source). That is **read** (`mail_read_artifact`). It does **not** prove staff also copied those bytes into HMS. `hms_finalized_document` list is the check: if live list is empty while mail has the voucher, attach is the gap.

## Should we build it?

**Yes, as last-tools Wave 2b, HITL, after live reads + find.** Not instead of send/generate. Not on Codex’s read-only executor.

Reasons to build:

- Check-in/finance need the **source file on the stay**, not only in Nava mail.
- Completes U9: list/read HMS docs are useless if staff still drag by hand to populate them.
- Nava already has conf# parse, S3 `.eml`/PDF, `hms_find_reservation`. Missing piece is the **mutation**.

Reasons **not** to build **now**:

- Write. Needs `audited_write`, reviewed multipart rule, proposal/idempotency, live form inventory. Import script currently **refuses** `audited_write`.
- Live upload selector/path **unknown**. Fixture `/web/reservation/detail` is not live OSRESS.
- STORE* flags may already put generated PDFs on the tab; attaching inbound mail is a **different** payload (correspondence), not a substitute for `hms_generate_*`.

Chrome extension: only if live Create/Upload form cannot be automated safely. Not the default.

## Schema (closed) — `hms_attach_guest_stay_document`

Keep **out of** `READ_TOOL_IDS`. New write union next to July `mail.send_with_attachments` / `document.*`. Reuse write envelope: proposal → HITL approve → execute → reread.

```ts
// input (model-facing; no S3 keys, no raw MIME)
{
  reservationRef: OpaqueRef,          // from hms_find_reservation
  mailSource: {
    threadId: OpaqueRef,
    // exactly one:
    attachmentId?: OpaqueRef,         // preferred: voucher/POP/PDF already in mail
    includeRawEml?: boolean           // opt-in; default false (attach PDF, not whole .eml)
  },
  documentCode: PropertyDocumentCode, // closed vocab from Admin Documents, never invented
  descriptionDigest: string,          // short staff-visible label, no PII in logs
  idempotencyKey: string
}

// proposal preview
{
  proposalRef,
  expectedBefore: { reservationFingerprint, existingDocumentSha256s[] },
  file: { mime, sizeBytes, sha256, kindGuess: DocumentKind },
  target: { screen: 'guest_stay_documents', documentCode }
}

// execute
{ proposalRef, approvedOperationRef, idempotencyKey }

// outcome
applied | rejected | conflict | duplicate_prevented | unknown_outcome
```

**Denied:** generate confirmation, email folio, post payment, IDM REST, Guest Profile/passport scan, traces, CRS Check Availability.

**Reread gate:** `documents_list_existing` `{ source: 'hms_finalized_document', scopeRef: reservation }` must show new `documentRef` with matching sha256 or `unknown_outcome`.

**Idempotency store (private DB, not git):** `(mailbox_message_id | attachment_sha256, reservation_ref)` → skip duplicate.

**Credential:** `audited_write` session **only** for this tool; read path stays `view_only`. Fail closed if multipart path not in live manifest.

**DocumentKind** reuse U9 enum; add `correspondence` only if property Document Code maps to it — otherwise `other_existing` + required `documentCode`.

## Integration (high level)

1. UI: after find match, button **Attach to Guest Stay Documents** (HITL). Not auto on every thread.
2. Worker: read tool plan find → list existing HMS docs (dup check) → mail artifact bytes from S3 via existing locators → write adapter Playwright: Guest Stay → Documents → Create/Upload → fill code/description → file set → Save.
3. Manifest: live probe must capture the **real** upload POST (likely `/web/base/OSRESV.*` or Documents child), `multipart/form-data`, then add a reviewed rule. Do **not** copy fixture `/web/reservation/document/upload` from imagination.
4. Policy: `request-policy` already parses multipart but **unmatched** multipart → block. Need an explicit rule.
5. Place in last-tools order: Wave **2b**, after M1 send is designed (share HITL chrome) but can ship independently. Before money writes.

## 95 threshold

**Met:** write vs read; not built; official HMS Documents Create/Upload; adapter is read-only; IDM is a different product; folio email ≠ inbound attach; schema belongs beside U9 not inside `READ_TOOL_IDS`.

**Not met:** exact live upload URL/selectors; whether Centurion STORE* auto-files generated PDFs; whether staff actually use Documents vs still live in Outlook-only; IDM presence on hotel PCs.

## Sources

- `apps/server-pilot/src/hms/adapter.ts:65-75`
- `apps/server-pilot/src/hms/centurion.manifest.json:3-8,133-147`
- `apps/server-pilot/src/hms/live-read-manifest.ts:19-20`
- `apps/server-pilot/src/hms/runtime.ts:47,1365-1368`
- `apps/server-pilot/src/mail/artifacts/existing-document-contracts.ts:28-44`
- `apps/server-pilot/src/hms/read-tools.ts:16-26,57-60`
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428568335.html
- https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html
- https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428546494.html
- https://developer.infor.com/tutorials/document-management.md
