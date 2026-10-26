export type PaneStayPreview = {
  key: string;
  digest: string;
  runId?: string;
  screenshots: string[];
};

type CachedPreview = { preview: PaneStayPreview; expiresAt: number };

const previewCache = new Map<string, CachedPreview>();
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function previewIdentity(workItemId: string | undefined, stayId: string): string | null {
  const workItem = workItemId?.trim();
  const stay = stayId.trim();
  return workItem && stay ? JSON.stringify([workItem, stay]) : null;
}

/** Keeps only a successful preview receipt in memory; commits remain in the separate saved-stays path. */
const previewStore = {
  restore(workItemId: string | undefined, stayId: string, inputKey: string) {
    const identity = previewIdentity(workItemId, stayId);
    if (!identity || !inputKey) return undefined;
    const cached = previewCache.get(identity);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now() || cached.preview.key !== inputKey) {
      previewCache.delete(identity);
      return undefined;
    }
    return cached.preview;
  },
  remember(workItemId: string | undefined, stayId: string, preview: PaneStayPreview) {
    const identity = previewIdentity(workItemId, stayId);
    if (identity && preview.key && preview.digest) {
      previewCache.set(identity, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
    }
  },
  clear(workItemId: string | undefined, stayId: string) {
    const identity = previewIdentity(workItemId, stayId);
    if (identity) previewCache.delete(identity);
  },
};

export function usePaneStayPreview() {
  return previewStore;
}
