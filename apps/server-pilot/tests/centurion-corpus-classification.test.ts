import {
  CLASSIFICATION_SCHEMA_VERSION,
  DEFAULT_LUNA_MODEL_ID,
  WORKFLOW_CLASSES,
  classifyCenturionNineDayCorpus,
  type CenturionClassificationWorkerRequest,
  type CenturionClassificationWorkerResponse,
} from '../scripts/classify-centurion-nine-day-corpus';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const WINDOW_START = '2026-09-07T22:00:00.000Z';
const WINDOW_END = '2026-09-16T22:00:00.000Z';

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifestFor(
  schemaVersion: 'centurion-nine-day-corpus-v1' | 'centurion-quarantine-v1',
  snapshotId: string,
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const ordered = records.map((record) => JSON.stringify(record)).join('\n');
  return {
    schemaVersion,
    snapshotId,
    exporterVersion: 'fixture',
    orderedMessageSha256:
      schemaVersion === 'centurion-nine-day-corpus-v1' ? sha(ordered) : undefined,
    orderedRecordSha256: schemaVersion === 'centurion-quarantine-v1' ? sha(ordered) : undefined,
    counts: { sourceRows: records.length, logicalMessages: records.length },
    window: {
      startInclusive: WINDOW_START,
      endExclusive: WINDOW_END,
      timezone: 'Africa/Johannesburg',
    },
  };
}

function normalRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'normal-1',
    transportId: 'transport-centurion',
    threadId: 'thread-1',
    messageId: '<normal-1@example.test>',
    direction: 'inbound',
    messageDirection: 'inbound',
    businessDirection: 'inbound',
    businessDirectionSource: 'transport_identity',
    subject: 'Synthetic request',
    textBody: 'Short synthetic body',
    htmlBody: '<p>Short synthetic body</p>',
    from: ['guest@example.test'],
    to: ['centurion@example.test'],
    cc: [],
    bcc: [],
    receivedAt: '2026-09-08T08:00:00.000Z',
    sentAt: null,
    createdAt: '2026-09-08T08:00:01.000Z',
    eventAt: '2026-09-08T08:00:00.000Z',
    eventAtSource: 'received_at',
    eventAtFallback: false,
    inReplyTo: null,
    references: [],
    rawMimeLocator: null,
    attachmentDescriptors: [],
    confirmedOutbound: false,
    queueState: null,
    scope: 'in_window',
    contextOnly: false,
    dailyIncluded: true,
    ...overrides,
  };
}

function quarantineRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    recordType: 'quarantine',
    schemaVersion: 'centurion-quarantine-v1',
    id: 'quarantine-1',
    ingestMailboxId: 'ingest-nava-legacy',
    ingestMailboxEmail: 'centurion@example.test',
    pop3Uidl: 'uidl-1',
    reason: 'parse_failure',
    ownerHeaderValue: 'centurion@example.test',
    parsedHeaders: null,
    quarantineCreatedAt: '2026-09-09T08:00:00.000Z',
    messageDate: '2026-09-09T08:00:00.000Z',
    dateHeader: 'Wed, 09 Sep 2026 08:00:00 +0000',
    dateStatus: 'valid',
    reportPartition: 'core',
    quarantineCreatedPartition: 'core',
    status: 'inbound',
    routingStatus: 'centurion',
    parseStatus: 'parsed',
    parseError: null,
    rawMime: {
      primaryKey: 'private-key',
      archiveKey: 'private-archive-key',
      primaryStatus: 'available',
      archiveStatus: 'not_attempted',
      status: 'available',
      source: 'primary',
      selectedKey: 'private-key',
      byteLength: 12,
      sha256: 'a'.repeat(64),
      contentType: 'message/rfc822',
      artifactPath: 'raw-mime/quarantine-1.eml',
    },
    messageId: '<quarantine-1@example.test>',
    inReplyTo: null,
    references: [],
    subject: 'Synthetic quarantine request',
    textBody: 'Quarantine body',
    htmlBody: '<p>Quarantine body</p>',
    headers: {},
    rawHeaders: [],
    from: ['guest@example.test'],
    to: ['centurion@example.test'],
    cc: [],
    bcc: [],
    effectiveSender: 'guest@example.test',
    attachments: [],
    evidence: {
      effectiveSender: 'guest@example.test',
      ownerHeaderValue: 'centurion@example.test',
      ownerHeaderMatches: true,
      ownerHeaderMismatch: false,
      ownerHeaderConflict: false,
      senderMatchesCenturion: false,
      recipientMatchesCenturion: true,
      bccMirror: false,
      selfLoopback: false,
      queueCorrelated: false,
      queueStatus: null,
    },
    duplicateUidl: false,
    duplicateRawHash: false,
    ...overrides,
  };
}

