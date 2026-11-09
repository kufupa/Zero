'use client';

import type { ReservationPaneSnapshot, ReservationSourceContext } from '@/lib/reservation-workflow/types';

type Scope = { mailboxId: string; workItemId: string; requestId: string; allocationId: string; messageId: string };
type StoredAttempt = {
  version: 1;
  mailboxId: string;
  workItemId: string;
  requestId: string;
  allocationId: string;
  operationId: string;
  idempotencyKey: string;
  prepareRef: string;
  generationId: string;
  source: { propertyId: string; threadId: string | null; messageId: string; sourceHash: string; arrivedAt: string; evidenceHash: string | null };
};
type Entry = { key: string; value: string; operationId: string; binding?: { generationId: string; prepareRef: string } };
type AttemptState = { status: 'none' } | { status: 'pending'; operationId: string; entries: Entry[]; binding?: Entry['binding'] } |
  { status: 'unavailable' | 'multiple' };

const prefix = 'nava:guest-profile:';
const keyFor = (scope: Scope) => `${prefix}v1:${JSON.stringify([scope.mailboxId, scope.workItemId, scope.requestId, scope.allocationId])}`;

export function guestAttemptScope(source: ReservationSourceContext, snapshot: ReservationPaneSnapshot, requestId: string, allocationId: string): Scope {
  return { mailboxId: source.mailboxId, workItemId: snapshot.session.draft.workItemId, requestId, allocationId, messageId: source.messageId };
}

/** Legacy keys included the source hash. Search every hash so an old hold cannot disappear after an email edit. */
export function readGuestAttempt(scope: Scope): AttemptState {
  try {
    const storage = window.localStorage, entries: Entry[] = [], key = keyFor(scope);
    const value = storage.getItem(key);
    if (value !== null) {
      const parsed = JSON.parse(value) as Partial<StoredAttempt>;
      if (parsed.version !== 1 || parsed.mailboxId !== scope.mailboxId || parsed.workItemId !== scope.workItemId ||
          parsed.requestId !== scope.requestId || parsed.allocationId !== scope.allocationId ||
          typeof parsed.operationId !== 'string' || !parsed.operationId || parsed.idempotencyKey !== parsed.operationId ||
          typeof parsed.prepareRef !== 'string' || !parsed.prepareRef || typeof parsed.generationId !== 'string' || !parsed.generationId ||
          !parsed.source || typeof parsed.source.sourceHash !== 'string') return { status: 'unavailable' };
      entries.push({ key, value, operationId: parsed.operationId, binding: { generationId: parsed.generationId, prepareRef: parsed.prepareRef } });
    }
    const legacyPrefix = `${prefix}${scope.messageId}:`, legacySuffix = `:${scope.requestId}:${scope.allocationId}`;
    for (let i = 0; i < storage.length; i++) {
      const legacyKey = storage.key(i);
      if (!legacyKey || !legacyKey.startsWith(legacyPrefix) || !legacyKey.endsWith(legacySuffix)) continue;
      const operationId = storage.getItem(legacyKey);
      if (!operationId) return { status: 'unavailable' };
      entries.push({ key: legacyKey, value: operationId, operationId });
    }
    if (!entries.length) return { status: 'none' };
    if (new Set(entries.map(entry => entry.operationId)).size !== 1) return { status: 'multiple' };
    return { status: 'pending', operationId: entries[0]!.operationId, entries, binding: entries.find(entry => entry.binding)?.binding };
  } catch { return { status: 'unavailable' }; }
}

/** Use an origin-wide lock so separate pane windows cannot replace each other's unresolved attempt. */
async function withAttemptLock<T>(scope: Scope, action: () => T): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new Error('This device cannot protect profile recovery. Contact Nava support.');
  return navigator.locks.request(keyFor(scope), { mode: 'exclusive' }, action);
}

export async function saveGuestAttempt(scope: Scope, source: ReservationSourceContext, snapshot: ReservationPaneSnapshot,
  prepareRef: string, operationId: string, stillCurrent: () => boolean): Promise<void> {
  await withAttemptLock(scope, () => {
    if (!stillCurrent()) throw new Error('The email or guest details changed. Check them before creating a profile.');
    const previous = readGuestAttempt(scope);
    if (previous.status !== 'none') throw new Error(previous.status === 'unavailable'
      ? 'This device cannot retain profile recovery. Contact Nava support.'
      : 'Check the previous profile creation outcome before trying again.');
    const attempt: StoredAttempt = { version: 1, ...scope, operationId, idempotencyKey: operationId, prepareRef,
      generationId: snapshot.session.draft.generationId, source: { propertyId: source.propertyId, threadId: source.threadId,
        messageId: source.messageId, sourceHash: source.sourceHash, arrivedAt: source.arrivedAt,
        evidenceHash: snapshot.session.draft.prefill?.evidenceHash ?? null } };
    const key = keyFor(scope), value = JSON.stringify(attempt);
    try {
      window.localStorage.setItem(key, value);
      if (window.localStorage.getItem(key) !== value) throw new Error();
    } catch { throw new Error('This device cannot retain profile recovery. Profile creation is unavailable.'); }
  });
}

/** Only a verified success, or a caller that has not invoked Create, may release the matching hold. */
export async function clearGuestAttempt(scope: Scope, operationId: string): Promise<boolean> {
  try {
    return await withAttemptLock(scope, () => {
      const current = readGuestAttempt(scope);
      if (current.status !== 'pending' || current.operationId !== operationId) return false;
      const storage = window.localStorage;
      for (const entry of current.entries) {
        if (storage.getItem(entry.key) !== entry.value) return false;
      }
      for (const entry of current.entries) storage.removeItem(entry.key);
      return readGuestAttempt(scope).status === 'none';
    });
  } catch { return false; }
}
