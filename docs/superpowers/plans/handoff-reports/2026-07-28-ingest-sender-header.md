# Ingest Sender Header Fix — Handoff Report (2026-07-28)

**Branch:** `EC2-pilot`  
**Shipped SHA:** `1440aac7` (`fix(ingest): prefer Sender over From when they differ`)  
**EC2:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Plan:** `docs/superpowers/plans/2026-07-28-ingest-sender-header.md`

## What shipped

- `parse-message.ts`: when `Sender` and `From` differ (case-insensitive), persist `from_address` from `Sender` (Outlook calendar forward pattern).
- Tests + fixture `outlook-calendar-fw-sender.eml` in `tests/ingest-store.test.ts` (Tasks 1–2, same commit).

## Deploy

| Step | Result |
|------|--------|
| `git push -u origin HEAD` | **PASS** — `a7b1fcfe..1440aac7` on `EC2-pilot` |
| `bash apps/server-pilot/deploy/ops-deploy.sh` | **PASS** — health `{"ok":true,"service":"server-pilot"}`, VPN hard assert OK |
| `bash apps/server-pilot/deploy/ops-restart.sh` | **EXIT 1** — immediate post-start `curl` to `:8788` raced PM2; processes online; health OK ~2m later via SSM |

## Prod row correction (one-off)

**Message:** `83dc749d-975e-4a26-a2b0-4f590f1da8e7`  
**Thread:** `a759ce6f-b878-4ca6-ae76-c893a0d4743f`  
**S3 key:** `raw-mime/ingest-nava-legacy/289.J0tsye6e0cZos9pcDtVMS22SsaujymVqsbnncBXXZZ4_.eml`

Verified S3 raw MIME headers:

- `From: "Ansh Arora" <aroransh17@gmail.com>`
- `Sender: "Kamala Douglas" <kdouglas@legacyhotels.co.za>`
- `Return-Path: kdouglas@legacyhotels.co.za`

| Field | Before | After |
|-------|--------|-------|
| `message.from_address` | `aroransh17@gmail.com` | `kdouglas@legacyhotels.co.za` |

SSM: `UPDATE message` (1 row) + `mail_thread.search_vector` refresh for thread (1 row).

## Residual / out of scope

- **No bulk backfill** for historical rows already ingested with wrong `from_address`. New inbound mail picks up fix automatically.
- Mailing-list / list-mail `Sender` ≠ `From` mis-attribution: deferred (not seen in Centurion sample).
- `ops-restart.sh` health race: consider short retry loop if this flakes often.

## Follow-up (optional)

- Re-run Centurion UI spot-check on thread `a759ce6f-…` sender display.
- If more bad rows surface, script one-off SELECT (Sender≠From in S3) before any mass UPDATE.
