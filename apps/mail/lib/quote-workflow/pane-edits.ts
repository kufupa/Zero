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
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
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
  if (!kept.length) return groups;
  const byId = new Map(kept.map((row) => [row.id, row]));
  const next = groups.filter((row) => byId.has(row.id)).map((row) => byId.get(row.id) ?? row);
  for (const row of kept) {
    if (next.some((item) => item.id === row.id)) continue;
    next.push(row);
  }
  return next;
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
