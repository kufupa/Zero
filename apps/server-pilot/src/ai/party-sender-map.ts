import { partySenderMap } from '../db/schema/party-sender-map.js';
import type { DB } from '../db/client.js';

export type LearnedSenderRow = {
  host: string;
  kind: 'company' | 'agency';
  name: string;
  support: number;
};

const HOUR_MS = 60 * 60 * 1000;
const FAIL_RETRY_MS = 30_000;
const FREEMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'live.com',
  'msn.com',
]);
let rows: LearnedSenderRow[] = [];
let loadedAt = 0;
let failedAt = 0;
let testsPinned = false;
let pending: Promise<void> | null = null;

function rowOf(r: LearnedSenderRow): LearnedSenderRow | null {
  const host = r.host.trim().toLowerCase().replace(/\.+$/, '');
  const name = r.name.replace(/\s+/g, ' ').trim();
  const support = Number(r.support);
  if (!host || FREEMAIL.has(host) || !name || (r.kind !== 'company' && r.kind !== 'agency')) return null;
  if (!Number.isInteger(support) || support < 1) return null;
  return { host, kind: r.kind, name, support };
}

function take(list: LearnedSenderRow[]): LearnedSenderRow[] {
  return list.flatMap((r) => {
    const n = rowOf(r);
    return n ? [n] : [];
  });
}

/** Test seam. `null` clears the pin and empties the cache. */
export function replaceLearnedSenderMapForTests(next: LearnedSenderRow[] | null): void {
  testsPinned = next !== null;
  rows = next ? take(next) : [];
  loadedAt = Date.now();
}

export function lookupLearnedSenderParty(host: string): { kind: 'company' | 'agency'; name: string } | null {
  if (!testsPinned) void refreshIfDue();
  const h = host.toLowerCase();
  if (FREEMAIL.has(h) || [...FREEMAIL].some((d) => h.endsWith(`.${d}`))) return null;
  const exact = rows.find((r) => h === r.host);
  if (exact) return { kind: exact.kind, name: exact.name };
  const parent = rows
    .filter((r) => h.endsWith(`.${r.host}`))
    .sort((a, b) => b.host.length - a.host.length)[0];
  return parent ? { kind: parent.kind, name: parent.name } : null;
}

export async function refreshLearnedSenderMap(db: DB): Promise<number> {
  const found = await db.select().from(partySenderMap);
  rows = take(
    found.map((row) => ({
      host: row.host,
      kind: row.kind as LearnedSenderRow['kind'],
      name: row.name,
      support: row.support,
    })),
  );
  loadedAt = Date.now();
  return rows.length;
}

function refreshIfDue(): void {
  if (testsPinned || process.env.VITEST || !process.env.DATABASE_URL) return;
  if (pending) return;
  if (loadedAt > 0 && Date.now() - loadedAt < HOUR_MS) return;
  if (failedAt > 0 && Date.now() - failedAt < FAIL_RETRY_MS) return;
  pending = import('../db/client.js')
    .then(async ({ getDb }) => {
      await refreshLearnedSenderMap(getDb());
      failedAt = 0;
    })
    .catch(() => {
      failedAt = Date.now();
    })
    .finally(() => {
      pending = null;
    });
}
