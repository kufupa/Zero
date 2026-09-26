import {
  CLASSIFICATION_SCHEMA_VERSION,
  DEFAULT_LUNA_MODEL_ID,
  WORKFLOW_CLASSES,
  classifyCenturionNineDayCorpus,
  reconcileCoverage,
  runCenturionClassificationCli,
  type CenturionClassificationWorkerRequest,
  type CenturionClassificationWorkerResponse,
} from '../scripts/classify-centurion-nine-day-corpus';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  const isNormal = schemaVersion === 'centurion-nine-day-corpus-v1';
  const normalRecords = isNormal ? records : [];
  const quarantineRecords = isNormal ? [] : records;
  return {
    schemaVersion,
    snapshotId,
    exporterVersion: 'fixture',
    transportId: 'transport-centurion',
    asOf: '2026-09-18T00:00:00.000Z',
    orderedMessageSha256: isNormal ? sha(ordered) : undefined,
    orderedRecordSha256: !isNormal ? sha(ordered) : undefined,
    counts: isNormal
      ? {
          sourceRowCount: records.length,
          includedMessageCount: normalRecords.filter((record) => record.dailyIncluded === true)
            .length,
          contextOnlyMessageCount: normalRecords.filter((record) => record.contextOnly === true)
            .length,
          missingEventAtCount: normalRecords.filter((record) => record.eventAt === null).length,
        }
      : {
          sourceRowCount: records.length,
          quarantineRowCount: records.length,
          centurionRowCount: records.length,
          parseFailureCount: quarantineRecords.filter((record) => record.reason === 'parse_failure')
            .length,
          coreCount: quarantineRecords.filter((record) => record.reportPartition === 'core').length,
          september17SpilloverCount: quarantineRecords.filter(
            (record) => record.reportPartition === 'september17_spillover',
          ).length,
          undatedCount: quarantineRecords.filter((record) => record.reportPartition === 'undated')
            .length,
          outsideWindowCount: quarantineRecords.filter(
            (record) => record.reportPartition === 'outside_window',
          ).length,
          parseErrorCount: quarantineRecords.filter(
            (record) => record.parseStatus === 'parse_error',
          ).length,
          missingObjectCount: quarantineRecords.filter(
            (record) => record.parseStatus === 'missing_object',
          ).length,
          duplicateUidGroupCount: 0,
          duplicateRawHashGroupCount: 0,
        },
    window: {
      startInclusive: WINDOW_START,
      endExclusive: WINDOW_END,
      ...(isNormal
        ? {}
        : {
            spilloverStartInclusive: WINDOW_END,
            spilloverEndExclusive: '2026-09-17T22:00:00.000Z',
          }),
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
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
  const output = path.join(root, '.private', 'centurion-corpus', 'fixture-u3');
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
              primaryWorkflow: 'booking_quote',
              evidenceLocations: [
                { field: 'body', start: fullBody.length - 4, end: fullBody.length },
              ],
            })
          : response({
              opaqueId: 'opaque-quarantine',
              labels: ['delivery_documents', 'money_proof_of_payment'],
              primaryWorkflow: 'money_proof_of_payment',
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

  it.each([
    {
      name: 'unknown workflow label',
      response: response({ labels: ['not_a_workflow' as never] }),
      errorCode: 'workflow_label_unknown',
    },
    {
      name: 'invalid primary workflow',
      response: response({ primaryWorkflow: 'not_a_workflow' as never }),
      errorCode: 'primary_workflow_invalid',
    },
    {
      name: 'inconsistent deterministic primary',
      response: response({ labels: ['booking_quote'], primaryWorkflow: 'guest_experience' }),
      errorCode: 'primary_workflow_inconsistent',
    },
    {
      name: 'malformed uncertainty reasons',
      response: response({ uncertainty: { level: 'low', reasons: ['ok', null as never] } }),
      errorCode: 'uncertainty_reasons_invalid',
    },
  ])(
    'rejects $name instead of filtering invalid worker output',
    async ({ response: workerResponse, errorCode }) => {
      const fixture = await runFixture({
        normal: [normalRecord({ id: `normal-${errorCode}` })],
        quarantine: [],
        worker: async () => workerResponse,
      });
      expect(fixture.result.records[0]).toMatchObject({ status: 'parse_error', errorCode });
      await rm(fixture.root, { recursive: true, force: true });
    },
  );

  it('rejects unknown-review and other labels without an explicit uncertainty reason', async () => {
    const fixture = await runFixture({
      normal: [normalRecord({ id: 'normal-unknown-no-reason' })],
      quarantine: [],
      worker: async () =>
        response({
          labels: ['unknown_review'],
          primaryWorkflow: 'unknown_review',
          uncertainty: { level: 'high', reasons: [] },
        }),
    });
    expect(fixture.result.records[0]).toMatchObject({
      status: 'parse_error',
      errorCode: 'uncertainty_reason_required',
    });
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('requires a reason when unknown-review is only a secondary label', async () => {
    const fixture = await runFixture({
      normal: [normalRecord({ id: 'normal-secondary-unknown-no-reason' })],
      quarantine: [],
      worker: async () =>
        response({
          labels: ['booking_quote', 'unknown_review'],
          primaryWorkflow: 'booking_quote',
          secondaryLabels: ['unknown_review'],
          uncertainty: { level: 'high', reasons: [] },
        }),
    });
    expect(fixture.result.records[0]).toMatchObject({
      status: 'parse_error',
      errorCode: 'uncertainty_reason_required',
    });
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('rejects a tampered fixed manifest window before worker invocation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u3-manifest-'));
    const normalSnapshotDir = await writeSnapshot(root, 'normal', 'centurion-nine-day-corpus-v1', [
      normalRecord(),
    ]);
    const quarantineSnapshotDir = await writeSnapshot(
      root,
      'quarantine',
      'centurion-quarantine-v1',
      [],
    );
    const manifestPath = path.join(normalSnapshotDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.window = { startInclusive: WINDOW_START, endExclusive: WINDOW_END, timezone: 'UTC' };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(
      classifyCenturionNineDayCorpus({
        normalSnapshotDir,
        quarantineSnapshotDir,
        outputDir: path.join(root, '.private', 'centurion-corpus', 'fixture-u3'),
        snapshotId: 'fixture-u3',
        workerTransport: { classify: async () => response() },
      }),
    ).rejects.toThrow(/normal_manifest_window_mismatch/);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a normal record with the wrong transport or malformed body shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u3-schema-'));
    const normalSnapshotDir = await writeSnapshot(root, 'normal', 'centurion-nine-day-corpus-v1', [
      normalRecord({ transportId: 'transport-other' }),
    ]);
    const quarantineSnapshotDir = await writeSnapshot(
      root,
      'quarantine',
      'centurion-quarantine-v1',
      [],
    );
    await expect(
      classifyCenturionNineDayCorpus({
        normalSnapshotDir,
        quarantineSnapshotDir,
        outputDir: path.join(root, '.private', 'centurion-corpus', 'fixture-u3'),
        snapshotId: 'fixture-u3',
        workerTransport: { classify: async () => response() },
      }),
    ).rejects.toThrow(/normal_record_transport_mismatch/);
    await rm(root, { recursive: true, force: true });
  });

  it('reconciles the independently validated source candidate IDs against emitted IDs', () => {
    expect(
      reconcileCoverage({
        sourceCandidateIds: ['normal:a', 'quarantine:b'],
        classificationRecordIds: ['normal:a'],
        dailyTotal: 1,
      }),
    ).toMatchObject({
      sourceCandidateCount: 2,
      missingClassificationIdCount: 1,
      unexpectedClassificationIdCount: 0,
      dailyReconciles: false,
    });
  });

  it('surfaces the unavailable CLI worker as a blocker, not a successful classification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u3-cli-'));
    const normalSnapshotDir = await writeSnapshot(root, 'normal', 'centurion-nine-day-corpus-v1', [
      normalRecord(),
    ]);
    const quarantineSnapshotDir = await writeSnapshot(
      root,
      'quarantine',
      'centurion-quarantine-v1',
      [],
    );
    const outputDir = path.join(root, '.private', 'centurion-corpus', 'fixture-cli');
    const stdout: string[] = [];
    const exitCode = await runCenturionClassificationCli(
      [
        '--normal',
        normalSnapshotDir,
        '--quarantine',
        quarantineSnapshotDir,
        '--out',
        outputDir,
        '--snapshot',
        'fixture-cli',
      ],
      { repoRoot: root, writeStdout: (value) => stdout.push(value) },
    );
    expect(exitCode).toBe(2);
    expect(stdout.join('')).toContain('centurion_classification.blocked');
    expect(stdout.join('')).toContain('luna_worker_transport_unavailable');
    expect(await readFile(path.join(outputDir, 'daily-tables.md'), 'utf8')).toContain(
      'luna_worker_transport_unavailable',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a symlinked private root before publishing output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u3-symlink-'));
    const target = await mkdtemp(path.join(os.tmpdir(), 'centurion-u3-target-'));
    const normalSnapshotDir = await writeSnapshot(root, 'normal', 'centurion-nine-day-corpus-v1', [
      normalRecord(),
    ]);
    const quarantineSnapshotDir = await writeSnapshot(
      root,
      'quarantine',
      'centurion-quarantine-v1',
      [],
    );
    await symlink(target, path.join(root, '.private'));
    await expect(
      classifyCenturionNineDayCorpus({
        normalSnapshotDir,
        quarantineSnapshotDir,
        outputDir: path.join(root, '.private', 'centurion-corpus', 'fixture-u3'),
        snapshotId: 'fixture-u3',
        workerTransport: { classify: async () => response() },
      }),
    ).rejects.toThrow(/private_root_symlink/);
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
});

expect(WORKFLOW_CLASSES).toContain('unknown_review');
expect(WORKFLOW_CLASSES).toContain('other');
