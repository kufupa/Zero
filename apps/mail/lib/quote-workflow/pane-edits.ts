import { DRAFT_GROUP_ID } from './session';
import type { StayGroupRequirement } from './types';

const STORAGE_PREFIX = 'nava.pane-edits.v1:';
const memory = new Map<string, StayGroupRequirement[]>();

export function paneEditKey(transportId: string, messageKey: string): string {
  return `${transportId}::${messageKey}`;
}

export function rememberPaneEdits(key: string, groups: StayGroupRequirement[]): void {
  const copy = structuredClone(groups);
  memory.set(key, copy);
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(copy));
  } catch {
    // In-memory copy still covers a switch while this pane stays mounted.
  }
}

export function recalledPaneEdits(key: string): StayGroupRequirement[] | null {
  const hit = memory.get(key);
  if (hit) return structuredClone(hit);
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    memory.set(key, parsed as StayGroupRequirement[]);
    return structuredClone(parsed as StayGroupRequirement[]);
  } catch {
    return null;
  }
}

export function overlayRememberedGroups(
  groups: StayGroupRequirement[],
  remembered: StayGroupRequirement[] | null,
  recoverSavedPreferences = false,
): StayGroupRequirement[] {
  if (!remembered) return groups;
  const kept = remembered.filter((row) => row.id !== DRAFT_GROUP_ID);
  if (!remembered.length) return kept;
  if (!kept.length) return groups;
  if (!recoverSavedPreferences) return kept;
  // Older pane edits did not store raw pricing preferences. Only a unique, matching saved row can restore them.
  // This metadata is harmless for other properties; only Centurion's quote binder submits it.
  return kept.map((row) => {
    if (row.sourcePreference) return row;
    const matches = groups.filter((group) => group.id === row.id);
    if (matches.length !== 1) return row;
    const saved = matches[0]!;
    const room = (value: string | undefined) => typeof value === 'string' ? value.trim() || null : null;
    if (!saved.sourcePreference || (row.stayId && saved.stayId && row.stayId !== saved.stayId) ||
        room(row.roomPreference) !== room(saved.roomPreference) || row.board !== saved.board) return row;
    return { ...row, sourcePreference: { ...saved.sourcePreference } };
  });
}

/** Drops remembered stay edits for one mail so a history refresh can show the server values. */
export function forgetPaneEdits(key: string): void {
  memory.delete(key);
  try {
    sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
  } catch {
    // In-memory copy is gone even when sessionStorage is blocked.
  }
}

export function resetPaneEditsForTests(options?: { keepSession?: boolean }): void {
  memory.clear();
  if (options?.keepSession) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const name = sessionStorage.key(i);
      if (name?.startsWith(STORAGE_PREFIX)) keys.push(name);
    }
    for (const name of keys) sessionStorage.removeItem(name);
  } catch {
    // Tests without sessionStorage still clear the map.
  }
}
