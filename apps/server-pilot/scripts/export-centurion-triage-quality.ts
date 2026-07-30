/**
 * Read-only Centurion triage quality exporter.
 *
 * Emits production-shaped quality input cases to a requested .tmp path.
 * Expected labels never enter model input.
 * Markdown mailbox dumps are human-review only — never model input or target authority.
 *
 * Scopes (mutually exclusive):
 *   --labels <jsonl>
 *   --all-inbound-triggers
 *   --targets <snapshot-targets.json>
 *
 * Env: DATABASE_URL (read-only SELECTs only)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import {
  buildAllInboundExportCases,
  buildLabelScopedExportCases,
  buildTargetsExportCases,
  parseQualityExportArgs,
  qualityLabelSchema,
  type QualityInputCase,
  type QualityLabel,
} from '../src/ai/quality-eval.js';
import { DEFAULT_AI_MODEL_ID, DEFAULT_TRIAGE_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import type { TriageMessageRow } from '../src/ai/triage-input.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { parseEnv } from '../src/env.js';

const TRANSPORT_ID = 'transport-centurion';

const targetsManifestSchema = z.object({
  generatedAt: z.string().datetime(),
  transportId: z.string().min(1).optional(),
  targets: z
    .array(
      z.object({
        threadId: z.string().min(1),
        triggerMessageId: z.string().min(1),
      }),
    )
    .min(1),
});

function readJsonl<T>(path: string, parse: (row: unknown) => T): T[] {
  const text = readFileSync(path, 'utf8');
  const rows: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(parse(JSON.parse(trimmed)));
  }
  return rows;
}

function writeJsonl(path: string, rows: QualityInputCase[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(path, payload, 'utf8');
}

function toRow(m: {
  id: string;
  fromAddress: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  direction: 'inbound' | 'outbound';
  createdAt: Date;
  receivedAt: Date | null;
  sentAt: Date | null;
}): TriageMessageRow {
  return {
    id: m.id,
    from: m.fromAddress ?? '',
    subject: m.subject ?? undefined,
    body: m.textBody ?? m.htmlBody ?? '',
    direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
    createdAt: m.createdAt,
    receivedAt: m.receivedAt ?? null,
    sentAt: m.sentAt ?? null,
  };
}

async function loadThreadMessages(
  db: ReturnType<typeof drizzle>,
  threadId: string,
): Promise<TriageMessageRow[]> {
  const rows = await db
    .select({
      id: message.id,
      fromAddress: message.fromAddress,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      direction: message.direction,
      createdAt: message.createdAt,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
    })
    .from(message)
    .where(and(eq(message.threadId, threadId), eq(message.transportId, TRANSPORT_ID)))
    .orderBy(asc(message.createdAt), asc(message.id));
  return rows.map(toRow);
}

async function loadNormalRunAsOfByTrigger(
  db: ReturnType<typeof drizzle>,
  triggerIds: string[],
): Promise<Map<string, string>> {
  if (triggerIds.length === 0) return new Map();
  const rows = await db
    .select({
      triggerMessageId: aiWorkflowRun.triggerMessageId,
      createdAt: aiWorkflowRun.createdAt,
    })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, TRANSPORT_ID),
        eq(aiWorkflowRun.runKind, 'inbound_triage'),
        inArray(aiWorkflowRun.triggerMessageId, triggerIds),
      ),
    )
    .orderBy(asc(aiWorkflowRun.createdAt));

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.triggerMessageId)) {
      map.set(row.triggerMessageId, row.createdAt.toISOString());
    }
  }
  return map;
}

export async function exportCenturionTriageQuality(argv: string[]): Promise<{
  mode: string;
  outPath: string;
  count: number;
}> {
  const args = parseQualityExportArgs(argv);
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const conn = postgres(env.DATABASE_URL, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn);
  const modelId = process.env.AI_MODEL_ID?.trim() || DEFAULT_AI_MODEL_ID;
  const promptVersion = process.env.AI_TRIAGE_PROMPT_VERSION?.trim() || DEFAULT_TRIAGE_PROMPT_VERSION;

  try {
    const exported: QualityInputCase[] = [];

    if (args.mode === 'labels') {
      const labels = readJsonl(resolve(args.labelsPath), (row) => qualityLabelSchema.parse(row));
      const byThread = new Map<string, QualityLabel[]>();
      // Labels alone do not carry threadId; resolve via trigger message row.
      const triggerIds = labels.map((l) => l.triggerMessageId);
      const triggerRows = await db
        .select({
          id: message.id,
          threadId: message.threadId,
        })
        .from(message)
        .where(and(eq(message.transportId, TRANSPORT_ID), inArray(message.id, triggerIds)));
      const threadByTrigger = new Map(triggerRows.map((r) => [r.id, r.threadId]));
      for (const label of labels) {
        const threadId = threadByTrigger.get(label.triggerMessageId);
        if (!threadId) {
          throw new Error(`label trigger not found: ${label.triggerMessageId}`);
        }
        const list = byThread.get(threadId) ?? [];
        list.push(label);
        byThread.set(threadId, list);
      }
      for (const [threadId, threadLabels] of byThread) {
        const messages = await loadThreadMessages(db, threadId);
        exported.push(
          ...buildLabelScopedExportCases({
            transportId: TRANSPORT_ID,
            threadId,
            messages,
            labels: threadLabels,
            modelId,
            promptVersion,
          }),
        );
      }
    } else if (args.mode === 'targets') {
      const manifest = targetsManifestSchema.parse(
        JSON.parse(readFileSync(resolve(args.targetsPath), 'utf8')),
      );
      if (manifest.transportId && manifest.transportId !== TRANSPORT_ID) {
        throw new Error(`targets transportId must be ${TRANSPORT_ID}`);
      }
      const byThread = new Map<string, string>();
      for (const target of manifest.targets) {
        if (byThread.has(target.threadId)) {
          throw new Error(`duplicate target threadId: ${target.threadId}`);
        }
        byThread.set(target.threadId, target.triggerMessageId);
      }
      for (const [threadId, triggerMessageId] of byThread) {
        const messages = await loadThreadMessages(db, threadId);
        exported.push(
          ...buildTargetsExportCases({
            transportId: TRANSPORT_ID,
            threadId,
            messages,
            triggerMessageId,
            generatedAt: manifest.generatedAt,
            modelId,
            promptVersion,
          }),
        );
      }
    } else {
      const allMessages = await db
        .select({
          id: message.id,
          threadId: message.threadId,
          fromAddress: message.fromAddress,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          direction: message.direction,
          createdAt: message.createdAt,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
        })
        .from(message)
        .where(eq(message.transportId, TRANSPORT_ID))
        .orderBy(asc(message.threadId), asc(message.createdAt), asc(message.id));

      const byThread = new Map<string, typeof allMessages>();
      for (const row of allMessages) {
        const list = byThread.get(row.threadId) ?? [];
        list.push(row);
        byThread.set(row.threadId, list);
      }

      const allInboundIds = allMessages
        .filter((m) => m.direction === 'inbound')
        .map((m) => m.id);
      const runAsOf = await loadNormalRunAsOfByTrigger(db, allInboundIds);

      for (const [threadId, rows] of byThread) {
        const messages = rows.map(toRow);
        const asOfByTriggerId: Record<
          string,
          { asOf: string; asOfSource: 'normal-run-created-at' | 'message-created-at' }
        > = {};
        for (const m of messages) {
          if (m.direction !== 'inbound') continue;
          const fromRun = runAsOf.get(m.id);
          if (fromRun) {
            asOfByTriggerId[m.id] = { asOf: fromRun, asOfSource: 'normal-run-created-at' };
          } else {
            asOfByTriggerId[m.id] = {
              asOf: m.createdAt.toISOString(),
              asOfSource: 'message-created-at',
            };
          }
        }
        exported.push(
          ...buildAllInboundExportCases({
            transportId: TRANSPORT_ID,
            threadId,
            messages,
            asOfByTriggerId,
            modelId,
            promptVersion,
          }),
        );
      }
    }

    // Labels must never appear on exported model inputs.
    for (const row of exported) {
      const keys = Object.keys(row);
      if (keys.some((k) => /expected|label|adjudication|policyReason/i.test(k))) {
        throw new Error('refusing to export label fields into model input');
      }
    }

    const outPath = resolve(args.outPath);
    writeJsonl(outPath, exported);
    return { mode: args.mode, outPath, count: exported.length };
  } finally {
    await conn.end();
  }
}

async function main(): Promise<void> {
  const result = await exportCenturionTriageQuality(process.argv.slice(2));
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
