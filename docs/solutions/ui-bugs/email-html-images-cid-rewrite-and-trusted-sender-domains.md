---
title: "Hotel Email HTML Images Missing: CID Rewrite Plus Remote Trust Gate"
date: 2026-07-31
last_updated: 2026-07-31
category: ui-bugs
module: mail / server-pilot email HTML rendering
problem_type: ui_bug
component: email_processing
symptoms:
  - Hotel mail SPA showed broken/missing images and GIFs in email HTML for trusted hotel domains
  - Attachments downloadable but never rendered inline in the message body
  - cid: URLs stayed as cid: after sanitize — browser could not fetch them
  - Remote http(s) images permanently replaced with 1x1 GIF placeholder at storage/wire
  - Trust Sender matched exact email only and ignored AUTO_TRIAGE_NEVER_SPAM_DOMAINS
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - cid-images
  - inline-attachments
  - html-sanitize
  - trust-sender
  - should-load-images
  - hotel-mail
  - auto-triage-never-spam
  - email-rendering
  - rocketseed
related_components:
  - authentication
---

# Hotel Email HTML Images Missing: CID Rewrite Plus Remote Trust Gate

## Problem

Hotel mailbox HTML in the Zero mail frontend rendered without logos, banners, and animated GIFs even when the same messages listed downloadable attachments and came from known hotel domains. Staff saw blank image slots in the Shadow DOM reader while the attachment pane still offered files for download.

## Symptoms

- Open hotel thread in SPA: body HTML shows layout/text; image regions empty or 1×1 transparent placeholders.
- Attachment list still shows PNG/JPEG/GIF and download works — bytes exist; HTML `src` path does not.
- Processed HTML retained `cid:…` or `BLOCKED_IMAGE_PLACEHOLDER` instead of `/api/mail/messages/…/attachments/…/inline` or original `https://…` URLs.
- Enabling “trust this sender” for one address did not help other addresses on the same hotel domain.
- After partial fixes, React Query could still serve a stale `email-content` cache that predated `messageId` / domain-trust behavior.

## What Didn't Work

- **Assuming downloadable attachments implied visible inline images.** Attachment download and HTML `<img>` rendering are separate pipelines.
- **Sanitizing with `shouldLoadImages: false` at storage/wire “for safety.”** That collapses remote URLs into irreversible placeholders. XSS stripping and image-trust gating must not share the same destructive transform.
- **Leaving `cid:` allowed through sanitization without projecting it.** The sanitizer correctly keeps `cid:`; without `projectCidImages` the browser still has nothing to fetch.
- **Exact-email `trustedSenders.includes(senderEmail)`.** Hotel mail is multi-address on shared domains.
- **Calling `processEmailContent` with HTML alone (no `messageId`).** Projection must be message-scoped for authz and attachment metadata.
- **Prior sessions treated CID metadata as triage/data gaps, not a render-path bug.** (session history) MIME inspect logged attachment `cid` fields for classification; never-spam domain work gated spam/category only. Rocketseed plans named CID banner rendering as a companion to SMTP relay but did not diagnose storage-time remote burning or SPA blank images. (session history)
- **Treating every missing banner as a CID/UI bug.** Outbound mail can traverse Rocketseed yet still lack signature/banner MIME when the RFC5322 From is not provisioned in the Rocketseed tenant (e.g. Nava test/BCC sink). No `cid:` / branding image parts → Zero render path has nothing to project. That is tenant From provisioning, not `projectCidImages` failure. See [Rocketseed From/sender provisioning](../architecture-patterns/rocketseed-banner-injection-from-sender-provisioning.md).

## Diagnostic split (missing banners)

| Observation | Likely layer | Next check |
|-------------|--------------|------------|
| Raw MIME has `rocketseed-strip` / branding-domain / CID image parts; SPA still blank | Zero render (this doc) | `processEmailContent` + `messageId`, CID normalize, inline route authz, trust/`shouldLoadImages`, cache key |
| Raw MIME has no branding markers; may still show `X-ExSBR-Direction` / `X-BypassBranding` after `.8` hop | Rocketseed tenant / From | Is Header From provisioned? Same-path Centurion vs Nava discriminator — not CID code |
| Attachment chip downloads image but body `src` still `cid:` or placeholder | This doc | Projection / inline route |
| Body has remote `https://branding…` URLs replaced by 1×1 placeholder | This doc (storage burn or trust gate) | `sanitizeHtmlBodyForStorage` preserve + FE `isImageTrustedSender` |

