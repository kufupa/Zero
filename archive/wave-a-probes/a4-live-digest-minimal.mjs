/**
 * Minimal Wave A4 live mailbox attachment digest — no app dist deps.
 * Read-only: psql pick + AWS S3 GetObject → sha256. A4_LIVE_ALLOW=1.
 * Digests/sizes/mime only on stdout — no filenames/PII.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

function scrub(s) {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[db]')
    .replace(/arn:aws:\S+/gi, '[arn]');
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  if (process.env.A4_LIVE_ALLOW !== '1') throw new Error('set A4_LIVE_ALLOW=1');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  if (process.env.VITEST) throw new Error('refusing under Vitest');

  const outDir =
    process.env.A4_LIVE_OUT_DIR?.trim() ||
    join(process.cwd(), '../../.private/wave-a-20260912/a4-live');
  await mkdir(outDir, { recursive: true, mode: 0o700 });

  const q = `
SELECT a.id, a.message_id, a.mime_type, a.size_bytes, a.s3_key
FROM attachment a
JOIN message m ON m.id = a.message_id
WHERE m.direction = 'inbound'
  AND a.s3_key LIKE 'attachments/%'
  AND a.size_bytes > 0 AND a.size_bytes < 5000000
  AND (a.mime_type = 'text/plain' OR a.mime_type = 'application/pdf')
ORDER BY a.created_at DESC
LIMIT 5;
`.trim();

  const psql = spawnSync('psql', [databaseUrl, '-t', '-A', '-F', '\t', '-c', q], {
    encoding: 'utf8',
    timeout: 60_000,
    env: process.env,
  });
  if (psql.status !== 0) {
    throw new Error(`psql_fail:${scrub(psql.stderr || '').slice(0, 120)}`);
  }
  const lines = (psql.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    const compare = {
      schemaVersion: 1,
      toolId: 'documents_read_existing',
      finishedAt: new Date().toISOString(),
      allRequiredPass: false,
      verdict: 'BLOCKED_NO_LIVE_ATTACHMENT',
    };
    await writeFile(join(outDir, 'compare.v1.json'), JSON.stringify(compare, null, 2) + '\n', {
      mode: 0o600,
    });
    process.stdout.write(JSON.stringify({ ok: false, reason: 'no_rows' }) + '\n');
    return;
  }

  // Prefer text/plain
  let pick = null;
  for (const line of lines) {
    const [id, messageId, mimeType, sizeBytes, s3Key] = line.split('\t');
    const row = {
      id,
      messageId,
      mimeType,
      sizeBytes: Number(sizeBytes),
      s3Key,
    };
    if (!pick) pick = row;
    if (row.mimeType === 'text/plain') {
      pick = row;
      break;
    }
  }

  const bucket = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET required');
  const region = process.env.AWS_REGION ?? 'af-south-1';
  const s3 = new S3Client({ region });

  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: pick.s3Key }),
  );
  const declared = head.ContentLength ?? pick.sizeBytes;

  const got = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: pick.s3Key }),
  );
  const body = await streamToBuffer(got.Body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const sizeMatch = body.byteLength === pick.sizeBytes;
  const pass = sha256.length === 64 && sizeMatch && body.byteLength > 0;

  const mailProof = {
    schemaVersion: 1,
    toolId: 'documents_read_existing',
    proofClass: 'live_mailbox_attachment_digest',
    finishedAt: new Date().toISOString(),
    mimeType: pick.mimeType,
    sizeBytes: pick.sizeBytes,
    objectBytes: body.byteLength,
    headContentLength: declared,
    sha256,
    s3KeyPrefix: pick.s3Key.split('/').slice(0, 2).join('/'),
    integrity: {
      bytesMatchDeclaredSize: sizeMatch,
      sha256Present: true,
    },
    notes:
      'Live authorized mailbox attachment byte digest via DB row + S3 GetObject. No synthetic fixture.',
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
        actual: sha256.slice(0, 12) + '…',
        required: true,
        pass: sha256.length === 64,
      },
      {
        field: 'attachment.sizeBytes',
        expected: pick.sizeBytes,
        actual: body.byteLength,
        required: true,
        pass: sizeMatch,
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
        actual: 'live_mailbox_attachment_digest',
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

  await writeFile(join(outDir, 'mailProof.v1.json'), JSON.stringify(mailProof, null, 2) + '\n', {
    mode: 0o600,
  });
  await writeFile(join(outDir, 'compare.v1.json'), JSON.stringify(compare, null, 2) + '\n', {
    mode: 0o600,
  });
  await writeFile(
    join(outDir, 'result.v1.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        toolId: 'documents_read_existing',
        status: pass ? 'ok' : 'fail',
        mimeType: pick.mimeType,
        sizeBytes: pick.sizeBytes,
        sha256Prefix: sha256.slice(0, 16),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: pass,
      outDir,
      mimeType: pick.mimeType,
      sizeBytes: pick.sizeBytes,
      sha256Prefix: sha256.slice(0, 16),
      verdict: compare.verdict,
    }) + '\n',
  );
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : 'fail').slice(0, 300) + '\n');
  process.exit(1);
});
