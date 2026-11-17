import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { threadInput, type ThreadInput } from './schema.js';
import { uniqueMessages } from './mail-ingest.js';

const id = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const sourceMessage = z.object({
  thread_id: id, message_id: id, timestamp, direction: z.enum(['inbound', 'outbound']), subject: z.string(),
  addresses: z.object({ from: z.array(z.string()).length(1), to: z.array(z.string()), cc: z.array(z.string()) }),
  body: z.string(),
});
const trainRecord = z.object({
  decision_id: id, split: z.literal('train'), input_cutoff: timestamp, selected_message: sourceMessage,
  earlier_relevant_source_events: z.array(z.object({ message: sourceMessage })),
});
const approvedSha256 = '34e6aafb566b0b3e248e04f0793f1dfc8235df83630775a0d8dda5c37a89bcaa';

type SourceMessage = z.infer<typeof sourceMessage>;
function projectMessage(m: SourceMessage): ThreadInput['messages'][number] {
  return {
    id: m.message_id, rfc_message_id: null, direction: m.direction,
    from: { name: null, email: m.addresses.from[0] },
    to: m.addresses.to.map(email => ({ name: null, email })),
    cc: m.addresses.cc.map(email => ({ name: null, email })),
    received_at: m.timestamp, subject: m.subject, body_text: m.body, body_html: null, attachments: [],
  };
}

/** Only source messages at the decision cutoff enter the agent-visible thread. */
export function normalizeTrainCase(raw: unknown, runId: string, mailboxId: string): ThreadInput {
  const run = id.parse(runId);
  const mailbox = id.parse(mailboxId);
  const record = trainRecord.parse(raw);
  const cutoff = Date.parse(record.input_cutoff);
  if (record.selected_message.direction !== 'inbound') throw new Error('SELECTED_INBOUND_MISSING');
  if (Date.parse(record.selected_message.timestamp) > cutoff) throw new Error('SELECTED_AFTER_CUTOFF');
  const messages = uniqueMessages([
    ...record.earlier_relevant_source_events.map(e => e.message).filter(m => Date.parse(m.timestamp) <= cutoff),
    record.selected_message,
  ].map(projectMessage));
  return threadInput.parse({
    source: 'eval', source_thread_id: JSON.stringify([run, record.selected_message.thread_id, record.decision_id]),
    mailbox_id: mailbox, selected_message_id: record.selected_message.message_id, property_code: null,
    mode: 'historical', messages, decision_id: record.decision_id, input_cutoff: record.input_cutoff,
  });
}

/** The pinned model-safe file may contain holdouts; select only the requested train record. */
export async function loadTrainCase(path: string, decision: string): Promise<unknown> {
  id.parse(decision);
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', chunk => hash.update(chunk));
  let found: unknown;
  let duplicate = false;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== 'object' || raw === null || !('split' in raw) || raw.split !== 'train' ||
        !('decision_id' in raw) || raw.decision_id !== decision) continue;
    if (found !== undefined) duplicate = true;
    else found = raw;
  }
  if (hash.digest('hex') !== approvedSha256) throw new Error('Only the approved model-safe dataset is accepted');
  if (duplicate) throw new Error('DUPLICATE_TRAIN_DECISION');
  if (found === undefined) throw new Error('Train decision not found');
  return found;
}

async function main() {
  const [path, decision, run, mailbox] = process.argv.slice(2);
  if (!path || !decision || !run || !mailbox || !process.env.DATABASE_URL) {
    throw new Error('Usage: import-train <model-safe-inputs.jsonl> <decision_id> <run_id> <mailbox_id>; DATABASE_URL required');
  }
  const input = normalizeTrainCase(await loadTrainCase(path, decision), run, mailbox);
  const [{ importThread }, { sql }] = await Promise.all([import('./runtime.js'), import('./db.js')]);
  try {
    const outcome = await importThread(input, JSON.stringify(['train', run, decision]));
    process.stdout.write(JSON.stringify({ thread_id: outcome.id, created: outcome.created }) + '\n');
  } finally { await sql.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
