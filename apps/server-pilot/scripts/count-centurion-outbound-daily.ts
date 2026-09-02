#!/usr/bin/env npx tsx
/** Read-only daily Centurion/PMBOBO outbound counts — auto vs manual heuristics. JSON stdout only. */
import postgres from 'postgres';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';

const CHANNEL_BODY_SUBJECT = [
  'confirmation letter',
  'booking update',
  'reservation confirmation',
  'new booking',
  'cancellation',
  'modification',
  'folio',
  'invoice',
  'voucher',
  'pre-arrival',
  'guestrevu',
  'review',
  'fortimail',
  'quarantine',
  'unpaid',
  'failure notification',
  'update failure',
];

function isAutoOutbound(subject: string | null, toAddrs: string | null): boolean {
  const subj = (subject ?? '').toLowerCase();
  const toL = (toAddrs ?? '').toLowerCase();
  let autoSignals = 0;
  if (CHANNEL_BODY_SUBJECT.some((x) => subj.includes(x))) autoSignals += 1;
  if (
    ['confirmation letter', 'booking update', 'daily summary', 'notification'].some((x) =>
      subj.includes(x),
    )
  ) {
    autoSignals += 1;
  }
  if (['booking.com', 'expedia', 'guestrevu', 'fortimail'].some((x) => toL.includes(x))) {
    autoSignals += 1;
  }
  return (
    autoSignals >= 2 ||
    (autoSignals === 1 &&
      ['confirmation letter', 'booking update', 'notification'].some((x) => subj.includes(x)))
  );
}

function actor(fromAddr: string): 'centurion' | 'pmbobo' | null {
  const e = fromAddr.trim().toLowerCase();
  if (e === 'centurion@legacyhotels.co.za' || e === 'navaai@legacyhotels.co.za') {
    return 'centurion';
  }
  if (e.includes('pmbobo')) return 'pmbobo';
  return null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const sql = postgres(url, { ssl: getPostgresSslOptions(url), max: 1 });
  const tid = 'transport-centurion';
  const daysBack = Number(process.env.DAYS_BACK ?? '21');

  try {
    const rows = await sql<
      {
        day: string;
        direction: string;
        from_addr: string;
        subject: string | null;
        to_addrs: string | null;
        c: number;
      }[]
    >`
      select
        to_char(
          date(coalesce(m.received_at, m.sent_at, m.created_at) at time zone 'UTC'),
          'YYYY-MM-DD'
        ) as day,
        m.direction,
        lower(m.from_address) as from_addr,
        m.subject,
        lower(coalesce(m.to_addresses::text, '')) as to_addrs,
        count(*)::int as c
      from message m
      where m.transport_id = ${tid}
        and m.direction = 'outbound'
        and date(coalesce(m.received_at, m.sent_at, m.created_at) at time zone 'UTC')
          >= (current_date - ${daysBack}::int)
        and (
          lower(m.from_address) in ('centurion@legacyhotels.co.za', 'navaai@legacyhotels.co.za')
          or lower(m.from_address) like '%pmbobo%'
        )
      group by 1, 2, 3, 4, 5
      order by 1, 2, 3
    `;

    type Bucket = { manual: number; auto: number; total: number };
    const byDay = new Map<
      string,
      { centurion: Bucket; pmbobo: Bucket; asOf: string }
    >();

    for (const row of rows) {
      const a = actor(row.from_addr);
      if (!a || row.direction !== 'outbound') continue;
      const day = String(row.day).slice(0, 10);
      if (!byDay.has(day)) {
        byDay.set(day, {
          centurion: { manual: 0, auto: 0, total: 0 },
          pmbobo: { manual: 0, auto: 0, total: 0 },
          asOf: new Date().toISOString(),
        });
      }
      const entry = byDay.get(day)!;
      const bucket = entry[a];
      const auto = isAutoOutbound(row.subject, row.to_addrs);
      if (auto) bucket.auto += row.c;
      else bucket.manual += row.c;
      bucket.total += row.c;
    }

    const daily = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v }));

    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          transportId: tid,
          daysBack,
          daily,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
