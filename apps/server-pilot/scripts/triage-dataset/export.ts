/**
 * Triage dataset export (read-only). Writes gzipped JSONL under a local output dir for the leak-free triage eval.
 *
 *   threads: every message of every thread that has an inbound in the window, with attachment metadata. Used for
 *            silver labels (staff outbound evidence) and prior-only context.
 *   selections: for --message-ids-file targets, the prod `loadSyncedQuoteSelectionFromMailbox` output (attachment
 *            text via prod `readQuoteAttachments`). Image/PDF bytes are dropped; only their presence is kept.
 *
 * Never writes to the database. Logs print counts only, no subject, body or address.
 *
 * Run on EC2 from apps/server-pilot (env from .env.production):
 *   pnpm exec tsx scripts/triage-dataset/export.ts threads --transport-id <id> --since <iso> --until <iso> --out <dir>
 *   pnpm exec tsx scripts/triage-dataset/export.ts selections --transport-id <id> --message-ids-file <file> --out <dir>
 */
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { closeDb, getConn } from '../../src/db/client.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../../src/ai/quote-workflow-synced-selection.js';

const BODY_MAX = 100_000;

function gzWriter(path: string) {
  const gz = createGzip();
  const out = createWriteStream(path);
  gz.pipe(out);
  return {
    write: (row: unknown) => gz.write(`${JSON.stringify(row)}\n`),
    close: () => new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      gz.end();
    }),
  };
}

async function exportThreads(transportId: string, since: string, until: string, outDir: string) {
  const sql = getConn();
  const threadIds = (
    await sql<{ thread_id: string }[]>`
      select distinct thread_id from message
      where transport_id = ${transportId} and direction = 'inbound'
        and coalesce(received_at, created_at) >= ${since}::timestamptz
        and coalesce(received_at, created_at) <= ${until}::timestamptz`
  ).map((row) => row.thread_id);
  const writer = gzWriter(join(outDir, `threads-${transportId}.jsonl.gz`));
  let messages = 0;
  for (let i = 0; i < threadIds.length; i += 200) {
    const batch = threadIds.slice(i, i + 200);
    const rows = await sql<Record<string, unknown>[]>`
      select m.id, m.thread_id, m.direction, m.message_id_header, m.in_reply_to, m."references",
        m.from_address, m.to_addresses, m.cc_addresses, m.subject, left(m.text_body, ${BODY_MAX}) as text_body,
        m.received_at, m.sent_at, m.created_at, mt.email as mailbox,
        coalesce((select json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mime', a.mime_type,
          'size', a.size_bytes, 'inline', a.is_inline) order by a.id)
          from attachment a where a.message_id = m.id), '[]'::json) as attachments,
        exists (select 1 from mail_thread_category mtc join mail_category mc on mc.id = mtc.category_id
          where mtc.thread_id = m.thread_id and mtc.transport_id = m.transport_id
            and mc.slug = 'automated-channel') as automated_channel
      from message m left join mailbox_transport mt on mt.id = m.transport_id
      where m.transport_id = ${transportId} and m.thread_id in ${sql(batch)}
      order by m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at), m.id`;
    for (const row of rows) writer.write(row);
    messages += rows.length;
  }
  await writer.close();
  const labels = await sql<Record<string, unknown>[]>`
    select l.message_id, l.source, l.action, l.needs_action, l.version, l.labelled_by, l.updated_at
    from mail_action_label l where l.transport_id = ${transportId}`;
  const labelWriter = gzWriter(join(outDir, `labels-${transportId}.jsonl.gz`));
  for (const row of labels) labelWriter.write(row);
  await labelWriter.close();
  const extractions = await sql<Record<string, unknown>[]>`
    select distinct on (e.message_id) e.message_id, e.extractor_version, e.status, e.kind,
      e.payload->>'action' as action, e.payload->>'needsAction' as needs_action, e.created_at
    from mail_extraction e join message m on m.id = e.message_id
    where m.transport_id = ${transportId} and m.direction = 'inbound'
      and coalesce(m.received_at, m.created_at) >= ${since}::timestamptz
      and coalesce(m.received_at, m.created_at) <= ${until}::timestamptz
    order by e.message_id, e.created_at desc`;
  const extractionWriter = gzWriter(join(outDir, `prod-extractions-${transportId}.jsonl.gz`));
  for (const row of extractions) extractionWriter.write(row);
  await extractionWriter.close();
  console.log(
    JSON.stringify({ mode: 'threads', threads: threadIds.length, messages, labels: labels.length, extractions: extractions.length }),
  );
}

async function exportSelections(transportId: string, idsFile: string, outDir: string, concurrency: number) {
  const ids = readFileSync(idsFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const writer = gzWriter(join(outDir, `selections-${transportId}.jsonl.gz`));
  let ok = 0;
  let missing = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const messageId = ids[next++];
      try {
        const selection = await loadSyncedQuoteSelectionFromMailbox({
          transportId,
          messageId,
          includeThreadState: true,
          includeVisionImages: false,
          trackVisionImages: true,
          signal: AbortSignal.timeout(120_000),
        });
        if (!selection) {
          missing += 1;
          writer.write({ messageId, missing: true });
          continue;
        }
        writer.write({
          ...selection,
          attachments: selection.attachments.map(({ pdf, image, ...rest }) => ({
            ...rest,
            hadPdfBytes: Boolean(pdf),
            hadImage: Boolean(image),
          })),
        });
        ok += 1;
      } catch (error) {
        failed += 1;
        writer.write({ messageId, error: error instanceof Error ? error.name : 'unknown' });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await writer.close();
  console.log(JSON.stringify({ mode: 'selections', requested: ids.length, ok, missing, failed }));
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'transport-id': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'message-ids-file': { type: 'string' },
      out: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const mode = positionals[0];
  const transportId = values['transport-id'];
  const outDir = values.out;
  if (!transportId || !outDir) throw new Error('--transport-id and --out are required');
  mkdirSync(outDir, { recursive: true });
  if (mode === 'threads') {
    if (!values.since || !values.until) throw new Error('--since and --until are required');
    await exportThreads(transportId, values.since, values.until, outDir);
  } else if (mode === 'selections') {
    if (!values['message-ids-file']) throw new Error('--message-ids-file is required');
    await exportSelections(transportId, values['message-ids-file'], outDir, Number(values.concurrency ?? '4'));
  } else {
    throw new Error('mode must be threads or selections');
  }
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : 'export failed');
    await closeDb();
    process.exit(1);
  });
