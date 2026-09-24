import {
  CENTURION_QUARANTINE_WINDOW,
  buildCenturionQuarantineSnapshot,
  createCenturionQuarantineExportCommand,
  createCenturionQuarantinePostgresReader,
  type CenturionQuarantinePostgresClient,
  type CenturionQuarantineMetadataRow,
  type CenturionQuarantineQueueRow,
  type CenturionQuarantineSnapshot,
  type CenturionQuarantineStorage,
} from '../scripts/export-centurion-quarantine-live';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const AS_OF = '2026-09-18T00:00:00.000Z';
const CENTURION_IDENTITIES = new Set(['centurion@example.test', 'centurion-alias@example.test']);

function metadata(
  overrides: Partial<CenturionQuarantineMetadataRow> = {},
): CenturionQuarantineMetadataRow {
  return {
    id: overrides.id ?? 'q-1',
    ingestMailboxId: overrides.ingestMailboxId ?? 'ingest-nava-legacy',
    ingestMailboxEmail: overrides.ingestMailboxEmail ?? null,
    pop3Uidl: overrides.pop3Uidl ?? 'uidl-1',
    rawMimeS3Key: overrides.rawMimeS3Key ?? 'raw-mime/ingest-nava-legacy/uidl-1.eml',
    reason: overrides.reason ?? 'parse_failure',
    ownerHeaderValue: overrides.ownerHeaderValue ?? null,
    parsedHeaders: overrides.parsedHeaders ?? null,
    quarantineCreatedAt: overrides.quarantineCreatedAt ?? '2026-09-17T01:00:00.000Z',
  };
}

function mime(headers: string, body = 'Hello from the guest.'): Buffer {
  return Buffer.from(`${headers}\r\n\r\n${body}\r\n`, 'utf8');
}

function inboundMime(overrides: { date?: string; owner?: string; body?: string } = {}): Buffer {
  return mime(
    [
      'From: Guest <guest@example.test>',
      'To: Centurion <centurion@example.test>',
      `Date: ${overrides.date ?? 'Wed, 09 Sep 2026 10:00:00 +0000'}`,
      'Message-ID: <guest-1@example.test>',
      `X-Zero-Mailbox: ${overrides.owner ?? 'centurion@example.test'}`,
      'Subject: A booking request',
      'Content-Type: text/plain; charset=utf-8',
    ].join('\r\n'),
    overrides.body,
  );
}

function fakeStorage(objects: Record<string, Buffer>): CenturionQuarantineStorage {
  return {
    async getObjectBounded(key) {
      const body = objects[key];
      return body ? { body, contentType: 'message/rfc822' } : null;
    },
  };
}

async function build(
  rows: readonly CenturionQuarantineMetadataRow[],
  objects: Record<string, Buffer>,
  options: {
    queueRows?: readonly CenturionQuarantineQueueRow[];
    maxMessageBytes?: number;
    maxAttachmentBytes?: number;
  } = {},
): Promise<CenturionQuarantineSnapshot> {
  return await buildCenturionQuarantineSnapshot({
    asOf: AS_OF,
    rows,
    transportIdentities: CENTURION_IDENTITIES,
    queueRows: options.queueRows ?? [],
    existingMessages: [],
    storage: fakeStorage(objects),
    maxMessageBytes: options.maxMessageBytes,
    maxAttachmentBytes: options.maxAttachmentBytes,
  });
}

