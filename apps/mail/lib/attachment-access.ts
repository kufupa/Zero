/**
 * Pilot attachments ship with empty `body`; bytes live behind mail.getAttachment
 * signed S3 URLs. One blob path for open / download / zip / thread chips.
 *
 * ponytail: inject getSignedUrl + fetchBytes in tests; default uses trpcClient.
 */

export type AttachmentAccessInput = {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  /** Base64 when present (Gmail path); empty/absent → signed URL fetch. */
  body?: string;
  size?: number;
};

export type AttachmentAccessDeps = {
  getSignedUrl: (messageId: string, attachmentId: string) => Promise<string>;
  fetchBytes: (url: string) => Promise<Response>;
};

function base64ToUint8Array(body: string): Uint8Array {
  const byteCharacters = atob(body);
  const byteNumbers = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  return byteNumbers;
}

async function defaultGetSignedUrl(messageId: string, attachmentId: string): Promise<string> {
  // Pilot AppRouter exposes getAttachment; @zero/server types may lag — cast at boundary.
  const { trpcClient } = await import('@/providers/query-provider');
  const mail = trpcClient.mail as unknown as {
    getAttachment: {
      query: (input: { messageId: string; attachmentId: string }) => Promise<{ url: string }>;
    };
  };
  const { url } = await mail.getAttachment.query({ messageId, attachmentId });
  return url;
}

function assertMessageIds(messageId: string, attachmentId: string): void {
  if (!messageId) throw new Error('messageId required for attachment access');
  if (!attachmentId) throw new Error('attachmentId required for attachment access');
}

/** Resolve attachment bytes: body base64 or signed-URL fetch (CORS required for S3). */
export async function fetchAttachmentBlob(
  input: Omit<AttachmentAccessInput, 'filename'>,
  deps?: Partial<AttachmentAccessDeps>,
): Promise<Blob> {
  assertMessageIds(input.messageId, input.attachmentId);

  if (input.body) {
    return new Blob([base64ToUint8Array(input.body)], { type: input.mimeType });
  }

  const getSignedUrl = deps?.getSignedUrl ?? defaultGetSignedUrl;
  const fetchBytes = deps?.fetchBytes ?? ((url: string) => fetch(url));

  const url = await getSignedUrl(input.messageId, input.attachmentId);
  const res = await fetchBytes(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch attachment: ${res.status}`);
  }
  const blob = await res.blob();
  if (blob.size === 0 && (input.size ?? 0) > 0) {
    throw new Error('Attachment data empty');
  }
  return blob;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(objectUrl);
}

/** Open blob in centered popup. Returns null if blocked. */
export function openBlobInPopup(blob: Blob): Window | null {
  const objectUrl = window.URL.createObjectURL(blob);
  const width = 800;
  const height = 600;
  const left = (window.screen.width - width) / 2;
  const top = (window.screen.height - height) / 2;

  const popup = window.open(
    objectUrl,
    'attachment-viewer',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,location=no,menubar=no`,
  );

  if (popup) {
    popup.focus();
    setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
  } else {
    window.URL.revokeObjectURL(objectUrl);
  }
  return popup;
}

export async function downloadAttachmentViaBlob(
  input: AttachmentAccessInput,
  deps?: Partial<AttachmentAccessDeps>,
): Promise<void> {
  const blob = await fetchAttachmentBlob(input, deps);
  triggerBlobDownload(blob, input.filename);
}

export async function openAttachmentViaBlob(
  input: AttachmentAccessInput,
  deps?: Partial<AttachmentAccessDeps>,
): Promise<Window | null> {
  const blob = await fetchAttachmentBlob(input, deps);
  const popup = openBlobInPopup(blob);
  if (!popup) {
    throw new Error('Popup blocked');
  }
  return popup;
}
