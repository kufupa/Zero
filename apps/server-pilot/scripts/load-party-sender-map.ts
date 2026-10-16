/** Load learned sender-host map into party_sender_map. Prints counts only. Never prints host or name. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { partySenderMap } from '../src/db/schema/party-sender-map.js';

const DEFAULT_FILE = '/home/orca/nava-research/gold/party-key/sender-host-map-20261016.json';
// A host must be a plain domain, and never one of the hotel's own: our staff mail is not a company or agency.
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const OWN_DOMAIN = /(^|\.)legacyhotels\.co\.za$/;

function fileArg(argv: string[]): string {
  const i = argv.indexOf('--file');
  const raw = i >= 0 ? argv[i + 1] : DEFAULT_FILE;
  if (!raw) throw new Error('usage: load-party-sender-map.ts [--file PATH]');
  return resolve(raw);
}

function parseRows(raw: unknown): Array<{ host: string; kind: 'company' | 'agency'; name: string; support: number }> {
  if (!Array.isArray(raw)) throw new Error('map JSON must be an array');
  const out: Array<{ host: string; kind: 'company' | 'agency'; name: string; support: number }> = [];
  let skipped = 0;
  for (const item of raw) {
    const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const host = typeof rec?.host === 'string' ? rec.host.trim().toLowerCase().replace(/\.+$/, '') : '';
    const name = typeof rec?.name === 'string' ? rec.name.replace(/\s+/g, ' ').trim() : '';
    const kind = rec?.kind === 'company' || rec?.kind === 'agency' ? rec.kind : null;
    const support = Number(rec?.support);
    if (!HOST.test(host) || OWN_DOMAIN.test(host) || !name || !kind || !Number.isInteger(support) || support < 1) {
      skipped += 1;
      continue;
    }
    out.push({ host, kind, name, support });
  }
  if (skipped) console.log(`skipped ${skipped} invalid rows`);
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const rows = parseRows(JSON.parse(readFileSync(fileArg(process.argv.slice(2)), 'utf8')));
  const { db, conn } = createDb(url);
  try {
    if (!rows.length) {
      console.log('loaded 0');
      return;
    }
    await db.insert(partySenderMap).values(rows).onConflictDoUpdate({
      target: partySenderMap.host,
      set: { kind: sql`excluded.kind`, name: sql`excluded.name`, support: sql`excluded.support` },
    });
    console.log(`loaded ${rows.length}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
