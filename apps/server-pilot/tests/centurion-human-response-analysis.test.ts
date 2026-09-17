import {
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  HUMAN_RESPONSE_SCHEMA_HASH,
  HUMAN_RESPONSE_OPERATIONS,
  TARGET_STATUSES,
  analyseCenturionHumanResponses,
  choosePrimaryOperation,
  type HumanResponseWorkerRequest,
  type HumanResponseWorkerResponse,
} from '../scripts/analyse-centurion-human-responses';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const WINDOW_START = CENTURION_WINDOW_START_UTC;
const WINDOW_END = CENTURION_WINDOW_END_UTC;
const fixtureOutputs = new Set<string>();

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'inbound-1',
    transportId: 'transport-centurion',
    threadId: 'thread-1',
    messageId: '<inbound-1@example.test>',
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

function quarantineRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    recordType: 'quarantine',
    schemaVersion: 'centurion-quarantine-v1',
    id: 'quarantine-1',
    ingestMailboxId: 'ingest-nava-legacy',
    pop3Uidl: 'uidl-1',
    reason: 'parse_failure',
    quarantineCreatedAt: '2026-09-09T08:00:00.000Z',
    messageDate: '2026-09-09T08:00:00.000Z',
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
    from: ['guest@example.test'],
    to: ['centurion@example.test'],
    cc: [],
    bcc: [],
    attachments: [],
    ...overrides,
  };
}

function snapshotManifest(
  schemaVersion: 'centurion-nine-day-corpus-v1' | 'centurion-quarantine-v1',
  snapshotId: string,
  records: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const ordered = records.map((record) => JSON.stringify(record)).join('\n');
  const normal = schemaVersion === 'centurion-nine-day-corpus-v1';
  return {
    schemaVersion,
    snapshotId,
    exporterVersion: 'fixture',
    transportId: 'transport-centurion',
    asOf: '2026-09-18T00:00:00.000Z',
    orderedMessageSha256: normal ? sha(ordered) : undefined,
    orderedRecordSha256: normal ? undefined : sha(ordered),
    counts: normal
      ? {
          sourceRowCount: records.length,
          includedMessageCount: records.filter((record) => record.dailyIncluded === true).length,
          contextOnlyMessageCount: records.filter((record) => record.contextOnly === true).length,
          missingEventAtCount: records.filter((record) => record.eventAt === null).length,
        }
      : {
          sourceRowCount: records.length,
          quarantineRowCount: records.length,
          centurionRowCount: records.length,
          parseFailureCount: records.filter((record) => record.reason === 'parse_failure').length,
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
      startInclusive: WINDOW_START,
      endExclusive: WINDOW_END,
      timezone: 'Africa/Johannesburg',
      ...(normal
        ? {}
        : {
            spilloverStartInclusive: WINDOW_END,
            spilloverEndExclusive: '2026-09-17T22:00:00.000Z',
          }),
    },
  };
}

function classificationFor(
  record: Record<string, unknown>,
  source: 'normal' | 'quarantine' = 'normal',
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const sourceRecordId = String(record.id);
  return {
    schemaVersion: 'centurion-classification-v1',
    recordKey: `${source}:${sourceRecordId}`,
    sourceRecordId,
    source,
    status: 'classified',
    inputHash: sha(JSON.stringify(record)),
    eventAt: source === 'normal' ? record.eventAt : record.messageDate,
    businessDirection: source === 'normal' ? record.businessDirection : record.status,
    origin: 'human',
    primaryWorkflow: 'booking_quote',
    secondaryWorkflows: [],
    ...overrides,
  };
}

