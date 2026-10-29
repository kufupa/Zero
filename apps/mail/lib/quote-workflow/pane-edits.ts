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
): StayGroupRequirement[] {
  if (!remembered) return groups;
  const kept = remembered.filter((row) => row.id !== DRAFT_GROUP_ID);
  if (!remembered.length) return kept;
  if (!kept.length) return groups;
  return kept;
}

/** Recover older remembered rows only from the same, unambiguously matched saved row. */
export function recoverLegacySourcePreferences(
  remembered: StayGroupRequirement[],
  saved: StayGroupRequirement[],
): StayGroupRequirement[] {
  return remembered.map((row) => {
    if (row.sourcePreference || !row.stayId) return row;
    const matches = saved.filter((candidate) => candidate.id === row.id && candidate.stayId === row.stayId);
    if (matches.length !== 1) return row;
    const source = matches[0]!;
    const room = (value: string | undefined) => value?.trim() || null;
    if (!source.sourcePreference || row.board !== source.board ||
        room(row.roomPreference) !== room(source.roomPreference)) return row;
    return { ...row, sourcePreference: { ...source.sourcePreference } };
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