describe('Centurion quarantine recovery', () => {
  it('parses a parse-failure row locally and preserves date, created time, body, headers and hash', async () => {
    const row = metadata();
    const raw = inboundMime();
    const snapshot = await build([row], { [row.rawMimeS3Key]: raw });
    const record = snapshot.records[0]!;

    expect(record.status).toBe('inbound');
    expect(record.parseStatus).toBe('parsed');
    expect(record.messageDate).toBe('2026-09-09T10:00:00.000Z');
    expect(record.quarantineCreatedAt).toBe('2026-09-17T01:00:00.000Z');
    expect(record.textBody).toContain('Hello from the guest.');
    expect(record.headers['message-id']).toEqual(['<guest-1@example.test>']);
    expect(record.rawMime.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(record.rawMime.status).toBe('available');
    expect(snapshot.counts.parseFailureCount).toBe(1);
  });

  it('keeps malformed MIME as an explicit parse error', async () => {
    const row = metadata();
    const snapshot = await build([row], { [row.rawMimeS3Key]: Buffer.from('not an RFC message') });

    expect(snapshot.records[0]).toMatchObject({
      status: 'parse_error',
      parseStatus: 'parse_error',
      messageDate: null,
      reportPartition: 'undated',
    });
  });

  it('tries the archive key read-only and distinguishes missing objects', async () => {
    const archived = metadata({
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/archive-me.eml',
      pop3Uidl: 'archive-me',
    });
    const archiveKey = 'quarantine-archive/ingest-nava-legacy/archive-me.eml';
    const snapshot = await build([archived], { [archiveKey]: inboundMime() });
    expect(snapshot.records[0]!.rawMime.source).toBe('archive');
    expect(snapshot.records[0]!.rawMime.primaryStatus).toBe('missing');
    expect(snapshot.records[0]!.rawMime.archiveStatus).toBe('available');

    const missing = metadata({ id: 'q-missing', pop3Uidl: 'missing' });
    const missingSnapshot = await build([missing], {});
    expect(missingSnapshot.records[0]).toMatchObject({
      status: 'missing_object',
      parseStatus: 'missing_object',
      rawMime: { status: 'missing', source: null },
    });

    const oversized = metadata({ id: 'q-oversized', pop3Uidl: 'oversized' });
    const oversizedSnapshot = await build(
      [oversized],
      { [oversized.rawMimeS3Key]: Buffer.alloc(8) },
      { maxMessageBytes: 4 },
    );
    expect(oversizedSnapshot.records[0]).toMatchObject({
      status: 'missing_object',
      parseStatus: 'missing_object',
      rawMime: { status: 'oversized' },
    });
  });

  it('fails closed for owner mismatch and unrelated ingest mailbox', async () => {
    const mismatch = metadata({
      id: 'q-mismatch',
      ownerHeaderValue: 'other@example.test',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/mismatch.eml',
      pop3Uidl: 'mismatch',
    });
    const unrelated = metadata({
      id: 'q-unrelated',
      ingestMailboxId: 'ingest-other',
      rawMimeS3Key: 'raw-mime/ingest-other/unrelated.eml',
      pop3Uidl: 'unrelated',
    });
    const snapshot = await build([mismatch, unrelated], {
      [mismatch.rawMimeS3Key]: inboundMime({ owner: 'other@example.test' }),
      [unrelated.rawMimeS3Key]: inboundMime(),
    });

    expect(snapshot.records[0]).toMatchObject({
      status: 'unattributed',
      routingStatus: 'owner_mismatch',
    });
    expect(snapshot.records[1]).toMatchObject({
      status: 'unattributed',
      routingStatus: 'unrelated_mailbox',
      rawMime: { status: 'not_attempted' },
    });
  });

  it('uses BCC mirror evidence for inbound and keeps a self-loopback without queue proof ambiguous', async () => {
    const bcc = metadata({
      id: 'q-bcc',
      pop3Uidl: 'bcc',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/bcc.eml',
    });
    const self = metadata({
      id: 'q-self',
      pop3Uidl: 'self',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/self.eml',
    });
    const snapshot = await build([bcc, self], {
      [bcc.rawMimeS3Key]: mime(
        [
          'From: Guest <guest@example.test>',
          'To: booking@example.test',
          'Bcc: centurion@example.test',
          'Date: Wed, 09 Sep 2026 10:00:00 +0000',
          'Message-ID: <bcc@example.test>',
          'Content-Type: text/plain',
        ].join('\r\n'),
      ),
      [self.rawMimeS3Key]: mime(
        [
          'From: Centurion <centurion@example.test>',
          'To: centurion@example.test',
          'Date: Wed, 09 Sep 2026 11:00:00 +0000',
          'Message-ID: <self@example.test>',
          'X-Zero-Mailbox: centurion@example.test',
          'Content-Type: text/plain',
        ].join('\r\n'),
      ),
    });

    expect(snapshot.records.find((record) => record.id === 'q-bcc')?.status).toBe('inbound');
    expect(snapshot.records.find((record) => record.id === 'q-bcc')?.evidence.bccMirror).toBe(true);
    expect(snapshot.records.find((record) => record.id === 'q-self')?.status).toBe('ambiguous');
    expect(snapshot.records.find((record) => record.id === 'q-self')?.evidence.selfLoopback).toBe(
      true,
    );
  });

  it('records duplicate UIDL and raw hashes without collapsing source rows', async () => {
    const first = metadata({
      id: 'q-first',
      pop3Uidl: 'same-uidl',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/first.eml',
    });
    const second = metadata({
      id: 'q-second',
      pop3Uidl: 'same-uidl',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/second.eml',
    });
    const raw = inboundMime();
    const snapshot = await build([first, second], {
      [first.rawMimeS3Key]: raw,
      [second.rawMimeS3Key]: raw,
    });

    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.counts.duplicateUidGroupCount).toBe(1);
    expect(snapshot.counts.duplicateRawHashGroupCount).toBe(1);
    expect(snapshot.records.every((record) => record.duplicateUidl)).toBe(true);
    expect(snapshot.records.every((record) => record.duplicateRawHash)).toBe(true);
  });

  it('keeps missing RFC Date undated and records unsupported or oversized attachment statuses', async () => {
    const row = metadata({ id: 'q-attachments', pop3Uidl: 'attachments' });
    const raw = mime(
      [
        'From: Guest <guest@example.test>',
        'To: centurion@example.test',
        'Message-ID: <attachments@example.test>',
        'Content-Type: multipart/mixed; boundary="parts"',
      ].join('\r\n'),
      [
        '--parts',
        'Content-Type: text/plain',
        '',
        'body',
        '--parts',
        'Content-Type: image/png',
        'Content-Disposition: inline; filename="pixel.png"',
        'Content-Transfer-Encoding: base64',
        'Content-ID: <pixel@example.test>',
        '',
        'aGVsbG8=',
        '--parts',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="large.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'MTIzNDU2Nzg5',
        '--parts--',
      ].join('\r\n'),
    );
    const snapshot = await build([row], { [row.rawMimeS3Key]: raw }, { maxAttachmentBytes: 4 });
    const record = snapshot.records[0]!;

    expect(record.dateStatus).toBe('missing');
    expect(record.messageDate).toBeNull();
    expect(record.reportPartition).toBe('undated');
    expect(record.attachments.map((attachment) => attachment.contentStatus)).toEqual([
      'unsupported',
      'oversized',
    ]);
  });

  it('keeps invalid and calendar-overflow RFC Date headers undated', async () => {
    const invalid = metadata({
      id: 'q-invalid-date',
      pop3Uidl: 'invalid-date',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/invalid-date.eml',
    });
    const overflow = metadata({
      id: 'q-overflow-date',
      pop3Uidl: 'overflow-date',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/overflow-date.eml',
    });
    const snapshot = await build([invalid, overflow], {
      [invalid.rawMimeS3Key]: inboundMime({ date: 'not-a-date' }),
      [overflow.rawMimeS3Key]: inboundMime({ date: 'Wed, 31 Sep 2026 10:00:00 +0000' }),
    });

    expect(snapshot.records.find((record) => record.id === invalid.id)).toMatchObject({
      dateStatus: 'invalid',
      messageDate: null,
      reportPartition: 'undated',
    });
    expect(snapshot.records.find((record) => record.id === overflow.id)).toMatchObject({
      dateStatus: 'invalid',
      messageDate: null,
      reportPartition: 'undated',
    });
  });

  it('separates the Johannesburg core window from September 17 spillover', async () => {
    const core = metadata({
      id: 'q-core',
      pop3Uidl: 'core',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/core.eml',
    });
    const spillover = metadata({
      id: 'q-spill',
      pop3Uidl: 'spill',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/spill.eml',
    });
    const snapshot = await build([core, spillover], {
      [core.rawMimeS3Key]: inboundMime({ date: 'Tue, 15 Sep 2026 21:59:00 +0000' }),
      [spillover.rawMimeS3Key]: inboundMime({ date: 'Fri, 18 Sep 2026 14:50:00 +0000' }),
    });

    expect(CENTURION_QUARANTINE_WINDOW).toMatchObject({
      timezone: 'Africa/Johannesburg',
      startInclusive: '2026-09-08T22:00:00.000Z',
      endExclusive: '2026-09-18T14:50:00.000Z',
    });
    expect(snapshot.counts.coreCount).toBe(1);
    expect(snapshot.counts.september17SpilloverCount).toBe(1);
    expect(snapshot.records.find((record) => record.id === 'q-core')?.reportPartition).toBe('core');
    expect(snapshot.records.find((record) => record.id === 'q-spill')?.reportPartition).toBe(
      'september17_spillover',
    );
  });

  it('correlates a sent queue outcome as outbound while retaining read-only count output', async () => {
    const row = metadata({ id: 'q-outbound', pop3Uidl: 'outbound' });
    const queueRow: CenturionQuarantineQueueRow = {
      messageId: 'message-outbound',
      transportId: 'transport-centurion',
      status: 'sent',
      messageIdHeader: '<outbound@example.test>',
      smtpPayload: null,
      createdAt: '2026-09-09T10:01:00.000Z',
    };
    const raw = mime(
      [
        'From: Centurion <centurion@example.test>',
        'To: guest@example.test',
        'Date: Wed, 09 Sep 2026 10:00:00 +0000',
        'Message-ID: <outbound@example.test>',
        'Content-Type: text/plain',
      ].join('\r\n'),
    );
    const snapshot = await build([row], { [row.rawMimeS3Key]: raw }, { queueRows: [queueRow] });
    expect(snapshot.records[0]).toMatchObject({
      status: 'outbound',
      evidence: { queueCorrelated: true },
    });
  });

  it('fails closed when persisted and raw owner headers conflict', async () => {
    const aliasConflict = metadata({
      id: 'q-owner-alias-conflict',
      ownerHeaderValue: 'centurion@example.test',
      pop3Uidl: 'owner-alias-conflict',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/owner-alias-conflict.eml',
    });
    const nonCenturionConflict = metadata({
      id: 'q-owner-non-centurion-conflict',
      ownerHeaderValue: 'other@example.test',
      pop3Uidl: 'owner-non-centurion-conflict',
      rawMimeS3Key: 'raw-mime/ingest-nava-legacy/owner-non-centurion-conflict.eml',
    });
    const snapshot = await build([aliasConflict, nonCenturionConflict], {
      [aliasConflict.rawMimeS3Key]: inboundMime({ owner: 'centurion-alias@example.test' }),
      [nonCenturionConflict.rawMimeS3Key]: inboundMime({ owner: 'centurion@example.test' }),
    });

    for (const id of [aliasConflict.id, nonCenturionConflict.id]) {
      expect(snapshot.records.find((record) => record.id === id)).toMatchObject({
        status: 'unattributed',
        routingStatus: 'owner_mismatch',
        evidence: { ownerHeaderMismatch: true },
      });
    }
  });

  it('command publishes only private snapshot data and returns measured counts', async () => {
    const row = metadata();
    const snapshot = await build([row], { [row.rawMimeS3Key]: inboundMime() });
    let written: { snapshot: CenturionQuarantineSnapshot } | undefined;
    const stderr: string[] = [];
    const stdout: string[] = [];
    const command = createCenturionQuarantineExportCommand({
      args: () => [],
      platform: () => 'linux',
      scriptPath: () =>
        '/synthetic/zero/apps/server-pilot/scripts/export-centurion-quarantine-live.ts',
      attestImdsV2: async () => true,
      uuid: () => '123e4567-e89b-12d3-a456-426614174000',
      environment: () => ({
        DATABASE_URL: 'fixture://non-production',
        AWS_REGION: 'fixture-region-1',
        S3_BUCKET: 'fixture-bucket',
      }),
      preflightOutputDestination: async () => undefined,
      createReader: () => ({
        async readCenturionQuarantineSnapshot() {
          return snapshot;
        },
        async close() {},
      }),
      createStorage: () => fakeStorage({ [row.rawMimeS3Key]: inboundMime() }),
      writeSnapshot: async (request) => {
        written = { snapshot: request.snapshot };
      },
      validateAllocatedDir: () => undefined,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });

    expect(await command()).toBe(0);
    expect(written?.snapshot.counts.parseFailureCount).toBe(1);
    expect(JSON.parse(stdout[0]!).parseFailureCount).toBe(1);
    expect(stderr).toEqual([]);
  });

  it('reads quarantine, queue and duplicate metadata inside one repeatable read-only transaction', async () => {
    const row = metadata();
    const queries: Array<{ text: string; insideTransaction: boolean }> = [];
    const beginOptions: string[] = [];
    let insideTransaction = false;
    const queryText = (strings: TemplateStringsArray): string =>
      strings.reduce(
        (result, fragment, index) =>
          `${result}${fragment}${index < strings.length - 1 ? `$${index + 1}` : ''}`,
        '',
      );
    let client: CenturionQuarantinePostgresClient;
    const query = async (
      strings: TemplateStringsArray,
      ..._values: readonly unknown[]
    ): Promise<readonly Record<string, unknown>[]> => {
      const text = queryText(strings);
      queries.push({ text, insideTransaction });
      if (/FROM mailbox_transport/i.test(text)) {
        return [
          {
            id: 'transport-centurion',
            email: 'centurion@example.test',
            ownerHeaderValue: 'centurion@example.test',
            sendFromConfig: null,
          },
        ];
      }
      if (/FROM mail_ingest_quarantine/i.test(text)) {
        return [
          {
            id: row.id,
            ingestMailboxId: row.ingestMailboxId,
            ingestMailboxEmail: row.ingestMailboxEmail,
            pop3Uidl: row.pop3Uidl,
            rawMimeS3Key: row.rawMimeS3Key,
            reason: row.reason,
            ownerHeaderValue: row.ownerHeaderValue,
            parsedHeaders: row.parsedHeaders,
            quarantineCreatedAt: row.quarantineCreatedAt,
          },
        ];
      }
      if (/FROM outbound_send_queue/i.test(text)) return [];
      if (/FROM message AS m/i.test(text)) {
        return [
          {
            id: 'future-message',
            transportId: 'transport-centurion',
            ingestMailboxId: row.ingestMailboxId,
            pop3Uidl: row.pop3Uidl,
            rawMimeS3Key: row.rawMimeS3Key,
            messageIdHeader: '<future-message@example.test>',
            direction: 'inbound',
            createdAt: '2026-09-19T00:00:00.000Z',
          },
        ];
      }
      throw new Error(`unexpected synthetic query ${text}`);
    };
    const begin = async <T>(
      options: string,
      load: (connection: CenturionQuarantinePostgresClient) => Promise<T>,
    ): Promise<T> => {
      beginOptions.push(options);
      insideTransaction = true;
      try {
        return await load(client);
      } finally {
        insideTransaction = false;
      }
    };
    client = Object.assign(query, {
      begin,
      async end() {},
    }) as unknown as CenturionQuarantinePostgresClient;

    const reader = createCenturionQuarantinePostgresReader({
      databaseUrl: 'fixture://non-production',
      asOf: AS_OF,
      storage: fakeStorage({ [row.rawMimeS3Key]: inboundMime() }),
      clientFactory: () => client,
    });
    const snapshot = await reader.readCenturionQuarantineSnapshot();
    await reader.close();

    expect(snapshot.counts.quarantineRowCount).toBe(1);
    expect(beginOptions).toEqual(['isolation level repeatable read read only']);
    expect(queries).not.toHaveLength(0);
    expect(queries.every((query) => query.insideTransaction)).toBe(true);
    expect(queries.every((query) => /^(?:SELECT|WITH\b)/i.test(query.text.trim()))).toBe(true);
    expect(queries.some((query) => /mail_ingest_quarantine/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /outbound_send_queue/i.test(query.text))).toBe(true);
    expect(
      queries.some(
        (query) =>
          /FROM message AS m/i.test(query.text) && /m\.created_at\s*<\s*\$\d+/i.test(query.text),
      ),
    ).toBe(true);
    expect(snapshot.records[0]!.duplicateUidl).toBe(false);
  });
});
