---
title: One-Click EML Download for Infor PMS Web Drag-and-Drop Parity
date: 2026-09-09
last_updated: 2026-09-09
category: architecture-patterns
module: apps/mail reading view and apps/server-pilot
problem_type: architecture_pattern
component: email_processing
severity: medium
applies_when:
  - "Staff needs to drag emails into external web apps like Infor HMS / Starlight Web from a browser environment"
  - "Direct tab-to-tab HTML5 drag is blocked by cross-origin security sandboxing"
  - "Need fast, authenticated export of raw RFC 822 MIME emails without desktop wrappers or server bandwidth bottlenecks"
tags:
  - eml-download
  - infor-pms
  - outlook-parity
  - browser-drag-bridge
  - rfc822
  - s3-presigned
  - cf-hdrop
---

# One-Click EML Download for Infor PMS Web Drag-and-Drop Parity

## Context

Hotel front-desk and reservations staff commonly use Outlook 2016 desktop to drag and drop emails directly into property management systems (PMS) such as Infor HMS / Starlight Web. When migrating staff to the Nava web application, direct tab-to-tab drag-and-drop between browser tabs or windows fails because the HTML5 Drag and Drop API intentionally blocks `event.dataTransfer.files` across different origins for security sandboxing reasons; browsers do not allow arbitrary file handles to be transferred across cross-origin browsing contexts.

Several alternative architectures were evaluated and rejected:
1. **Electron Desktop Wrapper:** Rejected due to continuous deployment overhead, OS code-signing certificates, multi-platform packaging, local install friction, and ongoing maintenance burden across hotel workstations.
2. **Chrome / Edge Browser Extension:** Rejected as brittle and intrusive. Extensions require enterprise browser management policies, manifest permission grants, Chrome Web Store distribution, and ongoing maintenance against browser engine updates.
3. **Direct PMS API Integration:** Direct document write APIs in Infor HMS require deep folio write permissions and extensive partner onboarding that were not authorized or available during the pilot phase.

### The Chromium Download Shelf Bridge

Chromium-based browsers (verified on Windows 10/11 64-bit on Google Chrome 151+ and Microsoft Edge 152) feature a native top-right download shelf. When an `.eml` file is downloaded via a standard browser anchor, the file lands in the download tray in ~100–150ms.

Crucially, Windows treats dragging any item out of the Chromium download shelf as an OS-level `CF_HDROP` file drag. When front-desk staff drag the downloaded item directly from Chrome's top-right tray into the Infor HMS Web tab, Infor receives standard OS file drop events (`event.dataTransfer.files`), accepting the `.eml` file identically to an Outlook 2016 desktop drag-and-drop action. This provides 100% Outlook desktop parity with zero software installations or extensions.

---

## Guidance

Bridge browser-to-PMS drag-and-drop using Chromium's native download shelf with a high-speed, authenticated delivery architecture:

1. **Prominent 1-Click UI & Menu Placement (`apps/mail/components/mail/mail-display.tsx`):**
   - Place a compact 1-click `.eml` `ActionButton` directly in the message header action row, positioned immediately next to `Reply`, `Reply All`, and `Forward`.
   - Provide a secondary access point inside the message three-dots dropdown menu (`Download Email (.eml)`).
   - Wrap the button in a `<Tooltip>` explaining the workflow: `"Download .eml file (drag into Infor PMS)"`.
   - Support loading feedback with `disabled={isDownloadingEml}` and an animated `<Loader2 className="animate-spin" />` icon to prevent duplicate clicks while generating the file.
   - Fire an informative success toast: `toast.success('Downloaded <filename> — drag into Infor PMS')`.

2. **Presigned S3 Delivery (Zero Server Bandwidth Bottleneck):**
   - For inbound emails with existing raw MIME stored in S3 (`rawMimeS3Key`), the backend (`apps/server-pilot/src/trpc/routes/mail.ts`) generates a short-lived presigned GET URL (`expiresIn: 300` seconds).
   - The presigned URL configures AWS S3 response headers:
     - `ResponseContentType: message/rfc822`
     - `ResponseContentDisposition: attachment; filename="<Safe_Subject>_<Date>.eml"` (using RFC 5987 formatting via `formatContentDispositionFilename`).
   - The browser downloads the original, unmutated RFC 822 MIME stream directly from AWS S3 edge storage into the top-right tray in ~100–150ms. The Node.js application server never touches the payload bytes, preventing server memory spikes or bandwidth exhaustion on large attachments.

3. **Fallback RFC 822 Synthesis via Nodemailer:**
   - If `rawMimeS3Key` is null (e.g., outbound messages sent from Nava, local drafts, or legacy messages), the server provides a direct HTTP route (`/api/mail/messages/:messageId/download.eml`) backed by `synthesizeRfc822Eml` in `apps/server-pilot/src/mail/eml-export.ts`.
   - The synthesizer uses `nodemailer`'s stream transport to generate a fully compliant RFC 822 MIME byte stream containing headers (`From`, `To`, `Cc`, `Bcc`, `Subject`, `Date`, `Message-ID`), plain text, and HTML bodies on the fly.

4. **Strict Multi-Tenant Mailbox Isolation:**
   - Both tRPC query `mail.getEmlDownloadUrl` and HTTP endpoint `GET /api/mail/messages/:messageId/download.eml` strictly verify that the authenticated user holds an active `mailbox_access` record for the message's `transportId`.
   - Requests for unauthorized messages return `NOT_FOUND` (404) or `401 Unauthorized`, preventing tenant enumeration and cross-tenant information leakage.