async function writeFixture(input: {
  normal: readonly Record<string, unknown>[];
  quarantine?: readonly Record<string, unknown>[];
  classification?: readonly Record<string, unknown>[];
}): Promise<{
  root: string;
  normal: string;
  quarantine: string;
  classification: string;
  output: string;
  snapshotId: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'centurion-u4-'));
  const normal = path.join(root, 'normal');
  const quarantine = path.join(root, 'quarantine');
  // The production contract permits only the actual checkout's ignored root.
  const snapshotId = path.basename(root);
  const output = path.resolve(process.cwd(), '.private', 'centurion-corpus', snapshotId);
  fixtureOutputs.add(output);
  await mkdir(normal, { recursive: true, mode: 0o700 });
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  const quarantineRecords = input.quarantine ?? [];
  const normalLines = `${input.normal.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const quarantineLines = quarantineRecords.length
    ? `${quarantineRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
    : '';
  await writeFile(path.join(normal, 'messages.jsonl'), normalLines, { mode: 0o600 });
  await writeFile(path.join(quarantine, 'quarantine.jsonl'), quarantineLines, { mode: 0o600 });
  await writeFile(
    path.join(normal, 'manifest.json'),
    `${JSON.stringify(snapshotManifest('centurion-nine-day-corpus-v1', 'fixture-u4', input.normal), null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(quarantine, 'manifest.json'),
    `${JSON.stringify(snapshotManifest('centurion-quarantine-v1', 'fixture-u4', quarantineRecords), null, 2)}\n`,
    { mode: 0o600 },
  );
  const classificationRecords = input.classification ?? [
    ...input.normal.map((record) => classificationFor(record)),
    ...quarantineRecords.map((record) => classificationFor(record, 'quarantine')),
  ];
  const classification = path.join(root, 'daily-classification.jsonl');
  await writeFile(
    classification,
    classificationRecords.length
      ? `${classificationRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
      : '',
    { mode: 0o600 },
  );
  return { root, normal, quarantine, classification, output, snapshotId };
}

function prediction(
  overrides: Partial<HumanResponseWorkerResponse> = {},
): HumanResponseWorkerResponse {
  return {
    opaqueId: 'opaque-prediction',
    operations: [
      {
        operation: 'read',
        needLevel: 'required',
        requiredFields: ['reservationRef'],
        candidateTool: 'hms_find_reservation',
        unknownReason: null,
      },
    ],
    primaryOperation: 'read',
    needLevel: 'required',
    requiredFields: ['reservationRef'],
    candidateTool: 'hms_find_reservation',
    unknownReason: null,
    ...overrides,
  };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  const output = path.resolve(process.cwd(), '.private', 'centurion-corpus', path.basename(root));
  await rm(output, {
    recursive: true,
    force: true,
  });
  fixtureOutputs.delete(output);
}

afterEach(async () => {
  await Promise.all(
    [...fixtureOutputs].map((output) => rm(output, { recursive: true, force: true })),
  );
  fixtureOutputs.clear();
});

describe('Centurion blinded human-response analysis', () => {
  it('exports the fixed operation/status vocabularies and chooses a deterministic primary operation', () => {
    expect(HUMAN_RESPONSE_OPERATIONS).toContain('post_payment');
    expect(TARGET_STATUSES).toEqual([
      'paired',
      'ambiguous',
      'no_eligible_inbound',
      'outbound_only',
    ]);
    expect(choosePrimaryOperation(['refund', 'read', 'cancel'])).toBe('read');
  });

  it('matches RFC headers and sends only an earlier, quote-free input to the worker', async () => {
    const futureBody = 'Future human response body must never leak.';
    const inbound = normalRecord({
      id: 'inbound-rfc',
      messageId: '<inbound-rfc@example.test>',
      textBody: `Current request.\n> ${futureBody}`,
      htmlBody: `<p>Current request.</p><blockquote>${futureBody}</blockquote>`,
    });
    const target = normalRecord({
      id: 'outbound-rfc',
      messageId: '<outbound-rfc@example.test>',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      confirmedOutbound: true,
      queueState: 'sent',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      textBody: futureBody,
      htmlBody: `<p>${futureBody}</p>`,
      inReplyTo: '<inbound-rfc@example.test>',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    const requests: HumanResponseWorkerRequest[] = [];
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async (request) => {
          requests.push(request);
          return prediction();
        },
      },
    });
    expect(result.targets[0]).toMatchObject({
      targetStatus: 'paired',
      triggeringInboundRecordId: 'normal:inbound-rfc',
      matchMethod: 'in_reply_to',
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain('outbound-rfc');
    expect(JSON.stringify(requests[0])).not.toContain('2026-09-08T09:00:00.000Z');
    const serializedInput = JSON.stringify(requests[0]?.input);
    expect(serializedInput).not.toContain(futureBody);
    expect(serializedInput).not.toContain('outbound-rfc');
    expect(serializedInput).not.toContain('2026-09-08T09:00:00.000Z');
    expect(requests[0]?.input.triggeringInbound.textBody).toContain('Current request');
    expect(requests[0]?.input.triggeringInbound.eventAt).toBe('2026-09-08T08:00:00.000Z');
    expect(result.predictions[0]?.predictionStatus).toBe('frozen');
    expect(result.predictions[0]?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(path.join(fixture.output, 'target-manifest.jsonl'), 'utf8'),
    ).not.toContain(futureBody);
    await cleanup(fixture.root);
  });

  it('marks ambiguous multiple inbound candidates instead of silently choosing the first', async () => {
    const first = normalRecord({ id: 'inbound-a', messageId: '<inbound-a@example.test>' });
    const second = normalRecord({
      id: 'inbound-b',
      messageId: '<inbound-b@example.test>',
      eventAt: '2026-09-08T08:30:00.000Z',
      receivedAt: '2026-09-08T08:30:00.000Z',
    });
    const target = normalRecord({
      id: 'outbound-ambiguous',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      textBody: 'Ambiguous human response.',
      htmlBody: '<p>Ambiguous human response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const fixture = await writeFixture({ normal: [first, second, target] });
    let calls = 0;
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async () => {
          calls += 1;
          return prediction();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.targets[0]).toMatchObject({
      targetStatus: 'ambiguous',
      triggeringInboundRecordId: null,
      predictionError: 'target_status_ambiguous',
    });
    await cleanup(fixture.root);
  });

  it('distinguishes an outbound-only target from a target with no eligible causal inbound', async () => {
    const unrelatedInbound = normalRecord({
      id: 'unrelated-inbound',
      threadId: 'missing-thread',
      messageId: '<unrelated-inbound@example.test>',
      eventAt: '2026-07-01T08:00:00.000Z',
      receivedAt: '2026-07-01T08:00:00.000Z',
    });
    const noEligible = normalRecord({
      id: 'outbound-no-eligible',
      threadId: 'missing-thread',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      textBody: 'No eligible inbound response.',
      htmlBody: '<p>No eligible inbound response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const outboundOnly = normalRecord({
      id: 'outbound-only',
      threadId: 'outbound-only-thread',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T10:00:00.000Z',
      sentAt: '2026-09-08T10:00:00.000Z',
      receivedAt: null,
      textBody: 'Outbound-only response.',
      htmlBody: '<p>Outbound-only response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const fixture = await writeFixture({ normal: [unrelatedInbound, noEligible, outboundOnly] });
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: { predict: async () => prediction() },
    });
    expect(result.targets.map((target) => target.targetStatus)).toEqual([
      'no_eligible_inbound',
      'outbound_only',
    ]);
    await cleanup(fixture.root);
  });

  it('keeps a pre-window trigger, excludes a target at the half-open cutoff, and records unanswered inbound coverage', async () => {
    const trigger = normalRecord({
      id: 'pre-window-trigger',
      threadId: 'thread-pre',
      messageId: '<pre-window-trigger@example.test>',
      eventAt: '2026-09-01T08:00:00.000Z',
      receivedAt: '2026-09-01T08:00:00.000Z',
      scope: 'context_only',
      contextOnly: true,
      dailyIncluded: false,
    });
    const target = normalRecord({
      id: 'outbound-pre-window-trigger',
      threadId: 'thread-pre',
      messageId: '<outbound-pre-window-trigger@example.test>',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      textBody: 'Pre-window trigger response.',
      htmlBody: '<p>Pre-window trigger response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const unanswered = normalRecord({ id: 'unanswered-inbound', threadId: 'thread-unanswered' });
    const cutoffTarget = normalRecord({
      id: 'outbound-at-cutoff',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: WINDOW_END,
      sentAt: WINDOW_END,
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const records = [trigger, target, unanswered, cutoffTarget];
    const fixture = await writeFixture({ normal: records });
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: { predict: async () => prediction() },
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      targetStatus: 'paired',
      triggeringInboundRecordId: 'normal:pre-window-trigger',
    });
    expect(result.audit.unansweredInboundRecordIds).toContain('normal:unanswered-inbound');
    expect(result.audit.excludedAtCutoffOutboundCount).toBe(1);
    await cleanup(fixture.root);
  });

  it('retains unavailable attachment evidence and marks the prediction context incomplete', async () => {
    const trigger = quarantineRecord({
      id: 'quarantine-attachment-trigger',
      messageId: '<quarantine-attachment-trigger@example.test>',
      textBody: 'Please send the signed confirmation.',
      htmlBody: '<p>Please send the signed confirmation.</p>',
      attachments: [
        {
          filename: 'confirmation.pdf',
          contentType: 'application/pdf',
          byteSize: 1234,
          contentId: null,
          contentStatus: 'unavailable',
        },
      ],
    });
    const target = normalRecord({
      id: 'outbound-attachment-context',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-09T10:00:00.000Z',
      sentAt: '2026-09-09T10:00:00.000Z',
      receivedAt: null,
      textBody: 'Attachment-context human response.',
      htmlBody: '<p>Attachment-context human response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<quarantine-attachment-trigger@example.test>',
    });
    const fixture = await writeFixture({ normal: [target], quarantine: [trigger] });
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: { predict: async () => prediction() },
    });
    expect(result.targets[0]?.targetStatus).toBe('paired');
    expect(result.predictions[0]).toMatchObject({
      predictionStatus: 'context_incomplete',
      predictionError: 'context_incomplete',
    });
    expect(result.predictions[0]?.predictorInput?.triggeringInbound.attachments).toEqual([
      expect.objectContaining({
        filename: 'confirmation.pdf',
        availability: 'unavailable',
      }),
    ]);
    expect(result.audit.contextIncompleteCount).toBe(1);
    await cleanup(fixture.root);
  });

  it('freezes hashes before worker invocation and fails closed when Luna is unavailable', async () => {
    const inbound = normalRecord({ id: 'inbound-unavailable' });
    const target = normalRecord({
      id: 'outbound-unavailable',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T10:00:00.000Z',
      sentAt: '2026-09-08T10:00:00.000Z',
      receivedAt: null,
      textBody: 'Unavailable transport response.',
      htmlBody: '<p>Unavailable transport response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    let manifestExistsDuringWorker = false;
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async () => {
          manifestExistsDuringWorker = true;
          throw new Error('luna_worker_transport_unavailable');
        },
      },
    });
    expect(manifestExistsDuringWorker).toBe(true);
    expect(result.targets[0]?.preTargetInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.predictions[0]).toMatchObject({
      predictionStatus: 'prediction_error',
      predictionError: 'luna_worker_transport_unavailable',
      operations: [],
    });
    expect(result.audit.workerRuntimeBlockers).toEqual(['luna_worker_transport_unavailable']);
    expect((await stat(path.join(fixture.output, 'target-manifest.jsonl'))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(fixture.output)).mode & 0o777).toBe(0o700);
    await cleanup(fixture.root);
  });

  it('persists multi-operation predictions with a deterministic primary and required unknown reasons', async () => {
    const inbound = normalRecord({ id: 'inbound-multi' });
    const target = normalRecord({
      id: 'outbound-multi',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T11:00:00.000Z',
      sentAt: '2026-09-08T11:00:00.000Z',
      receivedAt: null,
      textBody: 'Multi-operation human response.',
      htmlBody: '<p>Multi-operation human response.</p>',
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    const seenWorkerIds = new Set<string>();
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async (request) => {
          seenWorkerIds.add(request.workerId);
          return prediction({
            operations: [
              {
                operation: 'post_payment',
                needLevel: 'likely',
                requiredFields: ['amount', 'currency'],
                candidateTool: 'hms_post_payment',
                unknownReason: null,
              },
              {
                operation: 'read',
                needLevel: 'required',
                requiredFields: ['reservationRef'],
                candidateTool: 'hms_find_reservation',
                unknownReason: null,
              },
              {
                operation: 'unknown',
                needLevel: 'unknown',
                requiredFields: [],
                candidateTool: null,
                unknownReason: 'The reply does not identify the remaining operation.',
              },
            ],
            primaryOperation: 'read',
            needLevel: 'required',
            requiredFields: ['reservationRef'],
            candidateTool: 'hms_find_reservation',
            unknownReason: null,
          });
        },
      },
    });
    expect(seenWorkerIds.size).toBe(1);
    expect(result.predictions[0]).toMatchObject({
      predictionStatus: 'frozen',
      primaryOperation: 'read',
      needLevel: 'required',
      requiredFields: ['reservationRef'],
      candidateTool: 'hms_find_reservation',
    });
    expect(result.predictions[0]?.operations.map((item) => item.operation)).toEqual([
      'post_payment',
      'read',
      'unknown',
    ]);
    await cleanup(fixture.root);
  });

  it('removes unprefixed quoted replies but fails closed when a target header appears in live text', async () => {
    const targetBody = 'Private target reply that must remain blinded.';
    const targetSubject = 'Private target subject header.';
    const inbound = normalRecord({
      id: 'inbound-quote-marker',
      textBody: `Current request.\nOn Tue, 8 Sep 2026 at 09:00, staff wrote:\n${targetBody}`,
      htmlBody: `<p>Current request.</p><p>On Tue, 8 Sep 2026 at 09:00, staff wrote:</p><p>${targetBody}</p>`,
    });
    const target = normalRecord({
      id: 'outbound-quote-marker',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      subject: targetSubject,
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      textBody: targetBody,
      htmlBody: `<p>${targetBody}</p>`,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-quote-marker@example.test>',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    const requests: HumanResponseWorkerRequest[] = [];
    await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async (request) => {
          requests.push(request);
          return prediction();
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.input)).not.toContain(targetBody);
    await cleanup(fixture.root);

    const headerLeakInbound = normalRecord({
      id: 'inbound-header-leak',
      textBody: `Current request.\nSubject: ${targetSubject}`,
      htmlBody: `<p>Current request.</p><p>Subject: ${targetSubject}</p>`,
    });
    const headerLeakTarget = {
      ...target,
      id: 'outbound-header-leak',
      messageId: '<outbound-header-leak@example.test>',
      inReplyTo: '<inbound-header-leak@example.test>',
      textBody: 'A different private target body.',
      htmlBody: '<p>A different private target body.</p>',
    };
    const headerFixture = await writeFixture({ normal: [headerLeakInbound, headerLeakTarget] });
    let headerCalls = 0;
    const headerResult = await analyseCenturionHumanResponses({
      normalSnapshotDir: headerFixture.normal,
      quarantineSnapshotDir: headerFixture.quarantine,
      classificationPath: headerFixture.classification,
      outputDir: headerFixture.output,
      snapshotId: headerFixture.snapshotId,
      workerTransport: {
        predict: async () => {
          headerCalls += 1;
          return prediction();
        },
      },
    });
    expect(headerCalls).toBe(0);
    expect(headerResult.targets[0]).toMatchObject({
      predictionError: 'target_payload_leakage',
      contextIncomplete: true,
    });
    expect(headerResult.predictions[0]?.predictionError).toBe('target_payload_leakage');
    await cleanup(headerFixture.root);
  });

  it('requires a hash-verified classified human outbound before creating a target', async () => {
    const target = normalRecord({
      id: 'unclassified-outbound',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
    });
    const fixture = await writeFixture({ normal: [target], classification: [] });
    let calls = 0;
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async () => {
          calls += 1;
          return prediction();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.targets).toHaveLength(0);
    await cleanup(fixture.root);

    const invalid = await writeFixture({
      normal: [target],
      classification: [
        classificationFor(target, 'normal', {
          status: 'worker_error',
          inputHash: sha('tampered source record'),
        }),
      ],
    });
    await expect(
      analyseCenturionHumanResponses({
        normalSnapshotDir: invalid.normal,
        quarantineSnapshotDir: invalid.quarantine,
        classificationPath: invalid.classification,
        outputDir: invalid.output,
        snapshotId: invalid.snapshotId,
      }),
    ).rejects.toThrow('classification_input_hash_mismatch');
    await cleanup(invalid.root);
  });

  it('marks an unknown-time linked inbound context incomplete and never predicts it', async () => {
    const inbound = normalRecord({
      id: 'inbound-unknown-time',
      messageId: '<inbound-unknown-time@example.test>',
      eventAt: null,
      receivedAt: null,
      createdAt: null,
      dailyIncluded: false,
    });
    const target = normalRecord({
      id: 'outbound-unknown-time',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-unknown-time@example.test>',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    let calls = 0;
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async () => {
          calls += 1;
          return prediction();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.targets[0]).toMatchObject({
      targetStatus: 'no_eligible_inbound',
      candidateInboundRecordIds: ['normal:inbound-unknown-time'],
      contextIncomplete: true,
      predictionError: 'context_incomplete',
    });
    expect(result.predictions[0]).toMatchObject({
      predictionStatus: 'context_incomplete',
      predictionError: 'context_incomplete',
      predictorInput: null,
    });
    await cleanup(fixture.root);
  });

  it('includes identity-linked ambiguous direction candidates instead of treating them as absent', async () => {
    const ambiguous = normalRecord({
      id: 'ambiguous-direction',
      messageId: '<ambiguous-direction@example.test>',
      direction: 'unknown',
      messageDirection: 'unknown',
      businessDirection: 'ambiguous',
    });
    const target = normalRecord({
      id: 'outbound-ambiguous-direction',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<ambiguous-direction@example.test>',
    });
    const fixture = await writeFixture({
      normal: [ambiguous, target],
      classification: [
        classificationFor(ambiguous, 'normal', {
          businessDirection: 'ambiguous',
          origin: 'unknown',
        }),
        classificationFor(target),
      ],
    });
    let calls = 0;
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async () => {
          calls += 1;
          return prediction();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.targets[0]).toMatchObject({
      targetStatus: 'ambiguous',
      candidateInboundRecordIds: ['normal:ambiguous-direction'],
      predictionError: 'target_status_ambiguous',
    });
    await cleanup(fixture.root);
  });

  it('rejects conflicting aliases, unbounded fields, and non-canonical singular predictions', async () => {
    expect(HUMAN_RESPONSE_SCHEMA_HASH).toMatch(/^[a-f0-9]{64}$/);
    const inbound = normalRecord({ id: 'inbound-schema' });
    const target = normalRecord({
      id: 'outbound-schema',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-schema@example.test>',
      textBody: 'Schema target reply.',
      htmlBody: '<p>Schema target reply.</p>',
    });
    const responses: unknown[] = [
      {
        ...prediction(),
        operations: [
          {
            operation: 'read',
            op: 'cancel',
            needLevel: 'required',
            requiredFields: [],
            candidateTool: null,
            unknownReason: null,
          },
        ],
      },
      {
        ...prediction(),
        operations: [
          {
            operation: 'read',
            needLevel: 'required',
            requiredFields: Array.from({ length: 33 }, (_, index) => `field-${index}`),
            candidateTool: null,
            unknownReason: null,
          },
        ],
      },
      {
        opaqueId: 'singular-only',
        operation: 'read',
        needLevel: 'required',
        requiredFields: [],
        candidateTool: null,
        unknownReason: null,
      },
    ];
    for (const [index, response] of responses.entries()) {
      const fixture = await writeFixture({
        normal: [inbound, { ...target, id: `${target.id}-${index}` }],
      });
      const result = await analyseCenturionHumanResponses({
        normalSnapshotDir: fixture.normal,
        quarantineSnapshotDir: fixture.quarantine,
        classificationPath: fixture.classification,
        outputDir: fixture.output,
        snapshotId: fixture.snapshotId,
        maxRetries: 0,
        workerTransport: { predict: async () => response },
      });
      expect(result.predictions[0]).toMatchObject({
        predictionStatus: 'prediction_error',
        predictionError: 'prediction_parse_error',
      });
      await cleanup(fixture.root);
    }
  });

  it('keeps a deep immutable predictor snapshot when the worker mutates its request', async () => {
    const inbound = normalRecord({ id: 'inbound-mutation' });
    const target = normalRecord({
      id: 'outbound-mutation',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-mutation@example.test>',
      textBody: 'Mutation target reply.',
      htmlBody: '<p>Mutation target reply.</p>',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    let requestHash = '';
    const result = await analyseCenturionHumanResponses({
      normalSnapshotDir: fixture.normal,
      quarantineSnapshotDir: fixture.quarantine,
      classificationPath: fixture.classification,
      outputDir: fixture.output,
      snapshotId: fixture.snapshotId,
      workerTransport: {
        predict: async (request) => {
          requestHash = request.inputHash;
          request.input.triggeringInbound.textBody = 'worker mutation';
          request.input.triggeringInbound.attachments.push({
            attachmentId: null,
            filename: 'worker-mutation',
            contentType: 'text/plain',
            byteSize: 1,
            contentId: null,
            availability: 'available',
            sourceRecordId: 'worker',
          });
          request.input.earlierContext.push({ ...request.input.triggeringInbound });
          return prediction();
        },
      },
    });
    expect(result.predictions[0]?.predictionStatus).toBe('frozen');
    expect(result.predictions[0]?.inputHash).toBe(requestHash);
    expect(result.predictions[0]?.predictorInput?.triggeringInbound.textBody).toContain(
      'Please quote a room',
    );
    expect(result.predictions[0]?.predictorInput?.triggeringInbound.textBody).not.toContain(
      'worker mutation',
    );
    expect(result.predictions[0]?.predictorInput?.earlierContext).toHaveLength(0);
    await cleanup(fixture.root);
  });

  it('rejects the existing apps/server-pilot private directory and accepts only the ignored repo root', async () => {
    const inbound = normalRecord({ id: 'inbound-private-root' });
    const target = normalRecord({
      id: 'outbound-private-root',
      direction: 'outbound',
      messageDirection: 'outbound',
      businessDirection: 'outbound',
      eventAt: '2026-09-08T09:00:00.000Z',
      sentAt: '2026-09-08T09:00:00.000Z',
      receivedAt: null,
      confirmedOutbound: true,
      queueState: 'sent',
      inReplyTo: '<inbound-private-root@example.test>',
    });
    const fixture = await writeFixture({ normal: [inbound, target] });
    const unsafeOutput = path.join(
      process.cwd(),
      'apps',
      'server-pilot',
      '.private',
      'centurion-corpus',
      'fixture-u4',
    );
    await expect(
      analyseCenturionHumanResponses({
        normalSnapshotDir: fixture.normal,
        quarantineSnapshotDir: fixture.quarantine,
        classificationPath: fixture.classification,
        outputDir: unsafeOutput,
        snapshotId: fixture.snapshotId,
      }),
    ).rejects.toThrow('output_private_root_invalid');
    await cleanup(fixture.root);
  });
});
