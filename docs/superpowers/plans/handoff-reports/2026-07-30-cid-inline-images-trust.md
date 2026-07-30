# Handoff — CID inline images trust (overnight)

Date: 2026-07-30  
Status: **DEPLOYED + SMOKE GREEN** (no human login / no SPA visual gate)

## Commits

| Role | SHA | Message |
| --- | --- | --- |
| Deploy tip / EC2 HEAD | `6590037f` | merge(mail): bring latest EC2-pilot into cid-inline-images |
| Authz tests | `ff9764cb` | test(mail): cover processEmailContent messageId authz |
| Message-scoped CID + domain trust | `cf72ada4` | feat(mail): message-scoped CID render and domain image trust |
| Preserve remotes until trust gate | `2ec92adb` | fix(mail): preserve remote image URLs until render trust gate |
| Inline HTTP route | `3aae1636` | feat(mail): serve authorized inline images |
| CID projection | `18c61844` | feat(mail): project safe inline CID images |
| Plan | `04140133` | docs(mail): add CID inline images trust overnight plan |

Branches: `feat/cid-inline-images-trust` and `EC2-pilot` both at `6590037f` (update-ref + bundle sync).

## Deploy

- Entry: `apps/server-pilot/deploy/ops-deploy.sh` from worktree `zero-cid-inline-images` (no `--migrate`).
- Bundle sync: HEAD on box `6590037f`.
- On-box deploy: Success (install/build/nginx/PM2).
- Health: `{"ok":true,"service":"server-pilot"}` on `127.0.0.1:8788`.
- VPN HARD assert: `VPN_HARD_OK` / `VPN_HOTEL_OK`.
- Result: `ops-deploy ok`.

## Vitest (EC2 SSM)

Command (DATABASE_URL / VITEST_ALLOW_PILOT_RDS unset):

```text
pnpm --dir apps/server-pilot exec vitest run \
  tests/cid-images.test.ts \
  tests/safe-inline-image.test.ts \
  tests/sanitize-email-html.test.ts \
  tests/inline-attachment-http.test.ts \
  tests/process-email-content.test.ts \
  tests/trust-sender.test.ts \
  tests/mail-html-sanitize.test.ts \
  tests/ingest-html-sanitize.test.ts
```

Summary: **39 passed | 3 skipped** (8 files: 7 passed | 1 skipped). Duration ~2.15s. EXIT:0.

## API / programmatic proof (no browser)

1. **CID projection** via `processEmailHtmlForDisplay` on built `dist` (fixture `cid:banner001@rocketseed` + matching `contentId`):
   - `hasInline=true`, `hasCid=false`
   - snippet: `<img src="https://nava.legacy.local/api/mail/messages/msg-1/attachments/att-1/inline">`
2. **Unauth inline**: `curl http://127.0.0.1:8788/api/mail/messages/msg-proof/attachments/att-proof/inline` → **HTTP 401** `Unauthorized`.

## Health + PM2

- Health: ok (above).
- PM2 online: `http`, `worker`, `ai-worker`, `hms-ai-worker` (uptime ~2m post-reload).

## Residuals (not gates)

- Historical DB rows with burned remote placeholders — optional MIME reparse follow-up.
- CSS `url()` remote tracking — known residual.
- Human visual of branded banner in SPA — post-overnight optional.
- Outlook “Enable JavaScript” — will not add (correct).
- Rocketseed outbound SMTP cutover — separate plan.

## Safety notes

- No Vitest against pilot RDS; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` on EC2 gate.
- No PII / DB URLs in this report.

## Final branch review (2026-07-30)

- Verdict: MERGE OK — no Critical.
- **Important (acked residual):** Print path in `mail-display.tsx` / `thread-display.tsx` still uses `cleanHtml(decodedBody)` without `processEmailContent` trust gate. Main Shadow DOM path is gated. Default `externalImages: true`. Follow-up: print from processed HTML.
- Minors retained: FE twin domain drift risk; TEST_DB skips; inline URL substring match; historical burned remotes; CSS `url()`.

