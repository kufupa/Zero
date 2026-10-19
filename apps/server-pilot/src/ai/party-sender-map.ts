import { sql } from 'drizzle-orm';
import { partySenderMap } from '../db/schema/party-sender-map.js';
import type { DB } from '../db/client.js';

export type LearnedSenderRow = {
  host: string;
  kind: 'company' | 'agency';
  name: string;
  nativeId?: string | null;
  iata?: string | null;
  support: number;
};

type StoredLearnedSenderRow = LearnedSenderRow & { nativeId: string | null; iata: string | null };

export type LearnedSenderHistory = {
  kind: 'company' | 'agency';
  name: string;
  nativeId: string | null;
  iata: string | null;
  support: number;
};

export type RecordSenderPartyInput = {
  host: string;
  kind: 'company' | 'agency';
  name: string;
  nativeId: string | null;
  iata: string | null;
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
const OWNED_HOTEL_HOSTS = new Set([
  'legacyhotels.co.za',
  'legacyhotels.com',
  'legacyhotel.com',
]);
let rows: StoredLearnedSenderRow[] = [];
let loadedAt = 0;
let failedAt = 0;
let testsPinned = false;
let pending: Promise<void> | null = null;

function rowOf(r: LearnedSenderRow): StoredLearnedSenderRow | null {
  const host = r.host.trim().toLowerCase().replace(/\.+$/, '');
  const name = r.name.replace(/\s+/g, ' ').trim();
  const nativeId = typeof r.nativeId === 'string' ? r.nativeId.trim() || null : null;
  const iata = typeof r.iata === 'string' ? r.iata.trim() || null : null;
  const support = Number(r.support);
  if (!host || FREEMAIL.has(host) || !name || (r.kind !== 'company' && r.kind !== 'agency')) return null;
  if (!Number.isInteger(support) || support < 1) return null;
  return { host, kind: r.kind, name, nativeId, iata, support };
}

function take(list: LearnedSenderRow[]): StoredLearnedSenderRow[] {
  return list.flatMap((r) => {
    const n = rowOf(r);
    return n ? [n] : [];
  });
}

export function isOwnedHotelHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, '');
  return [...OWNED_HOTEL_HOSTS].some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
}

function senderHostExcluded(host: string): boolean {
  return (
    FREEMAIL.has(host) ||
    [...FREEMAIL].some((domain) => host.endsWith(`.${domain}`)) ||
    isOwnedHotelHost(host)
  );
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

/** History row for matching; exact host wins, then the longest stored parent host. */
export function lookupLearnedSenderHistory(host: string): LearnedSenderHistory | null {
  if (!testsPinned) void refreshIfDue();
  const h = host.toLowerCase();
  if (FREEMAIL.has(h) || [...FREEMAIL].some((d) => h.endsWith(`.${d}`))) return null;
  const exact = rows.find((r) => h === r.host);
  const row =
    exact ??
    rows
      .filter((r) => h.endsWith(`.${r.host}`))
      .sort((a, b) => b.host.length - a.host.length)[0];
  return row
    ? {
        kind: row.kind,
        name: row.name,
        nativeId: row.nativeId,
        iata: row.iata,
        support: row.support,
      }
    : null;
}

export function partyHistoryBindEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PARTY_HISTORY_BIND === 'on';
}

/** Learn one staff-verified commercial party for an eligible sender host. */
export async function recordSenderParty(
  db: DB,
  input: RecordSenderPartyInput,
): Promise<LearnedSenderHistory | null> {
  const host = input.host.trim().toLowerCase().replace(/\.+$/, '');
  const name = input.name.replace(/\s+/g, ' ').trim();
  const nativeId = input.nativeId?.trim() || null;
  const iata = input.iata?.trim() || null;
  if (
    !host ||
    senderHostExcluded(host) ||
    !name ||
    (input.kind !== 'company' && input.kind !== 'agency')
  ) {
    return null;
  }

  const sameParty = sql`(
    ${partySenderMap.kind} = excluded.kind
    AND CASE
      WHEN ${partySenderMap.nativeId} IS NOT NULL AND excluded.native_id IS NOT NULL
        THEN ${partySenderMap.nativeId} = excluded.native_id
      ELSE lower(regexp_replace(btrim(${partySenderMap.name}), '[[:space:]]+', ' ', 'g'))
        = lower(regexp_replace(btrim(excluded.name), '[[:space:]]+', ' ', 'g'))
    END
  )`;
  const [saved] = await db
    .insert(partySenderMap)
    .values({ host, kind: input.kind, name, nativeId, iata, support: 1 })
    .onConflictDoUpdate({
      target: partySenderMap.host,
      set: {
        kind: sql`excluded.kind`,
        name: sql`excluded.name`,
        nativeId: sql`CASE WHEN ${sameParty} THEN COALESCE(excluded.native_id, ${partySenderMap.nativeId}) ELSE excluded.native_id END`,
        iata: sql`CASE WHEN ${sameParty} THEN COALESCE(excluded.iata, ${partySenderMap.iata}) ELSE excluded.iata END`,
        support: sql`CASE WHEN ${sameParty} THEN ${partySenderMap.support} + 1 ELSE 1 END`,
      },
    })
    .returning();
  if (!saved) return null;
  const stored = rowOf({
    host: saved.host,
    kind: saved.kind as StoredLearnedSenderRow['kind'],
    name: saved.name,
    nativeId: saved.nativeId,
    iata: saved.iata,
    support: saved.support,
  });
  if (!stored) return null;
  rows = [...rows.filter((row) => row.host !== stored.host), stored];
  loadedAt = Date.now();
  return {
    kind: stored.kind,
    name: stored.name,
    nativeId: stored.nativeId,
    iata: stored.iata,
    support: stored.support,
  };
}

export async function refreshLearnedSenderMap(db: DB): Promise<number> {
  const found = await db.select().from(partySenderMap);
  rows = take(
    found.map((row) => ({
      host: row.host,
      kind: row.kind as LearnedSenderRow['kind'],
      name: row.name,
      nativeId: row.nativeId,
      iata: row.iata,
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
