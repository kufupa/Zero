export type PaneStayPreview = {
  key: string;
  digest: string;
  runId?: string;
  screenshots: string[];
};

type CachedPreview = { preview: PaneStayPreview; expiresAt: number };
type PendingPreview = { key: string; generation: symbol; expiresAt: number };

const previewCache = new Map<string, CachedPreview>();
const pendingPreviews = new Map<string, PendingPreview>();
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function sweepExpiredPreviews(now = Date.now()) {
  for (const [identity, cached] of previewCache) {
    if (cached.expiresAt <= now) previewCache.delete(identity);
  }
  for (const [identity, pending] of pendingPreviews) {
    if (pending.expiresAt <= now) pendingPreviews.delete(identity);
  }
}

function previewIdentity(workItemId: string | undefined, stayId: string): string | null {
  const workItem = workItemId?.trim();
  const stay = stayId.trim();
  return workItem && stay ? JSON.stringify([workItem, stay]) : null;
}

/** Keeps only a successful preview receipt in memory; commits remain in the separate saved-stays path. */
const previewStore = {
  restore(workItemId: string | undefined, stayId: string, inputKey: string) {
    sweepExpiredPreviews();
    const identity = previewIdentity(workItemId, stayId);
    if (!identity || !inputKey) return undefined;
    const pending = pendingPreviews.get(identity);
    if (pending && pending.key !== inputKey) pendingPreviews.delete(identity);
    const cached = previewCache.get(identity);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now() || cached.preview.key !== inputKey) {
      previewCache.delete(identity);
      return undefined;
    }
    return cached.preview;
  },
  begin(workItemId: string | undefined, stayId: string, inputKey: string): symbol | null {
    sweepExpiredPreviews();
    const identity = previewIdentity(workItemId, stayId);
    if (!identity || !inputKey) return null;
    previewCache.delete(identity);
    const generation = Symbol();
    pendingPreviews.set(identity, {
      key: inputKey,
      generation,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    });
    return generation;
  },
  finish(
    workItemId: string | undefined,
    stayId: string,
    inputKey: string,
    generation: symbol | null,
    preview?: PaneStayPreview,
  ): boolean {
    sweepExpiredPreviews();
    const identity = previewIdentity(workItemId, stayId);
    if (!identity) return true;
    if (!inputKey || !generation) return false;
    const pending = pendingPreviews.get(identity);
    if (!pending || pending.key !== inputKey || pending.generation !== generation) return false;
    pendingPreviews.delete(identity);
    if (preview?.key === inputKey && preview.digest) {
      previewCache.set(identity, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
    }
    return true;
  },
  clear(workItemId: string | undefined, stayId: string) {
    sweepExpiredPreviews();
    const identity = previewIdentity(workItemId, stayId);
    if (identity) {
      previewCache.delete(identity);
      pendingPreviews.delete(identity);
    }
  },
};

export function usePaneStayPreview() {
  return previewStore;
}
