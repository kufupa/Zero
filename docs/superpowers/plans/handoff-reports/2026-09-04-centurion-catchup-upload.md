# Centurion Catch-Up Upload Handoff — 2026-09-04

## Goal

Provide browser-based in-app upload for Centurion staff to upload historical Outlook data dumps (`.pst`, `.zip` of `.msg`, or single `.msg`) directly to secure S3 storage up to 50 GB per file.

## Status

**LIVE ON PILOT — Feature flag active (`CATCHUP_UPLOAD_ENABLED=true`)**

## What was built & deployed

1. **Feature flag & runtime capability gate:**
   - Environment variable `CATCHUP_UPLOAD_ENABLED` parsed in `env.ts`.
   - Dynamic `brain.getCapabilities` returns `catchupUpload: boolean`.
   - tRPC catchup procedure middleware fails closed with `PRECONDITION_FAILED` if flag is disabled.

2. **Schema & persistence (`0022_mail_catchup_upload.sql`):**
   - Table `mail_catchup_upload` with `id`, `user_id`, `original_filename`, `content_type`, `size_bytes` (`bigint` for up to 50 GiB without 32-bit overflow), `s3_key`, `s3_upload_id` (for multipart uploads), `status` (`pending`, `stored`, `aborted`), and timestamps.
   - Index on `(user_id, created_at)`.
   - Applied to pilot RDS via `ops-deploy.sh --migrate`.

3. **Storage & Hybrid S3 upload handling (`storage/catchup-upload.ts`):**
   - Direct S3 `PutObject` presigned URLs for files ≤ 100 MiB.
   - S3 Multipart Upload (MPU, 16 MiB chunk size) for files > 100 MiB up to 50 GiB limit.
   - Filename sanitization, path traversal prevention, content type mapping (`application/vnd.ms-outlook`, `application/zip`).
   - S3 `headObject` verification ensuring byte size match before marking upload `stored`.

4. **tRPC Router (`trpc/routes/catchup.ts`):**
   - `catchup.initUpload`: Validates file type and size, creates S3 key and DB row, presigns PUT URL or MPU parts.
   - `catchup.completeUpload`: Verifies upload ownership, finishes S3 multipart upload, runs S3 HEAD check, updates DB status to `stored`.
   - `catchup.abortUpload`: Aborts active multipart upload in S3, marks DB status as `aborted`.
   - `catchup.listMine`: Returns user's upload history ordered recent-first.

5. **Front-End UI (`apps/mail`):**
   - Navigation item: "Upload backup" (`id: catchup-upload`) in sidebar bottom items immediately following Settings.
   - Gate hook: `usePilotCapabilities()` dynamically evaluates `catchupUpload` capability from backend.
   - Direct route: `/settings/catchup-upload` (redirects to general settings if capability is disabled).
   - Dialog & Component: Drag-and-drop dropzone, file input filter (`.pst,.zip,.msg`), max 50 GB validation, live progress bar with percentage and byte counts, cancellation/abort button, and recent uploads table with status badges (`Received`, `In progress`, `Cancelled`).

6. **S3 CORS Configuration:**
   - Updated canonical S3 bucket CORS rule to include `PUT` in `AllowedMethods` and expose `ETag` in `ExposeHeaders`.
   - Preserves restricted remote-admin origin rule (`GET`, `HEAD` only).
   - Launch readiness verified: `s3CorsCanonical: true`.

## Pilot Live Proof

- **Health check:** `http://127.0.0.1:8788/health` and `:8789/health` return `{"ok":true,"service":"server-pilot"}`.
- **RDS Schema:** `mail_catchup_upload` table verified in `information_schema.columns` on pilot RDS with all 11 columns including `bigint` `size_bytes`.
- **Process Env:** PM2 processes `http` (PID 747381) and `remote-http` (PID 752951) confirmed running with `CATCHUP_UPLOAD_ENABLED: 'true'`.
- **Runtime Capability:** `getPilotCapabilities().catchupUpload === true`.
- **API Live Gate:** `/api/trpc/catchup.initUpload` responds live on port 8788 (returns `UNAUTHORIZED` when unauthenticated, confirming middleware gate passed).

## WhatsApp Handoff Message

```text
Open Nava → Upload backup (under Settings) → drop the .pst
```

## Out of Scope / Next Steps

- Ingestion pipeline to parse stored `.pst` / `.msg` files and populate mailbox threads (tracked as subsequent task).
