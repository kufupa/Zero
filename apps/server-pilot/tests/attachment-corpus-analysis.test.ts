import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  type ThreadCorpusHydrationInput,
  type ThreadCorpusSourceRow,
} from '../src/ops/centurion-thread-corpus-snapshot.js';
import { hydrateThreadCorpusArtifacts } from '../src/ops/centurion-thread-corpus-hydrator.js';
import { verifyAttachmentCorpusExport } from '../scripts/verify-attachment-corpus-export.js';

const execFileAsync = promisify(execFile);
const AS_OF = '2026-08-31T12:00:00.000Z';

function row(): ThreadCorpusSourceRow {
  return {
    sourceRowId: 'message-a',
    scopeMembership: ['active_transport'],
    receivedAt: '2026-08-31T10:00:00.000Z',
    threadId: 'thread-a',
    messageId: '<message-a@example.test>',
    contentFingerprint: 'content-a',
    provenanceFingerprint: 'provenance-a',
    body: 'Payment received: USD 123.45. Reservation ABC-123 confirmed.',
    privateMessage: {
      subject: 'Synthetic',
      direction: 'inbound',
      addresses: { from: [], to: [], cc: [], bcc: [] },
      originalAddresses: { from: [], to: [], cc: [], bcc: [] },
      canonicalHeaders: {},
      sentAt: null,
      rawMime: { locator: null, status: 'missing' },
      attachments: [
        {
          id: 'attachment-a',
          messageId: 'message-a',
          filename: 'confirmation.pdf',
          contentType: 'application/pdf',
          byteSize: 8,
          inline: 'unknown',
        },
      ],
      draftRevisionLinks: [],
      outboundDelivery: {
        queueState: 'unknown',
        deliveryStatus: 'not_claimed',
      },
      sourceMetadata: { transportId: 'transport-a' },
    },
  };
}

async function writeSnapshot(
  root: string,
  byteStatus: 'available' | 'unsupported' = 'available',
) {
  const formatted = formatLogicalMessages([row()]);
  const bytePayload =
    byteStatus === 'available'
      ? {
          kind: 'attachment_bytes' as const,
          attachmentId: 'attachment-a',
          status: 'available' as const,
          content: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        }
      : {
          kind: 'attachment_bytes' as const,
          attachmentId: 'attachment-a',
          status: 'unsupported' as const,
        };
  const hydration: ThreadCorpusHydrationInput = {
    attachmentLocators: [
      {
        attachmentId: 'attachment-a',
        messageId: 'message-a',
        s3Key: 'attachments/message-a/confirmation.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 8,
      },
    ],
    payloads: [
      {
        kind: 'attachment_text',
        attachmentId: 'attachment-a',
        status: 'available',
        content: new TextEncoder().encode(
          'Payment received: USD 123.45 Reservation ABC-123 confirmed',
        ),
      },
      bytePayload,
    ],
  };
  const snapshot = buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'snapshot-a',
      scope: {
        scopeKeys: ['active_transport'],
        transportIds: ['transport-a'],
        messagePredicate: 'active_transport_before_as_of',
      },
      asOf: AS_OF,
      exporterVersion: 'test-exporter',
    },
    formatted,
    hydration,
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'corpus.jsonl'), snapshot.corpusJsonl, {
    mode: 0o600,
  });
  await writeFile(path.join(root, 'manifest.json'), snapshot.manifestJson, {
    mode: 0o600,
  });
  for (const artifact of snapshot.artifactFiles) {
    const directory =
      artifact.kind === 'attachment_bytes'
        ? 'attachment-bytes'
        : artifact.kind === 'attachment_text'
          ? 'attachment-text'
          : 'raw-mime';
    const extension =
      artifact.kind === 'attachment_bytes'
        ? 'bin'
        : artifact.kind === 'attachment_text'
          ? 'txt'
          : 'eml';
    const directoryPath = path.join(root, directory);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directoryPath, `${artifact.id}.${extension}`),
      artifact.content,
      { mode: 0o600 },
    );
    await chmod(path.join(directoryPath, `${artifact.id}.${extension}`), 0o600);
  }
}

describe('attachment-inclusive corpus analysis', () => {
  it('hydrates original PDF bytes and seals a verifiable local snapshot', async () => {
    const storage = {
      async getObjectBounded(
        _key: string,
        _maxBytes: number,
        _signal?: AbortSignal,
      ) {
        return {
          body: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
          contentType: 'application/pdf',
        };
      },
    };
    const hydrated = await hydrateThreadCorpusArtifacts({
      formatted: formatLogicalMessages([row()]),
      attachmentLocators: [
        {
          attachmentId: 'attachment-a',
          messageId: 'message-a',
          s3Key: 'attachments/message-a/a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 8,
        },
      ],
      storage,
      retainAttachmentBytes: true,
      pdfExtractor: async () => ({
        status: 'ok',
        draftReady: false,
        data: {
          mimeType: 'application/pdf',
          text: 'USD 123.45 ABC-123',
          pageCount: 1,
          reason: 'text' as const,
        },
        unresolvedFields: [],
        evidence: {
          kind: 'mail_attachment' as const,
          id: 'evidence-a',
          toolId: 'mail_read_artifact' as const,
          toolVersion: 'test',
          attachmentId: 'attachment-a',
          observedAt: AS_OF,
          sourceHash: 'a'.repeat(64),
          claimKeys: [],
        },
      }),
    });
    expect(hydrated.payloads.map((payload) => payload.kind)).toEqual([
      'attachment_bytes',
      'attachment_text',
    ]);
    expect(
      hydrated.payloads.find((payload) => payload.kind === 'attachment_bytes'),
    ).toMatchObject({ status: 'available' });
  });

  it('produces PII-safe reconciliation output and verifies hashes/permissions', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'attachment-corpus-analysis-'),
    );
    try {
      await writeSnapshot(root);
      const verification = await verifyAttachmentCorpusExport(root);
      expect(verification.attachmentBytesArtifactCount).toBe(1);
      const outputJson = path.join(root, 'analysis.json');
      const outputMd = path.join(root, 'analysis.md');
      await execFileAsync('python3', [
        path.resolve(
          process.cwd(),
          'scripts/analyze-attachment-corpus-2026-08-31.py',
        ),
        '--snapshot-dir',
        root,
        '--out-json',
        outputJson,
        '--out-md',
        outputMd,
      ]);
      const report = JSON.parse(await readFile(outputJson, 'utf8')) as {
        counts: {
          attachments: number;
          pdfs: number;
          images: number;
          usefulDocuments: number;
        };
      };
      expect(report.counts.attachments).toBe(1);
      expect(report.counts.pdfs).toBe(1);
      expect(report.counts.images).toBe(0);
      expect(report.counts.usefulDocuments).toBe(1);
      expect(JSON.stringify(report)).not.toContain('Payment received');
      expect(JSON.stringify(report)).not.toContain('confirmation.pdf');
      expect(await readFile(outputMd, 'utf8')).toContain('both');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts attachment-inclusive snapshots when all byte artifacts are unavailable', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'attachment-corpus-analysis-no-bytes-'),
    );
    try {
      await writeSnapshot(root, 'unsupported');
      const verification = await verifyAttachmentCorpusExport(root);
      expect(verification.attachmentBytesArtifactCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked artifact directories during local verification', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'attachment-corpus-symlink-'),
    );
    try {
      await writeSnapshot(root);
      await rm(path.join(root, 'attachment-text'), {
        recursive: true,
        force: true,
      });
      await symlink('attachment-bytes', path.join(root, 'attachment-text'));
      await expect(verifyAttachmentCorpusExport(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
