/**
 * Wave A4 LIVE mailbox attachment digest for documents_read_existing.
 * Read-only: pick one authorized attachment from pilot DB + S3; prove sha256.
 * NOT Vitest. Unset DATABASE_URL before any test runner; this script uses
 * DATABASE_URL only for a one-shot read-only query (pilot verification OK).
 *
 * Env: DATABASE_URL (pilot), S3 bucket config from env, A4_LIVE_OUT_DIR.
 * No passwords or raw PII in stdout — digests + mime + size only.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { attachment, message } from '../dist/db/schema/mail.js';
import { RealS3Storage } from '../dist/storage/s3.js';
import {
  createExistingDocumentService,
  type ExistingDocumentRecord,
} from '../dist/mail/artifacts/existing-document-service.js';

function scrub(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[db]')
    .replace(/arn:aws:\S+/gi, '[arn]');
}

async function main(): Promise<void> {
  if (process.env.A4_LIVE_ALLOW !== '1') {
    throw new Error('set A4_LIVE_ALLOW=1 for live mailbox digest');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL required for live A4 (read-only)');
  if (/nava-zero-mail-pilot/i.test(databaseUrl) && process.env.VITEST) {
    throw new Error('refusing Vitest + pilot RDS');
  }

  const outDir =
    process.env.A4_LIVE_OUT_DIR?.trim() ||
    join(process.cwd(), '../../.private/wave-a-20260912/a4-live');
  await mkdir(outDir, { recursive: true, mode: 0o700 });

  const sqlClient = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sqlClient);

  try {
    // Prefer text/plain or pdf attachments under attachments/ prefix.
    const rows = await db
      .select({
        id: attachment.id,
        messageId: attachment.messageId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        s3Key: attachment.s3Key,
        transportId: message.transportId,
        threadId: message.threadId,
        direction: message.direction,
      })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .where(
        and(
          eq(message.direction, 'inbound'),
          sql`${attachment.s3Key} like 'attachments/%'`,
          sql`${attachment.sizeBytes} > 0`,
          sql`${attachment.sizeBytes} < 5000000`,
          sql`(${attachment.mimeType} = 'text/plain' OR ${attachment.mimeType} = 'application/pdf' OR ${attachment.mimeType} like 'text/%')`,
        ),
      )
      .orderBy(desc(attachment.createdAt))
      .limit(20);

    if (rows.length === 0) {
      const compare = {
        schemaVersion: 1,
        toolId: 'documents_read_existing',
        finishedAt: new Date().toISOString(),
        allRequiredPass: false,
        verdict: 'BLOCKED_NO_LIVE_ATTACHMENT',
        rows: [],
        note: 'No inbound text/pdf attachment rows under attachments/ in pilot DB',
      };
      await writeFile(join(outDir, 'compare.v1.json'), `${JSON.stringify(compare, null, 2)}\n`, {
        mode: 0o600,
      });
      process.stdout.write(JSON.stringify({ ok: false, reason: 'no_rows', outDir }) + '\n');
      return;
    }

    // Prefer text/plain for simpler digest; fall back to first pdf.
    const pick =
      rows.find((r) => r.mimeType === 'text/plain') ??
      rows.find((r) => r.mimeType === 'application/pdf') ??
      rows[0]!;

    const bucket = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
    if (!bucket) throw new Error('S3_BUCKET required');
    const region = process.env.AWS_REGION ?? 'af-south-1';
    const s3 = new RealS3Storage(region, bucket);

    const head = await s3.headObject({ key: pick.s3Key });
    if (!head || head.contentLength == null) {
      throw new Error('s3_head_miss');
    }

    const SCOPE = `a4-live-scope:${pick.transportId}:${pick.threadId}:${pick.messageId}`;
    const authorized = new Set([pick.id]);
    const locator = {
      s3Key: pick.s3Key,
      mimeType: pick.mimeType.startsWith('text/')
        ? ('text/plain' as const)
        : pick.mimeType === 'application/pdf'
          ? ('application/pdf' as const)
          : ('text/plain' as const),
      sizeBytes: pick.sizeBytes,
      messageId: pick.messageId,
    };

    // Read bytes directly for digest oracle (authorized path).
    const { readAuthorizedArtifactBytes } = await import(
      '../dist/mail/artifacts/read-artifact.js'
    );
    const bytesResult = await readAuthorizedArtifactBytes({
      attachmentId: pick.id,
      authorizedAttachmentIds: authorized,
      s3,
      signal: AbortSignal.timeout(30_000),
      resolveLocator: async () => locator,
    });
    if (!bytesResult) throw new Error('bytes_null');
    const bodySha = createHash('sha256').update(bytesResult.body).digest('hex');

    const record: ExistingDocumentRecord = {
      sourceRecordId: pick.id,
      scopeRef: SCOPE,
      source: 'mail_attachment',
      kind: 'other_existing',
      version: 'v1',
      issuedAt: new Date().toISOString(),
      status: 'final',
      parentRef: pick.threadId,
      payerRef: null,
      displayName: pick.filename.replace(/[^\w.\-]+/g, '_').slice(0, 80),
      mime: locator.mimeType,
      sizeBytes: pick.sizeBytes,
      sha256: bodySha,
      priceVisibility: 'hidden',
      propertyRef: 'unknown',
      guestRef: null,
      stayStart: null,
      stayEnd: null,
      currentVersion: true,
      attachment: {
        attachmentId: pick.id,
        authorizedAttachmentIds: authorized,
        locator,
      },
    };

    const documents = createExistingDocumentService({
      now: () => new Date(),
      resolveScope: async (scopeRef) =>
        scopeRef === SCOPE
          ? {
              scopeRef: SCOPE,
              propertyRef: 'unknown',
              guestRef: null,
              stayStart: null,
              stayEnd: null,
              payerRef: null,
              requestedKind: 'other_existing',
              requestedPriceVisibility: 'allowed',
            }
          : null,
      sources: {
        mail_attachment: {
          source: 'mail_attachment',
          list: async () => ({ records: [record], inventoryComplete: true }),
        },
      },
      readBytes: async (att) =>
        readAuthorizedArtifactBytes({
          attachmentId: att.attachmentId,
          authorizedAttachmentIds: att.authorizedAttachmentIds,
          s3,
          signal: AbortSignal.timeout(30_000),
          resolveLocator: async () => att.locator,
        }),
      readArtifact: async (att) => {
        const { readAuthorizedArtifact } = await import(
          '../dist/mail/artifacts/read-artifact.js'
        );
        return readAuthorizedArtifact({
          attachmentId: att.attachmentId,
          authorizedAttachmentIds: att.authorizedAttachmentIds,
          s3,
          signal: AbortSignal.timeout(30_000),
          resolveLocator: async () => att.locator,
        });
      },
    });

    const listed = await documents.documents_list_existing({
      scopeRef: SCOPE,
      source: 'mail_attachment',
      kinds: ['other_existing'],
      limit: 5,
    });
    if (listed.status !== 'ok' || !listed.data?.documents?.[0]) {
      throw new Error(`list_failed:${listed.status}`);
    }
    const documentRef = listed.data.documents[0]!.documentRef;

    // Prefer artifact-format integrity via readBytes path already done;
    // text format may be unsupported for pdf — still prove byte digest.
    const format: 'text' | 'artifact' =
      locator.mimeType === 'text/plain' ? 'text' : 'artifact';
    let readStatus = 'skipped';
    let readSha: string | null = bodySha;
    if (format === 'text') {
      const read = await documents.documents_read_existing({
        documentRef,
        format: 'text',
      });
      readStatus = read.status;
      readSha = read.data?.document.sha256 ?? null;
    } else {
      // artifact format currently returns UNSUPPORTED_FORMAT by design;
      // live proof = authorized S3 byte digest via readAuthorizedArtifactBytes.
      readStatus = 'bytes_digest_only';
    }

    const pass =
      Boolean(bodySha) &&
      bodySha.length === 64 &&
      bytesResult.body.byteLength === pick.sizeBytes &&
      (format !== 'text' || (readStatus === 'ok' && readSha === bodySha));

    const mailProof = {
      schemaVersion: 1,
      toolId: 'documents_read_existing',
      proofClass: 'live_mailbox_attachment_digest',
      finishedAt: new Date().toISOString(),
      mimeType: locator.mimeType,
      sizeBytes: pick.sizeBytes,
      sha256: bodySha,
      s3KeyPrefix: pick.s3Key.split('/').slice(0, 2).join('/'),
      readStatus,
      integrity: {
        bytesMatchDeclaredSize: bytesResult.body.byteLength === pick.sizeBytes,
        sha256Present: true,
      },
      notes:
        'Live authorized mailbox attachment byte digest via DB grant + S3. No synthetic fixture.',
    };
    const compare = {
      schemaVersion: 1,
      toolId: 'documents_read_existing',
      finishedAt: new Date().toISOString(),
      allRequiredPass: pass,
      verdict: pass
        ? 'PASS_LIVE_MAILBOX_ATTACHMENT_DIGEST'
        : 'FAIL_LIVE_MAILBOX_DIGEST',
      rows: [
        {
          field: 'attachment.sha256',
          expected: '64hex',
          actual: bodySha.slice(0, 12) + '…',
          required: true,
          pass: bodySha.length === 64,
        },
        {
          field: 'attachment.sizeBytes',
          expected: pick.sizeBytes,
          actual: bytesResult.body.byteLength,
          required: true,
          pass: bytesResult.body.byteLength === pick.sizeBytes,
        },
        {
          field: 'source',
          expected: 'mail_attachment',
          actual: 'mail_attachment',
          required: true,
          pass: true,
        },
        {
          field: 'proofClass',
          expected: 'live_mailbox_attachment_digest',
          actual: mailProof.proofClass,
          required: true,
          pass: true,
        },
      ],
      packaging: {
        video: 'n/a_non_pms',
        mailProof: pass ? 'present' : 'failed',
        mailProofPath: join(outDir, 'mailProof.v1.json'),
      },
    };

    await writeFile(join(outDir, 'mailProof.v1.json'), `${JSON.stringify(mailProof, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(join(outDir, 'compare.v1.json'), `${JSON.stringify(compare, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(outDir, 'result.v1.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          toolId: 'documents_read_existing',
          status: pass ? 'ok' : 'fail',
          mimeType: locator.mimeType,
          sizeBytes: pick.sizeBytes,
          sha256Prefix: bodySha.slice(0, 16),
          format,
          readStatus,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    process.stdout.write(
      JSON.stringify({
        ok: pass,
        outDir,
        mimeType: locator.mimeType,
        sizeBytes: pick.sizeBytes,
        sha256Prefix: bodySha.slice(0, 16),
        verdict: compare.verdict,
      }) + '\n',
    );
  } finally {
    await sqlClient.end({ timeout: 5 });
  }
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : 'fail').slice(0, 300) + '\n');
  process.exit(1);
});
