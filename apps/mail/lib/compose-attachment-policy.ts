export const COMPOSE_ATTACHMENT_ACCEPT =
  'image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt';

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt']);

const GENERIC_MIME_TYPES = new Set(['application/octet-stream']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function isSupportedComposeAttachment(file: File): boolean {
  const mimeType = file.type.toLowerCase();

  return (
    mimeType.startsWith('image/') ||
    SUPPORTED_MIME_TYPES.has(mimeType) ||
    ((mimeType === '' || GENERIC_MIME_TYPES.has(mimeType)) &&
      SUPPORTED_EXTENSIONS.has(extensionOf(file.name)))
  );
}

export function partitionComposeAttachmentFiles(files: readonly File[]): {
  accepted: File[];
  rejected: File[];
} {
  const accepted: File[] = [];
  const rejected: File[] = [];

  for (const file of files) {
    (isSupportedComposeAttachment(file) ? accepted : rejected).push(file);
  }

  return { accepted, rejected };
}
