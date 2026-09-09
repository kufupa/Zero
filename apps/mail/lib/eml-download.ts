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
