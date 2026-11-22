// Seed nava_agent.party_rate from HMS stay captures (anchors.jsonl). Idempotent; dated at HMS capture time.
// usage: DATABASE_URL=... node scripts/seed-party-rate.mjs <anchors.jsonl>
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const rows = [];
for (const line of readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)) {
  const anchor = JSON.parse(line), fields = anchor.hms_fields ?? {};
  const seen = anchor.captured_at ?? anchor.hms_capture_later ?? anchor.hms_available_at;
  const m = /(\d{2})-([A-Z]{3})-(\d{4})/i.exec(fields.arrivaldate ?? '');
  const arrival = m && `${m[3]}-${String('JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(m[2].toUpperCase()) / 3 + 1).padStart(2, '0')}-${m[1]}`;
  if (!fields.rateplan || !seen || !arrival) continue;
  for (const [kind, name] of [['organization', fields.company], ['agency', fields.ta1]]) {
    if (norm(name)) rows.push({ property_code: anchor.property_code ?? 'HRCEN', party_kind: kind, party_name: norm(name), arrival_date: arrival, rate_plan: fields.rateplan, seen_at: seen });
  }
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const unique = [...new Map(rows.map(row => [`${row.property_code}|${row.party_kind}|${row.party_name}|${row.arrival_date}|${row.seen_at}`, row])).values()];
  for (let i = 0; i < unique.length; i += 500) await sql`INSERT INTO nava_agent.party_rate ${sql(unique.slice(i, i + 500))} ON CONFLICT DO NOTHING`;
  console.log(JSON.stringify({ seeded: unique.length }));
} finally { await sql.end(); }