## Solution

### 1. Project CID images to authenticated inline URLs

`projectCidImages` builds a content-id map from image MIME attachments, normalizes CIDs (`cid:` strip, angle brackets, decode, lower-case), refuses ambiguous duplicate CIDs, and rewrites matching `<img src="cid:…">` to:

`{origin}/api/mail/messages/{messageId}/attachments/{attachmentId}/inline`

Unmatched CIDs become `BLOCKED_IMAGE_PLACEHOLDER` and set `hasBlockedImages`.

```31:68:apps/server-pilot/src/mail/cid-images.ts
export function projectCidImages(
  html: string,
  attachments: CidAttachmentMeta[],
  opts: { messageId: string; origin: string },
): { html: string; hasBlockedImages: boolean } {
  // ... build byCid map from image MIME + normalizeContentId ...
  $('img[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (!/^cid:/i.test(src.trim())) return;
    const id = normalizeContentId(src);
    const att = id ? byCid.get(id) : undefined;
    if (!att) {
      hasBlockedImages = true;
      $(el).attr('src', BLOCKED_IMAGE_PLACEHOLDER);
      return;
    }
    $(el).attr(
      'src',
      `${origin}/api/mail/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(att.attachmentId)}/inline`,
    );
  });
  return { html: $.html(), hasBlockedImages };
}
```

### 2. Serve inline bytes with session auth + raster safety

`GET /api/mail/messages/:messageId/attachments/:attachmentId/inline` (mounted in `main.ts` before tRPC) requires a Better Auth cookie session, joins `attachment` → `message` → `mailbox_access` (no active-transport header — `<img>` cannot set custom headers), bounds S3 reads, and runs `assertSafeInlineRaster` before `Content-Disposition: inline`.

### 3. Preserve remote URLs until `processEmailContent`; gate with trust

**Before (ingest/storage burned remotes):**

```typescript
return sanitizeEmailHtml(html, { shouldLoadImages: false }).html;
```

**After (XSS only at storage; trust gate at display):**

```90:96:apps/server-pilot/src/mail/sanitize-email-html.ts
/** Sanitize HTML before persisting to Postgres. Raw MIME remains in S3. */
export function sanitizeHtmlBodyForStorage(html: string | null): string | null {
  if (html == null || html === '') return html;
  if (!html.includes('<')) return html;
  // XSS only — remote img URLs preserved; trust gate is processEmailContent.
  return sanitizeEmailHtml(html, { shouldLoadImages: true }).html;
}
```

Same pattern in `wire-compat.ts` `toParsedMessage`. Display pipeline: sanitize → CID project → quote collapse via `processEmailHtmlForDisplay`.

### 4. Message-scoped tRPC + domain trust on FE

`processEmailContent` requires `messageId`, authorizes the message for the active transport, loads that message’s attachments, and calls `processEmailHtmlForDisplay`.

Frontend uses shared `isImageTrustedSender` (hotel domains from the never-spam allowlist family + exact email + domain entries in `trustedSenders`), cache key `email-content-v2`, and passes `messageId`.

Server twin (`apps/server-pilot/src/mail/trust-sender.ts`) mirrors the FE predicate for tests/parity and uses `AUTO_TRIAGE_NEVER_SPAM_DOMAINS`; the FE twin hardcodes the same hotel domains to avoid importing never-spam into the mail app. **`processEmailContent` does not call the server twin** — remote images are gated by the client-supplied `shouldLoadImages` flag after mailbox authz.

### Residual (acked)

Print paths in `mail-display.tsx` / `thread-display.tsx` still inject `cleanHtml(decodedBody)` and bypass `processEmailContent` / `isImageTrustedSender`. Main Shadow DOM path is gated. Historical DB rows burned before the preserve-remotes fix need a MIME reparse job if those messages must show remotes. If a future sanitize path re-allows CSS `style` / `url()`, remote tracking pixels become a residual again (current sanitize strips most style surfaces).

