import {
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  compareCenturionHumanGold,
  type HumanGoldComparatorRequest,
  type HumanGoldComparatorResponse,
} from '../scripts/compare-centurion-human-gold';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outputs = new Set<string>();

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  return sha(JSON.stringify(value));
}

function normalRecord(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    transportId: 'transport-centurion',
    threadId: 'thread-1',
    messageId: `<${id}@example.test>`,
    direction: 'inbound',
    messageDirection: 'inbound',
    businessDirection: 'inbound',
    businessDirectionSource: 'transport_identity',
    subject: 'Synthetic request',
    textBody: 'Please quote a room for two nights.',
    htmlBody: '<p>Please quote a room for two nights.</p>',
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

function attachmentEvidence(record: Record<string, unknown>, source: 'normal' | 'quarantine') {
  if (source === 'normal') {
    return Array.isArray(record.attachmentDescriptors)
      ? record.attachmentDescriptors.map((item) => {
          const attachment = item as Record<string, unknown>;
          return {
            attachmentId: typeof attachment.id === 'string' ? attachment.id : null,
            filename: typeof attachment.filename === 'string' ? attachment.filename : '',
            contentType:
              typeof attachment.contentType === 'string'
                ? attachment.contentType
                : 'application/octet-stream',
            byteSize: typeof attachment.byteSize === 'number' ? attachment.byteSize : 0,
            contentId: typeof attachment.contentId === 'string' ? attachment.contentId : null,
            availability: 'available',
            sourceRecordId: String(record.id),
          };
        })
      : [];
  }
  return Array.isArray(record.attachments)
    ? record.attachments.map((item) => {
        const attachment = item as Record<string, unknown>;
        return {
          attachmentId: null,
          filename: typeof attachment.filename === 'string' ? attachment.filename : '',
          contentType:
            typeof attachment.contentType === 'string'
              ? attachment.contentType
              : 'application/octet-stream',
          byteSize: typeof attachment.byteSize === 'number' ? attachment.byteSize : 0,
          contentId: typeof attachment.contentId === 'string' ? attachment.contentId : null,
          availability:
            typeof attachment.contentStatus === 'string' ? attachment.contentStatus : 'available',
          sourceRecordId: String(record.id),
        };
      })
    : [];
}

function targetHashes(record: Record<string, unknown>, source: 'normal' | 'quarantine') {
  const eventAt = source === 'normal' ? record.eventAt : record.messageDate;
  return {
    targetBodyHash: hashJson({
      textBody: typeof record.textBody === 'string' ? record.textBody : '',
      htmlBody: typeof record.htmlBody === 'string' ? record.htmlBody : '',
    }),
    targetHeaderHash: hashJson({
      eventAt: typeof eventAt === 'string' ? eventAt : null,
      subject: typeof record.subject === 'string' ? record.subject : '',
      from: Array.isArray(record.from) ? record.from : [],
      to: Array.isArray(record.to) ? record.to : [],
      cc: Array.isArray(record.cc) ? record.cc : [],
      bcc: Array.isArray(record.bcc) ? record.bcc : [],
      threadId: typeof record.threadId === 'string' ? record.threadId : null,
      messageId: typeof record.messageId === 'string' ? record.messageId : null,
      inReplyTo: typeof record.inReplyTo === 'string' ? record.inReplyTo : null,
      references: Array.isArray(record.references) ? record.references : [],
    }),
    targetAttachmentHash: hashJson(attachmentEvidence(record, source)),
  };
}

function normalManifest(
  snapshotId: string,
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const ordered = records.map((record) => JSON.stringify(record)).join('\n');
  return {
    schemaVersion: 'centurion-nine-day-corpus-v1',
    snapshotId,
    exporterVersion: 'fixture',
    transportId: 'transport-centurion',
    asOf: '2026-09-18T00:00:00.000Z',
    orderedMessageSha256: sha(ordered),
    counts: {
      sourceRowCount: records.length,
      includedMessageCount: records.filter((record) => record.dailyIncluded === true).length,
      contextOnlyMessageCount: records.filter((record) => record.contextOnly === true).length,
      missingEventAtCount: records.filter((record) => record.eventAt === null).length,
    },
    window: {
      startInclusive: CENTURION_WINDOW_START_UTC,
      endExclusive: CENTURION_WINDOW_END_UTC,
      timezone: 'Africa/Johannesburg',
    },
  };
}

function quarantineManifest(
  snapshotId: string,
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const ordered = records.map((record) => JSON.stringify(record)).join('\n');
  return {
    schemaVersion: 'centurion-quarantine-v1',
    snapshotId,
    exporterVersion: 'fixture',
    transportId: 'transport-centurion',
    asOf: '2026-09-18T00:00:00.000Z',
    orderedRecordSha256: sha(ordered),
    counts: {
      sourceRowCount: records.length,
      quarantineRowCount: records.length,
      centurionRowCount: records.length,
      parseFailureCount: 0,
      coreCount: records.filter((record) => record.reportPartition === 'core').length,
      september17SpilloverCount: 0,
      undatedCount: 0,
      outsideWindowCount: 0,
      parseErrorCount: 0,
      missingObjectCount: 0,
      duplicateUidGroupCount: 0,
      duplicateRawHashGroupCount: 0,
    },
    window: {
      startInclusive: CENTURION_WINDOW_START_UTC,
      endExclusive: CENTURION_WINDOW_END_UTC,
      timezone: 'Africa/Johannesburg',
      spilloverStartInclusive: CENTURION_WINDOW_END_UTC,
      spilloverEndExclusive: '2026-09-17T22:00:00.000Z',
    },
  };
}

function classification(record: Record<string, unknown>, source: 'normal' | 'quarantine') {
  const id = String(record.id);
  return {
    schemaVersion: 'centurion-classification-v1',
    recordKey: `${source}:${id}`,
    sourceRecordId: id,
    source,
    partition: 'core',
    day: '2026-09-08',
    eventAt: source === 'normal' ? record.eventAt : record.messageDate,
    messageDate: source === 'normal' ? record.eventAt : record.messageDate,
    sourceDisposition: source === 'normal' ? record.businessDirection : record.status,
    sourceDuplicateUidl: null,
    sourceDuplicateRawHash: null,
    status: 'classified',
    errorCode: null,
    opaqueWorkerId: 'worker-fixture',
    businessDirection: source === 'normal' ? record.businessDirection : record.status,
    origin: 'human',
    primaryWorkflow: 'booking_quote',
    secondaryWorkflows: [],
    evidenceLocations: [],
    provenance: { source, direction: 'fixture', origin: 'fixture', workflow: 'fixture' },
    uncertainty: { level: 'low', reasons: [] },
    modelId: 'fixture-model',
    modelVersion: 'fixture-model',
    promptVersion: 'fixture-prompt',
    promptHash: 'b'.repeat(64),
    schemaHash: 'c'.repeat(64),
    inputHash: hashJson(record),
    attempts: 1,
    retries: 0,
  };
}

function targetManifestRecord(
  record: Record<string, unknown>,
  source: 'normal' | 'quarantine',
  status: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const id = String(record.id);
  const eventAt = String(source === 'normal' ? record.eventAt : record.messageDate);
  return {
    schemaVersion: 'centurion-target-manifest-v1',
    targetKey: `${source}:${id}`,
    source,
    sourceRecordId: id,
    eventAt,
    messageId: record.messageId,
    targetStatus: status,
    status,
    candidateInboundRecordIds:
      typeof overrides.triggeringInboundRecordId === 'string'
        ? [overrides.triggeringInboundRecordId]
        : [],
    eligibleInboundRecordIds:
      typeof overrides.triggeringInboundRecordId === 'string'
        ? [overrides.triggeringInboundRecordId]
        : [],
    triggeringInboundRecordId: null,
    matchMethod: null,
    ...targetHashes(record, source),
    preTargetInputHash: null,
    preTargetBodyHashes: [],
    pendingAtCutoff: false,
    lateResponse: false,
    contextIncomplete: false,
    contextIncompleteReasons: [],
    predictionError: status === 'paired' ? null : `target_status_${status}`,
    pending_at_cutoff: false,
    late_response: false,
    context_incomplete: false,
    ...overrides,
  };
}

function predictionRecord(
  target: Record<string, unknown>,
  prediction: Record<string, unknown>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    schemaVersion: 'centurion-prediction-freeze-v1',
    targetKey: target.targetKey,
    targetStatus: target.targetStatus,
    status: target.status,
    frozenAt: '2026-09-17T12:00:00.000Z',
    modelId: 'fixture-model',
    modelVersion: 'fixture-model',
    promptVersion: 'centurion-human-response-prompt-v1',
    promptHash: 'd'.repeat(64),
    schemaHash: 'e'.repeat(64),
    inputHash: target.preTargetInputHash,
    targetBodyHash: target.targetBodyHash,
    targetHeaderHash: target.targetHeaderHash,
    targetAttachmentHash: target.targetAttachmentHash,
    preTargetBodyHashes: target.preTargetBodyHashes,
    predictorInput: null,
    predictionStatus: target.targetStatus === 'paired' ? 'frozen' : 'not_attempted',
    predictionError: target.predictionError,
    opaqueWorkerId: target.targetStatus === 'paired' ? 'worker-prediction' : null,
    attempts: target.targetStatus === 'paired' ? 1 : 0,
    retries: 0,
    operations: target.targetStatus === 'paired' ? [prediction] : [],
    primaryOperation: target.targetStatus === 'paired' ? prediction.operation : null,
    primary_operation: target.targetStatus === 'paired' ? prediction.operation : null,
    needLevel: target.targetStatus === 'paired' ? prediction.needLevel : null,
    need_level: target.targetStatus === 'paired' ? prediction.needLevel : null,
    requiredFields: target.targetStatus === 'paired' ? prediction.requiredFields : [],
    required_fields: target.targetStatus === 'paired' ? prediction.requiredFields : [],
    candidateTool: target.targetStatus === 'paired' ? prediction.candidateTool : null,
    candidate_tool: target.targetStatus === 'paired' ? prediction.candidateTool : null,
    unknownReason: null,
    unknown_reason: null,
    pendingAtCutoff: false,
    lateResponse: false,
    contextIncomplete: false,
    pending_at_cutoff: false,
    late_response: false,
    context_incomplete: false,
    ...overrides,
  };
}

