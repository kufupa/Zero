---
title: One-Click EML Download for Infor PMS Web Drag-and-Drop Parity
date: 2026-09-09
category: architecture-patterns
module: apps/mail reading view and apps/server-pilot
problem_type: architecture_pattern
component: email_processing
severity: medium
applies_when:
  - "Staff needs to drag emails into external web apps like Infor HMS/PMS from a browser environment"
  - "Direct tab-to-tab HTML5 drag is blocked by cross-origin security sandboxing"
tags:
  - eml-download
  - infor-pms
  - outlook-parity
  - browser-drag-bridge
  - rfc822
  - s3-presigned
---

# One-Click EML Download for Infor PMS Web Drag-and-Drop Parity

## Context

Hotel front-desk and reservations staff commonly use Outlook 2016 desktop to drag and drop emails directly into property management systems such as Infor HMS / Starlight Web. When migrating staff to the Nava web application, direct tab-to-tab drag-and-drop between browser tabs or windows fails because the HTML5 Drag and Drop API intentionally blocks `event.dataTransfer.files` across different origins for security sandboxing reasons.

Building a heavy Electron wrapper was rejected due to continuous deployment overhead, and building a Chrome extension was rejected as brittle and intrusive. A direct HMS integration requires deep PMS folio APIs that are not yet exposed for this workflow.

## Guidance

Bridge browser-to-PMS drag-and-drop using Chromium's native download shelf:

1. **Message Action Button & Dropdown Entry**: Expose a prominent 1-click `.eml` button with tooltip `"Download .eml file (drag into Infor PMS)"` and a `Download Email (.eml)` item in the message three-dots menu.
2. **Presigned S3 Delivery**: When raw MIME is present in S3 (`rawMimeS3Key`), generate a short-lived presigned GET URL (`expiresIn: 300`) with:
   - `ResponseContentType: message/rfc822`
   - `ResponseContentDisposition: attachment; filename="<Safe_Subject>_<Date>.eml"` (using RFC 5987 formatting).
   This delivers the original pristine raw MIME directly from S3 to the client in ~100-150ms without hitting the Node application server bandwidth.
3. **Fallback RFC 822 Synthesis**: If `rawMimeS3Key` is null (e.g. legacy or locally created drafts), stream-synthesize an RFC 822 `.eml` buffer via `nodemailer` with headers, plain text, and HTML body.
4. **Native Drag Bridge**: Clicking the button triggers an anchor download that downloads the `.eml` file into Chrome/Edge's top-right download tray in ~150ms. Staff can immediately drag the file directly out of the download tray into the Infor PMS web tab. Windows treats dragging from Chrome's download tray as an OS-level `CF_HDROP` file drop, which Infor HMS accepts identically to Outlook desktop!

## Why This Matters

- **Full Parity Without Electron or Extensions**: Recreates Outlook desktop drag-and-drop behavior 100% web-natively using standard browser features.
- **Zero Bandwidth Bottleneck**: Presigned S3 URLs offload raw MIME transport entirely from the EC2 pilot server.
- **Strict Multi-Tenant Security**: Both tRPC (`mail.getEmlDownloadUrl`) and HTTP (`/api/mail/messages/:messageId/download.eml`) strictly enforce `mailbox_access` membership on the requesting user session, preventing cross-tenant information leakage.

## When to Apply

- Whenever staff requests Outlook drag-and-drop parity into legacy desktop or web enterprise tools (PMS, CRM, ERP).
- When raw MIME must be extracted or archived from the reading view.

## Examples

### Frontend Download Trigger (`apps/mail/lib/eml-download.ts`)

```typescript
export function defaultTriggerDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
```

### Backend Safe S3 Presigning (`apps/server-pilot/src/trpc/routes/mail.ts`)

```typescript
if (msg.rawMimeS3Key && process.env.S3_BUCKET && process.env.AWS_REGION) {
  const url = await getSignedAttachmentUrl(msg.rawMimeS3Key, filename, 'message/rfc822');
  return {
    url,
    filename,
    isDirectHttp: false,
  };
}
```

## Related

- `docs/superpowers/plans/2026-09-09-one-click-eml-download.md`
- `apps/server-pilot/src/mail/eml-export.ts`
- `apps/server-pilot/src/http/eml-download.ts`
- `apps/mail/components/mail/mail-display.tsx`
- `CONCEPTS.md`
