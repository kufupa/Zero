#!/usr/bin/env node
/**
 * Idempotent seed for nava_agent.party_booking_memory + sender_party_memory
 * from replay-bench world pairs/anchors (+ optional --seed-json).
 *
 * Usage:
 *   node apps/nava-agent/scripts/seed-memory.mjs [--dry-run] [--seed-json path] [--world dir]
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

const DEFAULT_WORLD = join(homedir(), '.local/share/zero/bench/replay-bench-20261119/world');
const PROPERTY = 'HRCEN';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const worldDir = (() => {
  const i = args.indexOf('--world');
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : DEFAULT_WORLD;
})();
const seedJsonPath = (() => {
  const i = args.indexOf('--seed-json');
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : null;
})();

function normalizePartyName(value) {
  return String(value ?? '').toLowerCase()
    .split(/\bt\s*\/\s*a\b/)
    .map(part => part.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/(?:\s+(?:pty|ltd|limited|cc))+$/, ''))
    .filter(Boolean).join(' ');
}

function boardFromMealOrRate(mealplan, rateplan) {
  const meal = String(mealplan ?? '').toUpperCase();
  const rate = String(rateplan ?? '').toUpperCase();
  if (/\bDBB\b|DINNER/.test(meal) || rate.endsWith('DB') || rate.endsWith('DBB')) return 'DBB';
  if (/\bROOM\s*ONLY\b|\bRO\b/.test(meal) || rate.endsWith('RO') || rate === 'DAY') return 'RO';
  if (/BED\s*(?:AND|&)\s*BREAKFAST|\bB\s*&\s*B\b|\bBB\b|BREAKFAST/.test(meal)
    || rate === 'BAR' || rate === 'EDU' || (rate.endsWith('B') && !rate.endsWith('DB'))) return 'BB';
  return null;
}

function senderHost(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const host = email.trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
  if (!host || /(?:^|\.)(?:(?:gmail|googlemail|outlook|icloud|live|msn|me|aol|protonmail|mail)\.com|(?:yahoo|hotmail)\.(?:com|co\.uk|fr|de|co\.za)|proton\.me|gmx\.(?:com|de|net)|yandex\.(?:com|ru)|(?:mweb|webmail)\.co\.za|telkomsa\.net|legacyhotels?\.(?:com|co\.za))$/.test(host)) {
    return null;
  }
  return host;
}

function firstAddress(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  if (value && typeof value === 'object' && typeof value.email === 'string') return value.email;
  return null;
}

async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}

async function loadCatalogIds(worldDir) {
  const agencies = new Map();
  const organizations = new Map();
  const candidates = [
    join(worldDir, 'catalog.json'),
    join(worldDir, 'catalogs.json'),
    join(worldDir, '..', 'catalog', 'catalog.json'),
    join(worldDir, '..', 'catalog.json'),
  ];
  for (const path of candidates) {
    let raw;
    try { raw = await readFile(path, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const catalogs = data.catalogs ?? data;
    for (const [kind, map] of [['agencies', agencies], ['organizations', organizations]]) {
      const records = catalogs?.[kind]?.records ?? catalogs?.[kind] ?? [];
      if (!Array.isArray(records)) continue;
      for (const row of records) {
        const name = row.meaning ?? row.name ?? row.displayName;
        const id = row.nativeId ?? row.native_id ?? row.code;
        if (name && id != null) map.set(normalizePartyName(String(name)), String(id));
      }
    }
    if (agencies.size || organizations.size) return { agencies, organizations, path };
  }
  return { agencies, organizations, path: null };
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}

function partyKey(property, kind, partyId, field, value) {
  return `${property}\0${kind}\0${partyId}\0${field}\0${value}`;
}

function senderKey(property, host, kind, name) {
  return `${property}\0${host}\0${kind}\0${name}`;
}

async function main() {
  const anchorsPath = join(worldDir, 'anchors.jsonl');
  const pairsPath = join(worldDir, 'pairs.jsonl');
  const { agencies, organizations, path: catalogPath } = await loadCatalogIds(worldDir);

  /** @type {Map<string, number>} */
  const bookingHits = new Map();
  /** @type {Map<string, {hits:number, nativeId:string|null, confirmations:Set<string>}>} */
  const senderHits = new Map();
  /** @type {Map<string, {misses:number, confirmations:Set<string>}>} */
  const senderMisses = new Map();

  const seenConfirmations = new Set();
  let anchorCount = 0;
  let pairCount = 0;
  let bookingFieldRows = 0;
  let senderPartyRows = 0;
  let directMissRows = 0;

  /** confirmation → hms_fields */
  const anchorFields = new Map();
  for await (const row of readJsonl(anchorsPath)) {
    anchorCount += 1;
    const confirmation = String(row.confirmation ?? '');
    const fields = row.hms_fields ?? {};
    if (confirmation) anchorFields.set(confirmation, fields);

    const rateplan = fields.rateplan != null && fields.rateplan !== '' ? String(fields.rateplan) : null;
    const guarantee = fields.guaranteetype ?? fields.guarantee_type ?? fields.guaranteeType ?? null;
    const board = boardFromMealOrRate(fields.mealplan, rateplan);
    const company = String(fields.company ?? '').trim();
    const ta1 = String(fields.ta1 ?? '').trim();
    const agencyId = ta1 ? agencies.get(normalizePartyName(ta1)) ?? `name:${normalizePartyName(ta1)}` : null;
    const organizationId = company ? organizations.get(normalizePartyName(company)) ?? `name:${normalizePartyName(company)}` : null;

    const writes = [];
    if (rateplan) {
      writes.push(['rate_plan', rateplan]);
      if (board) writes.push([`rate_plan:${board}`, rateplan]);
    }
    if (guarantee != null && String(guarantee).trim()) writes.push(['guarantee_type', String(guarantee).trim()]);

    for (const [kind, partyId] of [['agency', agencyId], ['organization', organizationId]]) {
      if (!partyId) continue;
      for (const [field, value] of writes) {
        bump(bookingHits, partyKey(PROPERTY, kind, partyId, field, value));
      }
    }
  }

  // Optional seed json: [{propertyCode, partyKind, partyId, fieldName, fieldValue, hits?}] or sender rows
  if (seedJsonPath) {
    const extra = JSON.parse(await readFile(seedJsonPath, 'utf8'));
    const rows = Array.isArray(extra) ? extra : (extra.party_booking_memory ?? extra.rows ?? []);
    for (const row of rows) {
      if (row.host && row.party_name) {
        const key = senderKey(row.property_code ?? PROPERTY, String(row.host).toLowerCase(), row.party_kind, row.party_name);
        const cur = senderHits.get(key) ?? { hits: 0, nativeId: row.native_id ?? null, confirmations: new Set() };
        cur.hits += Number(row.hits) || 1;
        if (row.native_id) cur.nativeId = String(row.native_id);
        senderHits.set(key, cur);
      } else if (row.party_id && row.field_name && row.field_value != null) {
        bump(bookingHits, partyKey(row.property_code ?? PROPERTY, row.party_kind, row.party_id, row.field_name, String(row.field_value)), Number(row.hits) || 1);
      }
    }
  }

  for await (const pair of readJsonl(pairsPath)) {
    pairCount += 1;
    const confirmation = String(pair.confirmation ?? pair.anchor?.confirmation ?? '');
    if (!confirmation || seenConfirmations.has(confirmation)) continue;
    seenConfirmations.add(confirmation);

    const fields = pair.anchor?.hms_fields ?? anchorFields.get(confirmation) ?? {};
    const company = String(fields.company ?? '').trim();
    const ta1 = String(fields.ta1 ?? '').trim();
    const agencyName = ta1 || null;
    const organizationName = company || null;
    const agencyId = ta1 ? agencies.get(normalizePartyName(ta1)) ?? null : null;
    const organizationId = company ? organizations.get(normalizePartyName(company)) ?? null : null;

    const messages = pair.thread?.messages ?? [];
    let host = null;
    for (const message of messages) {
      if (message?.direction && message.direction !== 'inbound') continue;
      host = senderHost(firstAddress(message?.from));
      if (host) break;
    }
    if (!host) host = senderHost(firstAddress(pair.anchor?.message?.from));
    if (!host) continue;

    if (agencyName) {
      const key = senderKey(PROPERTY, host, 'agency', agencyName);
      const cur = senderHits.get(key) ?? { hits: 0, nativeId: agencyId, confirmations: new Set() };
      if (!cur.confirmations.has(confirmation)) {
        cur.confirmations.add(confirmation);
        cur.hits += 1;
        if (agencyId) cur.nativeId = agencyId;
      }
      senderHits.set(key, cur);
    } else {
      const missKey = `${PROPERTY}\0${host}\0agency`;
      const cur = senderMisses.get(missKey) ?? { misses: 0, confirmations: new Set() };
      if (!cur.confirmations.has(confirmation)) {
        cur.confirmations.add(confirmation);
        cur.misses += 1;
      }
      senderMisses.set(missKey, cur);
    }

    if (organizationName) {
      const key = senderKey(PROPERTY, host, 'organization', organizationName);
      const cur = senderHits.get(key) ?? { hits: 0, nativeId: organizationId, confirmations: new Set() };
      if (!cur.confirmations.has(confirmation)) {
        cur.confirmations.add(confirmation);
        cur.hits += 1;
        if (organizationId) cur.nativeId = organizationId;
      }
      senderHits.set(key, cur);
    }
  }

  bookingFieldRows = bookingHits.size;
  senderPartyRows = senderHits.size;
  directMissRows = senderMisses.size;

  console.log(JSON.stringify({
    dryRun,
    worldDir,
    catalogPath,
    anchors: anchorCount,
    pairs: pairCount,
    uniqueConfirmations: seenConfirmations.size,
    party_booking_memory_rows: bookingFieldRows,
    sender_party_memory_rows: senderPartyRows,
    sender_direct_miss_hosts: directMissRows,
    agencyCatalog: agencies.size,
    organizationCatalog: organizations.size,
  }, null, 2));

  if (dryRun) return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required unless --dry-run');
  const sql = postgres(url, { max: 4 });
  try {
    for (const [key, hits] of bookingHits) {
      const [property_code, party_kind, party_id, field_name, field_value] = key.split('\0');
      await sql`
        INSERT INTO nava_agent.party_booking_memory AS m
          (property_code, party_kind, party_id, field_name, field_value, hits)
        VALUES (${property_code}, ${party_kind}, ${party_id}, ${field_name}, ${field_value}, ${hits})
        ON CONFLICT (property_code, party_kind, party_id, field_name, field_value)
        DO UPDATE SET hits = GREATEST(m.hits, EXCLUDED.hits), updated_at = now()`;
    }
    for (const [key, row] of senderHits) {
      const [property_code, host, party_kind, party_name] = key.split('\0');
      await sql`
        INSERT INTO nava_agent.sender_party_memory AS m
          (property_code, host, party_kind, party_name, native_id, hits, direct_misses)
        VALUES (${property_code}, ${host}, ${party_kind}, ${party_name}, ${row.nativeId}, ${row.hits}, 0)
        ON CONFLICT (property_code, host, party_kind, party_name)
        DO UPDATE SET hits = GREATEST(m.hits, EXCLUDED.hits),
          native_id = COALESCE(EXCLUDED.native_id, m.native_id),
          updated_at = now()`;
    }
    for (const [key, row] of senderMisses) {
      const [property_code, host, party_kind] = key.split('\0');
      await sql`
        UPDATE nava_agent.sender_party_memory
        SET direct_misses = GREATEST(direct_misses, ${row.misses}), updated_at = now()
        WHERE property_code = ${property_code} AND host = ${host} AND party_kind = ${party_kind}`;
    }
    console.log(JSON.stringify({ upserted: true, party_booking_memory_rows: bookingFieldRows, sender_party_memory_rows: senderPartyRows }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