function prediction(operation: string, fields: string[], tool: string | null) {
  return {
    operation,
    needLevel: 'required',
    requiredFields: fields,
    candidateTool: tool,
    unknownReason: null,
  };
}

async function writeJsonl(filePath: string, records: readonly Record<string, unknown>[]) {
  await writeFile(
    filePath,
    records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}

async function makeFixture(options: {
  normal: readonly Record<string, unknown>[];
  targetManifest: readonly Record<string, unknown>[];
  predictionFreeze: readonly Record<string, unknown>[];
  classification?: readonly Record<string, unknown>[];
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u5-'));
  const normalDir = path.join(root, 'normal');
  const quarantineDir = path.join(root, 'quarantine');
  const classificationDir = path.join(root, 'classification');
  await Promise.all([
    mkdir(normalDir, { recursive: true, mode: 0o700 }),
    mkdir(quarantineDir, { recursive: true, mode: 0o700 }),
    mkdir(classificationDir, { recursive: true, mode: 0o700 }),
  ]);
  const quarantine: Record<string, unknown>[] = [];
  const normalId = 'normal-snapshot-fixture';
  const quarantineId = 'quarantine-snapshot-fixture';
  const normalManifestValue = normalManifest(normalId, options.normal);
  const quarantineManifestValue = quarantineManifest(quarantineId, quarantine);
  await writeJsonl(path.join(normalDir, 'messages.jsonl'), options.normal);
  await writeJsonl(path.join(quarantineDir, 'quarantine.jsonl'), quarantine);
  await writeFile(
    path.join(normalDir, 'manifest.json'),
    `${JSON.stringify(normalManifestValue)}\n`,
    {
      mode: 0o600,
    },
  );
  await writeFile(
    path.join(quarantineDir, 'manifest.json'),
    `${JSON.stringify(quarantineManifestValue)}\n`,
    { mode: 0o600 },
  );
  const classes =
    options.classification ?? options.normal.map((record) => classification(record, 'normal'));
  await writeJsonl(path.join(classificationDir, 'daily-classification.jsonl'), classes);
  const normalManifestRaw = JSON.stringify(normalManifestValue) + '\n';
  const quarantineManifestRaw = JSON.stringify(quarantineManifestValue) + '\n';
  await writeFile(
    path.join(classificationDir, 'coverage-audit.json'),
    `${JSON.stringify({
      schemaVersion: 'centurion-coverage-audit-v1',
      snapshotId: 'classification-snapshot-fixture',
      sourceManifests: {
        normal: {
          schemaVersion: normalManifestValue.schemaVersion,
          snapshotId: normalId,
          orderedHash: normalManifestValue.orderedMessageSha256,
          manifestHash: sha(normalManifestRaw),
          counts: normalManifestValue.counts,
        },
        quarantine: {
          schemaVersion: quarantineManifestValue.schemaVersion,
          snapshotId: quarantineId,
          orderedHash: quarantineManifestValue.orderedRecordSha256,
          manifestHash: sha(quarantineManifestRaw),
          counts: quarantineManifestValue.counts,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const u4Dir = path.join(root, 'u4');
  await mkdir(u4Dir, { recursive: true, mode: 0o700 });
  await writeJsonl(path.join(u4Dir, 'target-manifest.jsonl'), options.targetManifest);
  await writeJsonl(path.join(u4Dir, 'prediction-freeze.jsonl'), options.predictionFreeze);
  const snapshotId = path.basename(root);
  const output = path.join(REPO_ROOT, '.private', 'centurion-corpus', snapshotId);
  outputs.add(output);
  return {
    root,
    normalDir,
    quarantineDir,
    classificationDir,
    u4Dir,
    output,
    snapshotId,
  };
}

async function clean(fixtureRoot: string, snapshotId: string) {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(path.join(REPO_ROOT, '.private', 'centurion-corpus', snapshotId), {
    recursive: true,
    force: true,
  });
  outputs.delete(path.join(REPO_ROOT, '.private', 'centurion-corpus', snapshotId));
}

afterEach(async () => {
  await Promise.all([...outputs].map((output) => rm(output, { recursive: true, force: true })));
  outputs.clear();
});

describe('Centurion semantic human-gold comparison', () => {
  it('separates human claims from unobserved PMS actions and grades semantic fields', async () => {
    const inbound = normalRecord('inbound-1');
    const targetRecord = normalRecord('outbound-1', {
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      confirmedOutbound: true,
      queueState: 'sent',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      textBody: 'Booked and charged the guest.',
      htmlBody: '<p>Booked and charged the guest.</p>',
      inReplyTo: '<inbound-1@example.test>',
    });
    const target = targetManifestRecord(targetRecord, 'normal', 'paired', {
      triggeringInboundRecordId: 'normal:inbound-1',
      eligibleInboundRecordIds: ['normal:inbound-1'],
      candidateInboundRecordIds: ['normal:inbound-1'],
      matchMethod: 'in_reply_to',
      preTargetInputHash: 'f'.repeat(64),
      preTargetBodyHashes: ['1'.repeat(64)],
    });
    const predictionRead = prediction('read', ['reservationRef'], 'hms_find_reservation');
    const frozen = predictionRecord(target, predictionRead);
    frozen.operations = [
      predictionRead,
      prediction('post_payment', ['amount', 'currency'], 'hms_post_payment'),
    ];
    const fixture = await makeFixture({
      normal: [inbound, targetRecord],
      targetManifest: [target],
      predictionFreeze: [frozen],
    });
    const requests: HumanGoldComparatorRequest[] = [];
    const response: HumanGoldComparatorResponse = {
      opaqueId: 'gold-opaque-1',
      operations: [
        {
          operation: 'post_payment',
          needLevel: 'required',
          requiredFields: ['amount', 'currency'],
          candidateTool: 'hms_post_payment',
          unknownReason: null,
        },
      ],
      primaryOperation: 'post_payment',
      needLevel: 'required',
      requiredFields: ['amount', 'currency'],
      candidateTool: 'hms_post_payment',
      unknownReason: null,
    };
    const result = await compareCenturionHumanGold({
      normalSnapshotDir: fixture.normalDir,
      quarantineSnapshotDir: fixture.quarantineDir,
      classificationOutputDir: fixture.classificationDir,
      humanAnalysisDir: fixture.u4Dir,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      goldTransport: {
        compare: async (request) => {
          requests.push(request);
          return response;
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.target.textBody).toContain('Booked');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      taskId: expect.stringMatching(/^task-/),
      targetStatus: 'paired',
      grade: 'partial',
      claimed_action: expect.objectContaining({ status: 'observed' }),
      verified_pms_action: expect.objectContaining({ status: 'not_observed' }),
    });
    expect(result.records[0]?.mismatchReasons).toEqual(
      expect.arrayContaining(['missing_operation']),
    );
    expect(result.audit.stratumCounts.answered).toBe(1);
    expect(result.audit.stratumCounts.prediction_error).toBe(0);
    await expect(
      readFile(path.join(fixture.output, 'stagehand-handoff.md'), 'utf8'),
    ).resolves.not.toContain('Booked and charged');
    await clean(fixture.root, fixture.snapshotId);
  });

  it('keeps duplicate replies distinct while ranking one distinct task, and retains unanswered/late/error strata', async () => {
    const inbound = normalRecord('inbound-duplicate');
    const firstTarget = normalRecord('outbound-first', {
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-duplicate@example.test>',
    });
    const secondTarget = normalRecord('outbound-second', {
      ...firstTarget,
      id: 'outbound-second',
      messageId: '<outbound-second@example.test>',
      eventAt: '2026-09-08T10:00:00.000Z',
      sentAt: '2026-09-08T10:00:00.000Z',
    });
    const first = targetManifestRecord(firstTarget, 'normal', 'paired', {
      triggeringInboundRecordId: 'normal:inbound-duplicate',
      candidateInboundRecordIds: ['normal:inbound-duplicate'],
      eligibleInboundRecordIds: ['normal:inbound-duplicate'],
      matchMethod: 'in_reply_to',
      preTargetInputHash: '1'.repeat(64),
    });
    const second = targetManifestRecord(secondTarget, 'normal', 'paired', {
      triggeringInboundRecordId: 'normal:inbound-duplicate',
      candidateInboundRecordIds: ['normal:inbound-duplicate'],
      eligibleInboundRecordIds: ['normal:inbound-duplicate'],
      matchMethod: 'in_reply_to',
      preTargetInputHash: '2'.repeat(64),
      lateResponse: true,
      late_response: true,
    });
    const unanswered = normalRecord('inbound-unanswered', {
      eventAt: '2026-09-08T11:00:00.000Z',
      receivedAt: '2026-09-08T11:00:00.000Z',
      threadId: 'thread-unanswered',
    });
    const fixture = await makeFixture({
      normal: [inbound, firstTarget, secondTarget, unanswered],
      targetManifest: [first, second],
      predictionFreeze: [
        predictionRecord(first, prediction('read', ['reservationRef'], 'hms_find_reservation')),
        predictionRecord(second, prediction('read', ['reservationRef'], 'hms_find_reservation'), {
          predictionError: 'luna_worker_transport_unavailable',
          predictionStatus: 'prediction_error',
          operations: [],
          primaryOperation: null,
          primary_operation: null,
          needLevel: null,
          need_level: null,
          requiredFields: [],
          required_fields: [],
          candidateTool: null,
          candidate_tool: null,
        }),
      ],
    });
    const result = await compareCenturionHumanGold({
      normalSnapshotDir: fixture.normalDir,
      quarantineSnapshotDir: fixture.quarantineDir,
      classificationOutputDir: fixture.classificationDir,
      humanAnalysisDir: fixture.u4Dir,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      cutoffAt: '2026-09-08T12:00:00.000Z',
      goldTransport: {
        compare: async () => ({
          opaqueId: 'gold-read',
          operations: [prediction('read', ['reservationRef'], 'hms_find_reservation')],
          primaryOperation: 'read',
          needLevel: 'required',
          requiredFields: ['reservationRef'],
          candidateTool: 'hms_find_reservation',
          unknownReason: null,
        }),
      },
    });
    expect(
      result.records.filter((record) => record.targetKey === 'normal:outbound-first'),
    ).toHaveLength(1);
    expect(
      result.records.filter((record) => record.targetKey === 'normal:outbound-second'),
    ).toHaveLength(1);
    expect(result.records.some((record) => record.strata.includes('unanswered'))).toBe(true);
    expect(result.records.some((record) => record.strata.includes('late'))).toBe(true);
    expect(result.records.some((record) => record.strata.includes('prediction_error'))).toBe(true);
    const demand = result.report.rankings.find(
      (row) => row.operation === 'read' && row.candidateTool === 'hms_find_reservation',
    );
    expect(demand?.distinctTaskCount).toBe(1);
    expect(demand?.evidenceIds.length).toBeGreaterThan(0);
    await clean(fixture.root, fixture.snapshotId);
  });

  it('rejects a sealed source or freeze hash mismatch before exposing gold payload', async () => {
    const inbound = normalRecord('inbound-tamper');
    const targetRecord = normalRecord('outbound-tamper', {
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-tamper@example.test>',
    });
    const target = targetManifestRecord(targetRecord, 'normal', 'paired', {
      triggeringInboundRecordId: 'normal:inbound-tamper',
      candidateInboundRecordIds: ['normal:inbound-tamper'],
      eligibleInboundRecordIds: ['normal:inbound-tamper'],
      matchMethod: 'in_reply_to',
      preTargetInputHash: '1'.repeat(64),
    });
    const frozen = predictionRecord(
      target,
      prediction('read', ['reservationRef'], 'hms_find_reservation'),
      {
        targetBodyHash: '0'.repeat(64),
      },
    );
    const fixture = await makeFixture({
      normal: [inbound, targetRecord],
      targetManifest: [target],
      predictionFreeze: [frozen],
    });
    let calls = 0;
    await expect(
      compareCenturionHumanGold({
        normalSnapshotDir: fixture.normalDir,
        quarantineSnapshotDir: fixture.quarantineDir,
        classificationOutputDir: fixture.classificationDir,
        humanAnalysisDir: fixture.u4Dir,
        outputDir: fixture.output,
        snapshotId: fixture.snapshotId,
        goldTransport: {
          compare: async () => {
            calls += 1;
            return {};
          },
        },
      }),
    ).rejects.toThrow('prediction_target_body_hash_mismatch');
    expect(calls).toBe(0);
    await clean(fixture.root, fixture.snapshotId);
  });

  it('writes create-only owner-private outputs and an opaque Stagehand handoff', async () => {
    const inbound = normalRecord('inbound-handoff');
    const targetRecord = normalRecord('outbound-handoff', {
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-handoff@example.test>',
      textBody: 'Reply body PII guest@example.test',
      htmlBody: '<p>Reply body PII guest@example.test</p>',
    });
    const target = targetManifestRecord(targetRecord, 'normal', 'paired', {
      triggeringInboundRecordId: 'normal:inbound-handoff',
      candidateInboundRecordIds: ['normal:inbound-handoff'],
      eligibleInboundRecordIds: ['normal:inbound-handoff'],
      matchMethod: 'in_reply_to',
      preTargetInputHash: '1'.repeat(64),
    });
    const fixture = await makeFixture({
      normal: [inbound, targetRecord],
      targetManifest: [target],
      predictionFreeze: [
        predictionRecord(target, prediction('read', ['reservationRef'], 'hms_find_reservation')),
      ],
    });
    await compareCenturionHumanGold({
      normalSnapshotDir: fixture.normalDir,
      quarantineSnapshotDir: fixture.quarantineDir,
      classificationOutputDir: fixture.classificationDir,
      humanAnalysisDir: fixture.u4Dir,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      goldTransport: {
        compare: async () => ({
          opaqueId: 'gold-handoff',
          operations: [prediction('read', ['reservationRef'], 'hms_find_reservation')],
          primaryOperation: 'read',
          needLevel: 'required',
          requiredFields: ['reservationRef'],
          candidateTool: 'hms_find_reservation',
          unknownReason: null,
        }),
      },
    });
    const handoff = await readFile(path.join(fixture.output, 'stagehand-handoff.md'), 'utf8');
    expect(handoff).toContain('Candidate tool boundaries');
    expect(handoff).not.toContain('guest@example.test');
    expect(handoff).not.toContain('Reply body PII');
    expect((await stat(fixture.output)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(fixture.output, 'gold-comparison.jsonl'))).mode & 0o777).toBe(
      0o600,
    );
    await expect(
      compareCenturionHumanGold({
        normalSnapshotDir: fixture.normalDir,
        quarantineSnapshotDir: fixture.quarantineDir,
        classificationOutputDir: fixture.classificationDir,
        humanAnalysisDir: fixture.u4Dir,
        outputDir: fixture.output,
        snapshotId: fixture.snapshotId,
        goldTransport: { compare: async () => ({}) },
      }),
    ).rejects.toThrow(/output|exists|immutable/);
    await clean(fixture.root, fixture.snapshotId);
  });
});
