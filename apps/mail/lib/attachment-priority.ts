/** Display order for attachment chips: docs first, other next, raster images last. */

const IMAGE_EXTS = new Set([
  'gif',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'svg',
  'ico',
  'tif',
  'tiff',
  'heic',
  'avif',
]);

const DOC_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'xlsm',
  'csv',
  'ppt',
  'pptx',
  'txt',
  'rtf',
  'odt',
  'ods',
  'odp',
  'numbers',
  'pages',
  'key',
]);

function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function isDocMime(mimeType: string): boolean {
  return (
    mimeType.includes('pdf') ||
    mimeType.includes('msword') ||
    mimeType.includes('officedocument') ||
    mimeType.includes('ms-excel') ||
    mimeType.includes('ms-powerpoint') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('presentation') ||
    mimeType.includes('text/plain') ||
    mimeType.includes('text/csv')
  );
}

/** 0 = docs, 1 = other, 2 = images (banner/signature noise last). */
export function attachmentPriorityRank(filename: string, mimeType?: string): number {
  const ext = extensionOf(filename);
  const mime = (mimeType ?? '').toLowerCase();

  if (IMAGE_EXTS.has(ext) || mime.startsWith('image/')) return 2;
  if (DOC_EXTS.has(ext) || isDocMime(mime)) return 0;
  return 1;
}

export function sortAttachmentsForDisplay<T extends { filename: string; mimeType?: string }>(
  attachments: T[],
): T[] {
  return [...attachments].sort((a, b) => {
    const delta =
      attachmentPriorityRank(a.filename, a.mimeType) -
      attachmentPriorityRank(b.filename, b.mimeType);
    if (delta !== 0) return delta;
    return a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
  });
}