5. **Safe Filename Sanitization:**
   - Filenames are formatted as `<CleanSubject>_<YYYY-MM-DD>.eml` via `formatEmlFilename`.
   - Sanitization strips control characters (ASCII < 32 and 127) and illegal Windows filesystem characters (`<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, `*`), replaces whitespace with underscores, truncates to 60 characters, and defaults gracefully to `email_<YYYY-MM-DD>.eml` when subject is missing.

6. **EC2 Deployment Verification Gate:**
   - Verify deployment integrity using `apps/server-pilot/deploy/eml-download-gate.sh`. The gate checks build artifact exports, executes unit tests under `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` to protect production databases, and verifies the 401 unauthenticated HTTP gate.

---

## Why This Matters

- **Outlook Parity Without Electron or Extensions:** Front-desk reservations staff can maintain their muscle memory and daily workflow of dragging emails into Infor HMS folios without installing desktop software or extensions.
- **Zero Server Bandwidth Bottleneck:** Presigned S3 URLs offload raw MIME transport entirely from the EC2 pilot server, keeping CPU and memory usage flat even when users download large multi-megabyte emails.
- **Multi-Tenant Mailbox Isolation:** Enforces strict tenant isolation by ensuring every message access is authorized against the requesting user's session and `mailbox_access` table bindings.
- **Guaranteed Export Availability:** Inbound emails retain exact DKIM, SPF, and cryptographic MIME signatures from raw S3 objects, while synthesized fallback guarantees that outbound and draft messages can always be exported.

---

## When to Apply

- **Enterprise & Hospitality Migrations:** When transitioning hotel staff or enterprise users from Outlook desktop to a web client where users must drag emails into third-party web or desktop apps (Infor HMS, Opera Cloud, Salesforce, SAP).
- **Cross-Origin Drag Barriers:** When browser security sandboxes block direct cross-window HTML5 drag-and-drop file transfers between separate domains.
- **Raw Email Export & Archival:** When users require raw RFC 822 `.eml` exports for compliance, offline archiving, or third-party CRM ingestion.

---

## Examples

### 1. Client Helper (`apps/mail/lib/eml-download.ts`)

```typescript
export async function defaultFetchDownloadMeta(
  messageId: string,
): Promise<{ url: string; filename: string }> {
  const { trpcClient } = await import('@/providers/query-provider');
  const mail = trpcClient.mail as unknown as {
    getEmlDownloadUrl: {
      query: (input: { messageId: string }) => Promise<{ url: string; filename: string }>;
    };
  };
  return mail.getEmlDownloadUrl.query({ messageId });
}

export function defaultTriggerDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  if (url.startsWith('blob:')) {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    } else if (
      typeof window !== 'undefined' &&
      window.URL &&
      typeof window.URL.revokeObjectURL === 'function'
    ) {
      window.URL.revokeObjectURL(url);
    }
  }
}

export async function triggerEmlDownload(
  messageId: string,
  deps?: {
    fetchDownloadMeta?: (messageId: string) => Promise<{ url: string; filename: string }>;
    triggerDownload?: (url: string, filename: string) => void;
  },
): Promise<{ filename: string }> {
  if (!messageId) {
    throw new Error('messageId required for eml download');
  }

  const fetchMeta = deps?.fetchDownloadMeta ?? defaultFetchDownloadMeta;
  const trigger = deps?.triggerDownload ?? defaultTriggerDownload;

  const { url, filename } = await fetchMeta(messageId);
  trigger(url, filename);
  return { filename };
}
```

### 2. Backend tRPC Endpoint (`apps/server-pilot/src/trpc/routes/mail.ts`)

```typescript
  getEmlDownloadUrl: mailboxProcedure
    .input(z.object({ messageId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const msg = await requireMessageForTransport(db, input.messageId, transportId);
      const filename = formatEmlFilename(msg.subject, msg.receivedAt ?? msg.sentAt);

      if (msg.rawMimeS3Key && process.env.S3_BUCKET && process.env.AWS_REGION) {
        const url = await getSignedAttachmentUrl(msg.rawMimeS3Key, filename, 'message/rfc822');
        return {
          url,
          filename,
          isDirectHttp: false,
        };
      }

      return {
        url: `/api/mail/messages/${encodeURIComponent(input.messageId)}/download.eml`,
        filename,
        isDirectHttp: true,
      };
    }),
```

### 3. UI Integration with Tooltip, Disabled State, and Spinner (`apps/mail/components/mail/mail-display.tsx`)

```tsx
// Message reply actions button group:
<Tooltip>
  <TooltipTrigger asChild>
    <ActionButton
      onClick={(e) => {
        e.stopPropagation();
        handleDownloadEml();
      }}
      disabled={isDownloadingEml}
      icon={
        isDownloadingEml ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <FileDown className="h-3.5 w-3.5 text-muted-foreground dark:text-[#9B9B9B]" />
        )
      }
      text={isDownloadingEml ? '...' : '.eml'}
      aria-label="Download .eml"
      title="Download .eml file (drag into Infor PMS)"
    />
  </TooltipTrigger>
  <TooltipContent>Download .eml file (drag into Infor PMS)</TooltipContent>
</Tooltip>
```

---

## Related

- Implementation Plan: `docs/superpowers/plans/2026-09-09-one-click-eml-download.md`
- Shared Vocabulary: `CONCEPTS.md` (`One-click EML download`)
- Internal Mail Dragging: `docs/solutions/logic-errors/dnd-kit-mail-file-drag-dragend-threadids-race.md`
- Header Action Row Contract: `docs/solutions/ui-bugs/mail-reply-actions-in-message-and-thread-toolbar.md`
- S3 Attachment Delivery: `docs/solutions/ui-bugs/email-html-images-cid-rewrite-and-trusted-sender-domains.md`
- Verification Gate Script: `apps/server-pilot/deploy/eml-download-gate.sh`
