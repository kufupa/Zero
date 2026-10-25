import { sql } from 'drizzle-orm';
import { partySenderMap } from '../db/schema/party-sender-map.js';
import type { DB } from '../db/client.js';

export type LearnedSenderRow = {
  propertyCode?: string;
  host: string;
  kind: 'company' | 'agency';
  name: string;
  nativeId?: string | null;
  iata?: string | null;
  support: number;
};

type StoredLearnedSenderRow = LearnedSenderRow & {
  propertyCode: string;
  nativeId: string | null;
  iata: string | null;
};

export type LearnedSenderHistory = {
  kind: 'company' | 'agency';
  name: string;
  nativeId: string | null;
  iata: string | null;
  support: number;
};

export type RecordSenderPartyInput = {
  propertyCode: string;
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
export const OWNED_HOTEL_HOSTS = new Set([
  'legacyhotels.co.za',
  'legacyhotels.com',
  'legacyhotel.com',
]);
let rows: StoredLearnedSenderRow[] = [];
let loadedAt = 0;
let failedAt = 0;
let testsPinned = false;
let pending: Promise<void> | null = null;
let ambientPropertyCode: string | null = null;

export function normalizeSenderHistoryProperty(
  propertyCode: string | null | undefined,
): string | null {
  const value = typeof propertyCode === 'string' ? propertyCode.trim().toUpperCase() : '';
  return value || null;
}

/** Scoped lookup for unowned callers (quote-ready) that cannot take a property argument. */
export function withSenderHistoryProperty<T>(propertyCode: string, run: () => T): T {
  const previous = ambientPropertyCode;
  ambientPropertyCode = normalizeSenderHistoryProperty(propertyCode);
  try {
    return run();
  } finally {
    ambientPropertyCode = previous;
  }
}

function resolveProperty(propertyCode?: string | null): string | null {
  return normalizeSenderHistoryProperty(propertyCode) ?? ambientPropertyCode;
}

function rowOf(r: LearnedSenderRow, fallbackProperty?: string | null): StoredLearnedSenderRow | null {
  const propertyCode = normalizeSenderHistoryProperty(r.propertyCode) ?? fallbackProperty ?? null;
  const host = r.host.trim().toLowerCase().replace(/\.+$/, '');
  const name = r.name.replace(/\s+/g, ' ').trim();
  const nativeId = typeof r.nativeId === 'string' ? r.nativeId.trim() || null : null;
  const iata = typeof r.iata === 'string' ? r.iata.trim() || null : null;
  const support = Number(r.support);
  if (
    !propertyCode ||
    !host ||
    FREEMAIL.has(host) ||
    !name ||
    (r.kind !== 'company' && r.kind !== 'agency')
  ) {
    return null;
  }
  if (!Number.isInteger(support) || support < 1) return null;
  return { propertyCode, host, kind: r.kind, name, nativeId, iata, support };
}

function take(list: LearnedSenderRow[], fallbackProperty?: string | null): StoredLearnedSenderRow[] {
  return list.flatMap((r) => {
    const n = rowOf(r, fallbackProperty);
    return n ? [n] : [];
  });
}

function historyOf(row: StoredLearnedSenderRow): LearnedSenderHistory {
  return {
    kind: row.kind,
    name: row.name,
    nativeId: row.nativeId,
    iata: row.iata,
    support: row.support,
  };
}

function matchHost(list: StoredLearnedSenderRow[], host: string): StoredLearnedSenderRow | undefined {
  const exact = list.find((r) => host === r.host);
  return (
    exact ??
    list
      .filter((r) => host.endsWith(`.${r.host}`))
      .sort((a, b) => b.host.length - a.host.length)[0]
  );
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
  rows = next ? take(next, 'HRCEN') : [];
  loadedAt = Date.now();
}

export function lookupLearnedSenderParty(
  host: string,
  propertyCode?: string | null,
): { kind: 'company' | 'agency'; name: string } | null {
  const history = lookupLearnedSenderHistory(host, propertyCode);
  return history ? { kind: history.kind, name: history.name } : null;
}

/** History row for matching; exact host wins, then the longest stored parent host. */
export function lookupLearnedSenderHistory(
  host: string,
  propertyCode?: string | null,
): LearnedSenderHistory | null {
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (senderHostExcluded(h)) return null;
  if (!testsPinned) void refreshIfDue();
  const property = resolveProperty(propertyCode);
  if (!property) {
    if (!testsPinned) return null;
    const row = matchHost(rows, h);
    return row ? historyOf(row) : null;
  }
  const row = matchHost(
    rows.filter((r) => r.propertyCode === property),
    h,
  );
  return row ? historyOf(row) : null;
}

export function partyHistoryBindEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PARTY_HISTORY_BIND === 'on';
}

/** Learn one staff-verified commercial party for an eligible sender host at one hotel. */
export async function recordSenderParty(
  db: DB,
  input: RecordSenderPartyInput,
): Promise<LearnedSenderHistory | null> {
  const propertyCode = normalizeSenderHistoryProperty(input.propertyCode);
  const host = input.host.trim().toLowerCase().replace(/\.+$/, '');
  const name = input.name.replace(/\s+/g, ' ').trim();
  const nativeId = input.nativeId?.trim() || null;
  const iata = input.iata?.trim() || null;
  if (
    !propertyCode ||
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
    .values({ propertyCode, host, kind: input.kind, name, nativeId, iata, support: 1 })
    .onConflictDoUpdate({
      target: [partySenderMap.propertyCode, partySenderMap.host],
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
    propertyCode: saved.propertyCode,
    host: saved.host,
    kind: saved.kind as StoredLearnedSenderRow['kind'],
    name: saved.name,
    nativeId: saved.nativeId,
    iata: saved.iata,
    support: saved.support,
  });
  if (!stored) return null;
  rows = [
    ...rows.filter(
      (row) => !(row.host === stored.host && row.propertyCode === stored.propertyCode),
    ),
    stored,
  ];
  loadedAt = Date.now();
  return historyOf(stored);
}

export async function refreshLearnedSenderMap(db: DB): Promise<number> {
  const found = await db.select().from(partySenderMap);
  rows = take(
    found.map((row) => ({
      propertyCode: row.propertyCode,
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
