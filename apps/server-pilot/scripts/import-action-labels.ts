import { MAIL_ACTIONS, type MailAction } from '../src/mail/action-labels.js';
import { mailActionLabel, message } from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';

type Label = { action: MailAction; needsAction: boolean };
type ImportRecord = { messageId: string; model: Label; agent: Label };
export type ImportOptions = { transportId: string; version: string; write?: boolean };
export type ImportCounts = {
  parsed: number;
  matched: number;
  missing: number;
  invalid: number;
  inserted: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLabel(value: unknown): value is Label {
  return (
    isObject(value) &&
    typeof value.action === 'string' &&
    (MAIL_ACTIONS as readonly string[]).includes(value.action) &&
    typeof value.needsAction === 'boolean' &&
    value.needsAction === (value.action !== 'no_action')
  );
}

/** Pure validation; malformed nonblank lines count as parsed and invalid. */
export function parseActionLabelJsonl(input: string): {
  parsed: number;
  invalid: number;
  records: ImportRecord[];
} {
  const result = { parsed: 0, invalid: 0, records: [] as ImportRecord[] };
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    result.parsed++;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      result.invalid++;
      continue;
    }
    if (
      !isObject(value) ||
      typeof value.messageId !== 'string' ||
      !value.messageId.trim() ||
      !isLabel(value.expected) ||
      !Array.isArray(value.predictions) ||
      !isLabel(value.predictions[0])
    ) {
      result.invalid++;
      continue;
    }
    result.records.push({
      messageId: value.messageId,
      agent: { action: value.expected.action, needsAction: value.expected.needsAction },
      model: { action: value.predictions[0].action, needsAction: value.predictions[0].needsAction },
    });
  }
  return result;
}

export function parseImportArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ImportOptions & { file: string; write: boolean } {
  const values = new Map<string, string>();
  let write = false;
  const invalid = () => new Error('Invalid import options');
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--write') {
      if (write) throw invalid();
      write = true;
      continue;
    }
    if (!['--file', '--version', '--transport'].includes(key) || values.has(key)) throw invalid();
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw invalid();
    values.set(key, value);
  }
  const file = values.get('--file');
  const version = values.get('--version');
  const transportId = values.get('--transport') ?? env.HMS_MAILBOX_TRANSPORT_ID?.trim();
  if (!file || !version || !transportId) throw invalid();
  return { file, version, transportId, write };
}

/** All writes for a valid pair share one transaction; dry runs perform reads only. */
export async function importActionLabels(
  db: DB,
  input: string,
  options: ImportOptions,
): Promise<ImportCounts> {
  const parsed = parseActionLabelJsonl(input);
  const counts: ImportCounts = {
    parsed: parsed.parsed,
    matched: 0,
    missing: 0,
    invalid: parsed.invalid,
    inserted: 0,
  };
  for (const record of parsed.records) {
    const [found] = await db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.id, record.messageId), eq(message.transportId, options.transportId)))
      .limit(1);
    if (!found) {
      counts.missing++;
      continue;
    }
    counts.matched++;
    if (!options.write) continue;
    const inserted = await db.transaction(async (tx) =>
      tx
        .insert(mailActionLabel)
        .values([
          {
            transportId: options.transportId,
            messageId: record.messageId,
            version: options.version,
            source: 'model',
            ...record.model,
          },
          {
            transportId: options.transportId,
            messageId: record.messageId,
            version: options.version,
            source: 'agent',
            ...record.agent,
          },
        ])
        .onConflictDoNothing()
        .returning({ id: mailActionLabel.id }),
    );
    counts.inserted += inserted.length;
  }
  return counts;
}

async function main(): Promise<void> {
  const options = parseImportArgs(process.argv.slice(2));
  const input = await readFile(options.file, 'utf8');
  // Lazy DB setup: importing the pure parser never resolves environment or opens a connection.
  const { getDb, closeDb } = await import('../src/db/client.js');
  try {
    const counts = await importActionLabels(getDb(), input, options);
    console.log(JSON.stringify(counts));
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    // Never echo input, filesystem paths, mail IDs, SQL, credentials or raw exceptions.
    console.error('Action label import failed');
    process.exitCode = 1;
  });
}