## Why This Works

- **CID and remote images fail for different reasons.** CID needs a same-origin authenticated byte URL; remotes need the original URL preserved until a deliberate trust decision.
- **Destructive image blocking cannot run at ingest.** `shouldLoadImages: false` is a *render* policy. At storage/wire it permanently erases evidence.
- **Message-scoped projection closes the authz hole.** Loading attachments only for an authorized `messageId`, and requiring mailbox_access on the HTTP path without a custom transport header, matches how `<img>` actually loads.
- **Raster assertion** stops “inline” from becoming a content-type trampoline.
- **Domain trust matches hotel operational reality.** Auto-triage already treated those domains as never-spam; image loading now shares that allowlist so staff do not manually trust every address. (session history: thin never-spam + `mail.legacyhotels.com` domain entries were institutional precedent before image trust reused them.)
- **CID projection does not depend on `shouldLoadImages`.** Matched CIDs always rewrite to inline HTTP; remote `http(s)` remain gated by trust.
- **Zero cannot invent Rocketseed banners.** Projection only rewrites CIDs / loads remotes that already exist in sanitized HTML + attachment metadata. Unprovisioned From → no branded MIME → blank banner slots are expected upstream, not a failed inline route.

## Prevention

- Never call `sanitizeEmailHtml(..., { shouldLoadImages: false })` on persist or wire paths that must later honor trust. Storage/wire = XSS only; image policy = `processEmailContent`.
- Any new HTML render surface (print, export, mobile webview) must call `processEmailHtmlForDisplay` / `processEmailContent` with `messageId` and the same `isImageTrustedSender` predicate — do not paste `cleanHtml(decodedBody)`.
- Keep FE `IMAGE_TRUSTED_DOMAINS` and server `AUTO_TRIAGE_NEVER_SPAM_DOMAINS` in sync when hotel domains change.
- When changing `processEmailContent` input or trust semantics, bump the React Query key (`email-content-vN`).
- Inline HTTP must stay cookie-session + mailbox_access join; never require `x-active-transport` for `<img>` routes.
- Run `cid-images`, `safe-inline-image`, `inline-attachment-http`, `process-email-content`, `trust-sender`, `sanitize-email-html`, `ingest-html-sanitize`, `mail-html-sanitize` before claiming image-trust changes are done (never against pilot RDS).
- Historical rows burned before the preserve-remotes fix need a MIME reparse / body rewrite job; new ingest alone will not heal them.
- Before debugging CID/UI for a missing Rocketseed banner, inspect raw MIME for branding markers (`rocketseed-strip`, branding-domain images, CID parts). Absent markers → From/tenant provisioning path first ([selector learning](../architecture-patterns/rocketseed-banner-injection-from-sender-provisioning.md)); present markers → this render path.

## Related Issues

- [Rocketseed banner injection From/sender provisioning](../architecture-patterns/rocketseed-banner-injection-from-sender-provisioning.md) — upstream gate: provisioned From gets branded MIME; unprovisioned (e.g. Nava sink) does not. Complements this display-path doc.
- [Mail quoted history crop and collapse](../logic-errors/mail-quoted-history-crop-and-collapse.md) — same `processEmailContent` pipeline (sanitize → images/CID → collapseQuoted).
- [EC2 pilot pre-real-ingest security gate](../security-issues/ec2-pilot-pre-real-ingest-security-gate.md) — XSS sanitize boundary; placeholders belong at render trust gate, not as a permanent storage burn.
- [Folder-first spam_at folder matrix](../architecture-patterns/folder-first-spam-at-folder-matrix.md) — `AUTO_TRIAGE_NEVER_SPAM_DOMAINS` source reused for image trust defaults.
- [Outlook calendar forward sender attribution](../logic-errors/outlook-calendar-forward-sender-attribution.md) — `fromAddress` feeds domain trust matching.
- [Live pilot production parity real mail](../architecture-patterns/live-pilot-production-parity-real-mail.md) — attachment download ≠ CID projection.
- Plan / handoff: `docs/plans/2026-07-30-002-fix-cid-inline-images-and-trust-plan.md`, `docs/superpowers/plans/handoff-reports/2026-07-30-cid-inline-images-trust.md`
