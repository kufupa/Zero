import { buildMailboxSplitDryRunReport } from '../scripts/mailbox-split-dry-run.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it, vi } from 'vitest';

describe('mailbox split read-only dry run', () => {
  it('reports header-only routing and dedup counts without exposing mail data or writing', async () => {
    const storage = new FakeS3Storage('mailbox-split-test');
    const raw = Buffer.from(
      [
        'From: guest@example.test',
        'To: centurion@example.test',
        'Message-ID: <same@example.test>',
        'Subject: private subject',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'private body text',
      ].join('\r\n'),
    );
    const keys = ['raw/one', 'raw/two'];
    await Promise.all(
      keys.map((key) => storage.putObject({ key, body: raw, contentType: 'message/rfc822' })),
    );
    const putObject = vi.spyOn(storage, 'putObject');
    const report = await buildMailboxSplitDryRunReport({
      quarantineRows: [
        {
          id: 'quarantine-one',
          ingestMailboxId: 'ingest-test',
          pop3Uidl: 'uidl-one',
          rawMimeS3Key: keys[0]!,
          reason: 'missing_owner_header',
        },
        {
          id: 'quarantine-two',
          ingestMailboxId: 'ingest-test',
          pop3Uidl: 'uidl-two',
          rawMimeS3Key: keys[1]!,
          reason: 'parse_failure',
        },
        {
          id: 'quarantine-other',
          ingestMailboxId: 'ingest-test',
          pop3Uidl: 'uidl-other',
          rawMimeS3Key: 'raw/missing',
          reason: 'unknown_transport',
        },
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@example.test',
          isActive: true,
          sendFromConfig: null,
        },
        {
          id: 'transport-davinci-shared',
          email: 'davinci@example.test',
          isActive: false,
          sendFromConfig: null,
        },
      ],
      storage,
    });

    expect(report).toMatchObject({
      quarantineRows: 3,
      missingOwnerHeaderRows: 1,
      parseFailureRows: 1,
      otherQuarantineRows: 1,
      unreadableRows: 0,
      headerParseFailures: 0,
      summary: {
        scanned: 2,
        uniqueMessages: 1,
        duplicateCopies: 1,
        mailboxes: [
          {
            transportId: 'transport-centurion',
            active: true,
            inboundCandidates: 2,
            wouldPromote: 2,
            uniqueCanonicalMessages: 1,
            duplicateCopies: 1,
          },
          {
            transportId: 'transport-davinci-shared',
            active: false,
            wouldPromote: 0,
          },
        ],
      },
    });
    expect(putObject).not.toHaveBeenCalled();
    const output = JSON.stringify(report);
    expect(output).not.toContain('guest@example.test');
    expect(output).not.toContain('same@example.test');
    expect(output).not.toContain('private subject');
    expect(output).not.toContain('private body text');
    expect(output).not.toContain('raw/one');
  });
});
