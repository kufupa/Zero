#!/usr/bin/env npx tsx
/**
 * Read-only Centurion Sent/Inbox parity auditor.
 * Run on EC2 with production env sourced — SELECT-only. Never Vitest.
 *
 * Hard fail (exit 1):
 *   - navaFromCenturionPostCutover > 0
 *   - INGEST_REQUIRE_OWNER_HEADER parses true
 * Soft warn (exit 0 unless IRT_JOIN_FAIL=1):
 *   - irtJoinRate < 0.90
 *
 * Env: DATABASE_URL, CUTOVER (default 2026-09-09T09:50:00.000Z),
 *      SINCE (optional ISO lower bound for info counts), IRT_JOIN_FAIL=0|1
 *
 * Output: PII-free JSON (counts/rates only — no subjects, addresses, Message-IDs).
 */
import postgres from 'postgres';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';

function parseOwnerHeaderRequire(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return true; // code default when unset
  const n = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(n)) return true;
  if (['0', 'false', 'no', 'off'].includes(n)) return false;
  throw new Error(`invalid INGEST_REQUIRE_OWNER_HEADER=${raw}`);
}

function midShape(mid: string | null): 'outlook' | 'hms' | 'other' {
  const m = (mid ?? '').toLowerCase();
  if (m.includes('$@legacyhotels.co.za') || /@legacyhotels\.co\.za$/i.test(m)) {
    return 'outlook';
  }
  if (m.includes('@mail.legacyhotels.com')) return 'hms';
  return 'other';
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(JSON.stringify({ error: 'DATABASE_URL required' }));
    process.exit(2);
  }

  const cutover = process.env.CUTOVER ?? '2026-09-09T09:50:00.000Z';
  const since = process.env.SINCE ?? cutover;
  const irtJoinFail = process.env.IRT_JOIN_FAIL === '1';
  let ingestRequireOwnerHeader: boolean;
  try {
    ingestRequireOwnerHeader = parseOwnerHeaderRequire(process.env.INGEST_REQUIRE_OWNER_HEADER);
  } catch (err) {
    console.error(JSON.stringify({ error: String((err as Error).message ?? err) }));
    process.exit(2);
  }

  const sql = postgres(url, { ssl: getPostgresSslOptions(url), max: 1, connect_timeout: 30 });

  try {
    const navaRows = await sql<{ n: number }[]>`
      select count(*)::int as n
      from message m
      where m.transport_id = 'transport-nava'
        and lower(m.from_address) like '%centurion%'
        and coalesce(m.received_at, m.created_at) >= ${cutover}::timestamptz
    `;
    const navaFromCenturionPostCutover = navaRows[0]?.n ?? 0;

    const dirCounts = await sql<{ direction: string; n: number }[]>`
      select m.direction, count(*)::int as n
      from message m
      where m.transport_id = 'transport-centurion'
        and lower(m.from_address) like '%centurion@legacyhotels.co.za%'
        and coalesce(m.received_at, m.created_at) >= ${since}::timestamptz
      group by m.direction
    `;
    let centurionOutbound = 0;
    let centurionInboundFromCenturion = 0;
    for (const row of dirCounts) {
      if (row.direction === 'outbound') centurionOutbound = row.n;
      if (row.direction === 'inbound') centurionInboundFromCenturion = row.n;
    }

    const inboundAll = await sql<{ n: number }[]>`
      select count(*)::int as n
      from message m
      where m.transport_id = 'transport-centurion'
        and m.direction = 'inbound'
        and coalesce(m.received_at, m.created_at) >= ${since}::timestamptz
    `;

    const outs = await sql<
      {
        thread_id: string;
        in_reply_to: string | null;
        message_id_header: string | null;
        bcc_addresses: unknown;
      }[]
    >`
      select m.thread_id, m.in_reply_to, m.message_id_header, m.bcc_addresses
      from message m
      where m.transport_id = 'transport-centurion'
        and m.direction = 'outbound'
        and lower(m.from_address) like '%centurion@legacyhotels.co.za%'
        and coalesce(m.received_at, m.created_at) >= ${cutover}::timestamptz
    `;

    let withIrt = 0;
    let sameThread = 0;
    let emptyBcc = 0;
    const midShapeCounts = { outlook: 0, hms: 0, other: 0 };

    for (const o of outs) {
      midShapeCounts[midShape(o.message_id_header)] += 1;
      const bcc = o.bcc_addresses;
      if (Array.isArray(bcc) && bcc.length === 0) emptyBcc += 1;
      else if (bcc == null) emptyBcc += 1;

      if (o.in_reply_to) {
        withIrt += 1;
        const parent = await sql<{ thread_id: string }[]>`
          select thread_id
          from message
          where transport_id = 'transport-centurion'
            and message_id_header = ${o.in_reply_to}
          order by created_at asc
          limit 1
        `;
        if (parent[0]?.thread_id === o.thread_id) sameThread += 1;
      }
    }

    const irtJoinRate = withIrt === 0 ? 1 : sameThread / withIrt;
    const emptyBccRate = outs.length === 0 ? 1 : emptyBcc / outs.length;

    const residue = await sql<{ n: number }[]>`
      select count(*)::int as n
      from message m
      where m.transport_id = 'transport-nava'
        and m.direction = 'inbound'
        and lower(m.from_address) like '%centurion%'
        and lower(coalesce(m.subject, '')) like 'fw:%'
        and coalesce(m.received_at, m.created_at) < ${cutover}::timestamptz
    `;

    const gates = {
      navaFromCenturionPostCutover,
      ingestRequireOwnerHeader,
    };
    const warn = {
      irtJoinRate: Number(irtJoinRate.toFixed(4)),
      irtJoinSample: withIrt,
      irtJoinSameThread: sameThread,
    };
    const info = {
      since,
      centurionOutbound,
      centurionInbound: inboundAll[0]?.n ?? 0,
      centurionInboundFromCenturion,
      midShape: midShapeCounts,
      emptyBccRate: Number(emptyBccRate.toFixed(4)),
      historicalFwResidue: residue[0]?.n ?? 0,
    };

    const report = {
      generatedAt: new Date().toISOString(),
      cutover,
      gates,
      warn,
      info,
    };
    console.log(JSON.stringify(report, null, 2));

    const hardFail =
      navaFromCenturionPostCutover > 0 || ingestRequireOwnerHeader === true;
    const softFail = irtJoinFail && withIrt > 0 && irtJoinRate < 0.9;
    if (hardFail || softFail) process.exit(1);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(2);
});