async function writeSnapshot(
  root: string,
  name: string,
  schemaVersion: 'centurion-nine-day-corpus-v1' | 'centurion-quarantine-v1',
  records: readonly Record<string, unknown>[],
): Promise<string> {
  const directory = path.join(root, name);
  await (await import('node:fs/promises')).mkdir(directory, { recursive: true, mode: 0o700 });
  const lines = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await writeFile(
    path.join(
      directory,
      schemaVersion === 'centurion-nine-day-corpus-v1' ? 'messages.jsonl' : 'quarantine.jsonl',
    ),
    lines,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifestFor(schemaVersion, name, records), null, 2)}\n`,
    { mode: 0o600 },
  );
  return directory;
}

function response(
  overrides: Partial<CenturionClassificationWorkerResponse> = {},
): CenturionClassificationWorkerResponse {
  return {
    opaqueId: 'opaque-worker-result',
    businessDirection: 'inbound',
    origin: 'human',
    labels: ['booking_quote'],
    primaryWorkflow: 'booking_quote',
    evidenceLocations: [{ field: 'body', start: 0, end: 8 }],
    provenance: { source: 'luna_model', direction: 'model', origin: 'model', workflow: 'model' },
    uncertainty: { level: 'low', reasons: [] },
    ...overrides,
  };
}

async function runFixture(input: {
  normal: readonly Record<string, unknown>[];
  quarantine: readonly Record<string, unknown>[];
  worker: (request: CenturionClassificationWorkerRequest) => Promise<unknown>;
  maxWorkers?: number;
  maxRetries?: number;
}): Promise<{
  root: string;
  output: string;
  result: Awaited<ReturnType<typeof classifyCenturionNineDayCorpus>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u3-'));
  const normalSnapshotDir = await writeSnapshot(
    root,
    'normal',
    'centurion-nine-day-corpus-v1',
    input.normal,
  );
  const quarantineSnapshotDir = await writeSnapshot(
    root,
    'quarantine',
    'centurion-quarantine-v1',
    input.quarantine,
  );
  const output = path.join(root, 'output');
  const result = await classifyCenturionNineDayCorpus({
    normalSnapshotDir,
    quarantineSnapshotDir,
    outputDir: output,
    snapshotId: 'fixture-u3',
    maxWorkers: input.maxWorkers,
    maxRetries: input.maxRetries,
    workerTransport: { classify: input.worker },
  });
  return { root, output, result };
}

describe('Centurion exhaustive classification and daily reports', () => {
  it('passes the complete body to workers, classifies every core record, and chooses a deterministic primary label', async () => {
    const fullBody = `${'complete-body-'.repeat(2_000)}tail`;
    const requests: CenturionClassificationWorkerRequest[] = [];
    const fixture = await runFixture({
      normal: [normalRecord({ id: 'normal-full', textBody: fullBody })],
      quarantine: [quarantineRecord({ id: 'quarantine-full' })],
      maxWorkers: 2,
      worker: async (request) => {
        requests.push(request);
        expect(request.message.textBody).toBe(
          request.message.sourceRecordId === 'normal-full' ? fullBody : 'Quarantine body',
        );
        return request.message.sourceRecordId === 'normal-full'
          ? response({
              opaqueId: 'opaque-normal',
              labels: ['guest_experience', 'booking_quote'],
              primaryWorkflow: 'guest_experience',
              evidenceLocations: [
                { field: 'body', start: fullBody.length - 4, end: fullBody.length },
              ],
            })
          : response({
              opaqueId: 'opaque-quarantine',
              labels: ['delivery_documents', 'money_proof_of_payment'],
              primaryWorkflow: 'delivery_documents',
            });
      },
    });

    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.workerId)).size).toBe(2);
    expect(fixture.result.records).toHaveLength(2);
    expect(fixture.result.records.map((record) => record.status)).toEqual([
      'classified',
      'classified',
    ]);
    expect(fixture.result.records[0]).toMatchObject({
      primaryWorkflow: 'booking_quote',
      secondaryWorkflows: ['guest_experience'],
      businessDirection: 'inbound',
      origin: 'human',
      opaqueWorkerId: 'opaque-normal',
    });
    expect(fixture.result.records[1]).toMatchObject({
      primaryWorkflow: 'money_proof_of_payment',
      secondaryWorkflows: ['delivery_documents'],
      source: 'quarantine',
    });
    expect(fixture.result.coverageAudit.core.includedUniqueIdCount).toBe(2);
    expect(fixture.result.dailyTables.coreTotals.total).toBe(2);
    expect(fixture.result.dailyTables.days['2026-09-08']?.total).toBe(1);
    expect(fixture.result.dailyTables.days['2026-09-09']?.total).toBe(1);
    expect(fixture.result.records[0]?.inputHash).toBe(
      sha(JSON.stringify(normalRecord({ id: 'normal-full', textBody: fullBody }))),
    );

    const jsonl = await readFile(path.join(fixture.output, 'daily-classification.jsonl'), 'utf8');
    expect(jsonl).not.toContain(fullBody);
    expect(jsonl).toContain('booking_quote');
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('requires an explicit reason for unknown or ambiguous model output', async () => {
    const fixture = await runFixture({
      normal: [normalRecord({ id: 'normal-uncertain' })],
      quarantine: [],
      worker: async () =>
        response({
          opaqueId: 'opaque-uncertain',
          businessDirection: 'ambiguous',
          origin: 'unknown',
          labels: ['unknown_review'],
          primaryWorkflow: 'unknown_review',
          uncertainty: { level: 'high', reasons: [] },
        }),
    });

    expect(fixture.result.records[0]).toMatchObject({
      status: 'parse_error',
      errorCode: 'uncertainty_reason_required',
      primaryWorkflow: null,
      businessDirection: null,
    });
    expect(fixture.result.coverageAudit.statusCounts.parse_error).toBe(1);
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('records retries and context-incomplete outcomes without inventing a classification', async () => {
    let attempts = 0;
    const fixture = await runFixture({
      normal: [normalRecord({ id: 'normal-retry' })],
      quarantine: [],
      maxRetries: 1,
      worker: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transport unavailable');
        return response({
          opaqueId: 'opaque-context-incomplete',
          uncertainty: {
            level: 'high',
            reasons: ['thread context was unavailable'],
            contextIncomplete: true,
          },
        });
      },
    });

    expect(attempts).toBe(2);
    expect(fixture.result.records[0]).toMatchObject({
      status: 'context_incomplete',
      attempts: 2,
      retries: 1,
      primaryWorkflow: null,
      errorCode: 'context_incomplete',
    });
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('records an exhausted worker failure and never sends excluded context rows', async () => {
    let calls = 0;
    const fixture = await runFixture({
      normal: [
        normalRecord({ id: 'normal-eligible' }),
        normalRecord({
          id: 'normal-context',
          scope: 'context_only',
          contextOnly: true,
          dailyIncluded: false,
        }),
      ],
      quarantine: [],
      maxRetries: 1,
      worker: async (request) => {
        calls += 1;
        expect(request.message.sourceRecordId).toBe('normal-eligible');
        throw new Error('worker unavailable');
      },
    });

    expect(calls).toBe(2);
    expect(fixture.result.records).toHaveLength(1);
    expect(fixture.result.records[0]).toMatchObject({
      status: 'worker_error',
      errorCode: 'worker_error',
      attempts: 2,
      retries: 1,
    });
    expect(fixture.result.coverageAudit.normal.contextOnly).toBe(1);
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('keeps September 17 spillover out of core totals while preserving quarantine dispositions', async () => {
    const requests: CenturionClassificationWorkerRequest[] = [];
    const fixture = await runFixture({
      normal: [normalRecord({ id: 'normal-core' })],
      quarantine: [
        quarantineRecord({
          id: 'quarantine-spill',
          reportPartition: 'september17_spillover',
          status: 'parse_error',
          parseStatus: 'parse_error',
        }),
        quarantineRecord({
          id: 'quarantine-missing',
          status: 'missing_object',
          parseStatus: 'missing_object',
          textBody: '',
          htmlBody: '',
        }),
      ],
      worker: async (request) => {
        requests.push(request);
        return response({ opaqueId: `opaque-${request.message.sourceRecordId}` });
      },
    });

    expect(requests).toHaveLength(1);
    expect(fixture.result.coverageAudit.core.includedUniqueIdCount).toBe(2);
    expect(fixture.result.dailyTables.coreTotals.total).toBe(2);
    expect(fixture.result.dailyTables.spillover.total).toBe(1);
    expect(fixture.result.dailyTables.quarantineDispositionCounts).toMatchObject({
      parse_error: 1,
      missing_object: 1,
    });
    expect(
      fixture.result.records.find((record) => record.sourceRecordId === 'quarantine-spill'),
    ).toMatchObject({
      partition: 'spillover',
      status: 'spillover_excluded',
    });
    expect(
      fixture.result.records.find((record) => record.sourceRecordId === 'quarantine-missing'),
    ).toMatchObject({
      status: 'context_incomplete',
      errorCode: 'missing_object',
    });
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('persists model, prompt, schema and input hashes and owner-only output files', async () => {
    const fixture = await runFixture({
      normal: [normalRecord()],
      quarantine: [],
      worker: async () => response(),
    });

    const record = fixture.result.records[0]!;
    expect(record.modelId).toBe(DEFAULT_LUNA_MODEL_ID);
    expect(record.schemaVersion).toBe(CLASSIFICATION_SCHEMA_VERSION);
    expect(record.modelVersion).toBe(DEFAULT_LUNA_MODEL_ID);
    expect(record.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.result.dailyTables.metadata).toMatchObject({
      modelId: DEFAULT_LUNA_MODEL_ID,
      promptHash: record.promptHash,
      schemaHash: record.schemaHash,
    });
    expect((await stat(fixture.output)).mode & 0o777).toBe(0o700);
    for (const file of [
      'daily-classification.jsonl',
      'daily-tables.md',
      'daily-tables.json',
      'coverage-audit.json',
    ]) {
      expect((await stat(path.join(fixture.output, file))).mode & 0o777).toBe(0o600);
    }
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('does not permit a configured worker pool larger than five', async () => {
    await expect(
      runFixture({
        normal: [normalRecord()],
        quarantine: [],
        maxWorkers: 6,
        worker: async () => response(),
      }),
    ).rejects.toThrow(/maxWorkers/);
  });
});

expect(WORKFLOW_CLASSES).toContain('unknown_review');
expect(WORKFLOW_CLASSES).toContain('other');
