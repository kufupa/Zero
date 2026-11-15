#!/usr/bin/env node
// Daily HMS workflow scoreboard: one table of counts from work_event, work_item and ai_workflow_run.
// Read-only (READ ONLY snapshot transaction, SELECTs only). Prints counts, ids, enums and field paths; never
// guest names, emails or field values.
//
// Usage (from apps/server-pilot; the operator passes the connection string explicitly, it is never read from
// DATABASE_URL or TEST_DATABASE_URL):
//   SCOREBOARD_DATABASE_URL=... node scripts/hms-workflow-scoreboard.mjs [--since <ISO date>] [--transport <id>]
// --since defaults to the last 24 hours. Field edits are staff field.edit events on drafts seeded in the window.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const V2_KEY = 'reservationWorkflowV2';

function readArg(name) {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`VALUE_REQUIRED_${name.slice(2).toUpperCase()}`);
  return value;
}

/** Ids and indexes become *, so one field counts as one path across drafts. */
function fieldName(fieldPath) {
  return fieldPath
    .replace(/\/(requests|services|documents|groups|allocations|include|exclude)\/[^/]+/g, '/$1/*')
    .replace(/\/\d+(?=\/|$)/g, '/*')
    .replace(/\[[^\]]+\]/g, '[*]')
    .replace(/[^A-Za-z0-9_.:/*[\]-]/g, '?')
    .slice(0, 120);
}

const minutes = (row) => (row?.n ? `${(Number(row.seconds) / 60).toFixed(1)} min (n=${row.n})` : 'n/a (n=0)');

async function main() {
  const url = process.env.SCOREBOARD_DATABASE_URL;
  if (!url) throw new Error('SCOREBOARD_DATABASE_URL_REQUIRED');
  const since = new Date(readArg('--since') ?? Date.now() - 24 * 60 * 60_000);
  if (!Number.isFinite(since.getTime())) throw new Error('SINCE_MUST_BE_AN_ISO_DATE');
  const transport = readArg('--transport') ?? null;
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error('SCOREBOARD_DATABASE_URL_INVALID'); }
  const ca = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'rds-ca-global.pem');
  const ssl = ['127.0.0.1', 'localhost', '[::1]'].includes(host) ? false
    : fs.existsSync(ca) ? { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') } : 'require';
  const sql = postgres(url, { max: 1, ssl, connect_timeout: 30, onnotice: () => {},
    connection: { default_transaction_read_only: 'on', application_name: 'hms-workflow-scoreboard' } });
  const rows = [];
  const add = (section, key, value) => rows.push([section, String(key), String(value)]);
  try {
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      // work_event.at and ai_workflow_run timestamps are UTC wall-clock without a zone.
      const from = tx`(${since.toISOString()}::timestamptz at time zone 'UTC')`;
      const scope = transport ? tx`and wi.transport_id = ${transport}` : tx``;
      const events = tx`work_event e join work_item wi on wi.id = e.work_item_id`;
      const seeded = tx`(select distinct e.work_item_id from ${events}
        where e.type = 'field.seed' and e.field_path = ${V2_KEY} and e.at >= ${from} ${scope})`;

      for (const row of await tx`select coalesce(e.actor_user_id, '(none)') as actor, count(*)::int as opens,
          count(distinct e.work_item_id)::int as items from ${events}
          where e.type = 'pane.opened' and e.at >= ${from} ${scope} group by 1 order by 2 desc`)
        add('opened by user', row.actor, `${row.opens} opens, ${row.items} items`);

      const seededKinds = await tx`select wi.kind, count(*)::int as drafts from work_item wi
        where wi.id in ${seeded} group by 1 order by 2 desc`;
      const seededTotal = seededKinds.reduce((total, row) => total + row.drafts, 0);
      add('drafts seeded', 'all', seededTotal);
      for (const row of seededKinds) add('drafts seeded', `mail kind ${row.kind}`, row.drafts);
      for (const row of await tx`select coalesce(request->>'kind', '(none)') as kind, count(*)::int as requests
          from work_item wi cross join lateral jsonb_array_elements(case
            when jsonb_typeof(wi.state->${V2_KEY}->'proposal'->'content'->'requests') = 'array'
            then wi.state->${V2_KEY}->'proposal'->'content'->'requests' else '[]'::jsonb end) request
          where wi.id in ${seeded} group by 1 order by 2 desc`)
        add('drafts seeded', `current request ${row.kind}`, row.requests);

      for (const row of await tx`select r.run_kind::text as kind, r.state::text as state,
          coalesce(r.failure_class, '') as failure_class, count(*)::int as n from ai_workflow_run r
          where r.run_kind in ('reservation_prefill', 'hms_write') and r.created_at >= ${from}
            ${transport ? tx`and r.transport_id = ${transport}` : tx``}
          group by 1, 2, 3 order by 1 desc, 4 desc`)
        add(row.kind === 'hms_write' ? 'hms_write jobs' : 'prefill jobs',
          `${row.state === 'dead_letter' ? 'failed (dead_letter)' : row.state === 'succeeded' ? 'completed' : row.state}${
            row.failure_class ? ` ${row.failure_class}` : ''}`, row.n);

      for (const row of await tx`select coalesce(e.value->>'operation', '(none)') as operation,
          count(*) filter (where e.type = 'hms.prepared')::int as prepared,
          count(*) filter (where e.type = 'approval.granted')::int as granted from ${events}
          where e.type in ('hms.prepared', 'approval.granted') and e.at >= ${from} ${scope} group by 1 order by 1`) {
        add('prepares succeeded', row.operation, row.prepared);
        add('Go granted', row.operation, row.granted);
      }

      const median = (a, b) => tx`percentile_cont(0.5) within group (order by extract(epoch from (${b} - ${a}))) as seconds,
        count(*)::int as n`;
      const [openToPrepare] = await tx`select ${median(tx`o.at`, tx`p.at`)} from (select e.work_item_id, min(e.at) as at
          from ${events} where e.type = 'hms.prepared' and e.at >= ${from} ${scope} group by 1) p
        join lateral (select min(at) as at from work_event where work_item_id = p.work_item_id
          and type = 'pane.opened' and at <= p.at) o on o.at is not null`;
      const [prepareToGo] = await tx`select ${median(tx`p.at`, tx`e.at`)} from ${events}
        join work_event p on p.work_item_id = e.work_item_id and p.type = 'hms.prepared'
          and p.id::text = e.value->>'preparedRef'
        where e.type = 'approval.granted' and e.at >= ${from} ${scope}`;
      const [goToSaved] = await tx`select ${median(tx`e.at`, tx`r.finished_at`)} from ${events}
        join ai_workflow_run r on r.idempotency_key = 'hms-write:' || e.id::text and r.run_kind = 'hms_write'
          and r.state = 'succeeded' and r.finished_at is not null
        where e.type = 'approval.granted' and e.at >= ${from} ${scope}`;
      add('median time', 'first open -> first prepare', minutes(openToPrepare));
      add('median time', 'prepare -> Go', minutes(prepareToGo));
      add('median time', 'Go -> hms_write completed', minutes(goToSaved));

      const fields = new Map();
      for (const row of await tx`select e.field_path, e.work_item_id, count(*)::int as edits from ${events}
          where e.type = 'field.edit' and e.actor_kind = 'user' and e.field_path is not null and e.at >= ${from}
            and e.work_item_id in ${seeded} group by 1, 2`) {
        const field = fields.get(fieldName(row.field_path)) ?? { edits: 0, drafts: new Set() };
        field.edits += row.edits;
        field.drafts.add(row.work_item_id);
        fields.set(fieldName(row.field_path), field);
      }
      for (const [name, field] of [...fields].sort((a, b) => b[1].edits - a[1].edits).slice(0, 15))
        add('field edits (top 15)', name, `${field.edits} edits, ${field.drafts.size} drafts, ${
          (field.edits / Math.max(seededTotal, 1)).toFixed(2)} per seeded draft`);

      const [marks] = await tx`select count(*) filter (where e.type = 'review.flag')::int as flags,
          count(*) filter (where e.type = 'review.ok')::int as oks,
          count(*) filter (where e.type = 'pane.error')::int as errors from ${events}
        where e.type in ('review.flag', 'review.ok', 'pane.error') and e.at >= ${from} ${scope}`;
      add('review', 'flags', marks.flags);
      add('review', 'ok', marks.oks);
      add('pane errors', 'all', marks.errors);

      const [funnel] = await tx`select count(*)::int as opened, count(*) filter (where not exists (
          select 1 from work_event g where g.work_item_id = wi.id and g.type = 'approval.granted'))::int as no_go
        from work_item wi where wi.state ? ${V2_KEY} ${scope} and exists (select 1 from work_event e
          where e.work_item_id = wi.id and e.type = 'pane.opened' and e.at >= ${from})`;
      add('drafts opened, never Go', 'drafts', `${funnel.no_go} of ${funnel.opened} opened`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  const table = [['section', 'key', 'value'], ...rows];
  const widths = [0, 1].map((column) => Math.max(...table.map((row) => row[column].length)));
  console.log(`HMS workflow scoreboard since ${since.toISOString()}${transport ? `, transport ${transport}` : ''}`);
  for (const row of table) console.log(`${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`);
}

main().catch((error) => {
  // Connection and login errors can carry the connection string or user; print their code only.
  const sqlError = error?.name === 'PostgresError' && !String(error.code).startsWith('28');
  const own = /^[A-Z0-9_]+$/.test(error?.message ?? '');
  console.error(`scoreboard failed: ${own ? error.message : sqlError ? `${error.code} ${error.message}` : error?.code ?? 'unknown'}`);
  process.exitCode = 1;
});
