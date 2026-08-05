#!/usr/bin/env node
/**
 * Delete S3 raw-mime objects whose Message-ID matches centurion-live fixtures.
 *
 * Why: DB rows already deleted; S3 blobs remain. Leaving them risks
 * `rehydrate-raw-mime` restoring fixture mail into the inbox.
 *
 * Default: dry-run. Execute:
 *   CONFIRM_DELETE_CENTURION_FIXTURE_S3=1 node scripts/delete-centurion-live-fixture-s3.mjs --execute
 *
 * Env: S3_BUCKET, AWS_REGION (default af-south-1)
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const FIXTURE_MESSAGE_IDS = new Set([
  'live-group-overflow@example.com',
  'live-hotel-sent-reply@example.com',
  'live-individual-municipality@example.com',
  'live-individual-quotation@example.com',
  'live-individual-urgent-invoice@example.com',
  'live-internal-handover@example.com',
  'live-spam-viqal@example.com',
  'live-travel-agents-quote@example.com',
  'live-travel-agents-four@example.com',
]);

const PREFIX = process.env.RAW_MIME_PREFIX || 'raw-mime/ingest-nava-legacy/';

function parseArgs(argv) {
  return {
    execute: argv.includes('--execute'),
    json: argv.includes('--json'),
  };
}

function stripAngles(raw) {
  return raw.replace(/^<+|>+$/g, '').trim();
}

function messageIdFromHead(text) {
  const m = text.match(/^Message-ID:\s*(.+)$/im);
  if (!m) return null;
  return stripAngles(m[1].trim());
}

async function listKeys(client, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const o of out.Contents || []) {
      if (o.Key) keys.push(o.Key);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function classifyKey(client, bucket, key) {
  const obj = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: 'bytes=0-8191',
    }),
  );
  const body = await obj.Body.transformToString('utf8');
  const mid = messageIdFromHead(body);
  return { key, messageId: mid, isFixture: mid != null && FIXTURE_MESSAGE_IDS.has(mid) };
}

async function deleteInBatches(client, bucket, keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const out = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    deleted += chunk.length - (out.Errors?.length ?? 0);
    if (out.Errors?.length) {
      console.error(JSON.stringify({ deleteErrors: out.Errors.slice(0, 20) }, null, 2));
    }
  }
  return deleted;
}

const flags = parseArgs(process.argv.slice(2));
if (flags.execute && process.env.CONFIRM_DELETE_CENTURION_FIXTURE_S3 !== '1') {
  console.error('refusing --execute: set CONFIRM_DELETE_CENTURION_FIXTURE_S3=1');
  process.exit(1);
}

const bucket = process.env.S3_BUCKET;
const region = process.env.AWS_REGION || 'af-south-1';
if (!bucket) {
  console.error('S3_BUCKET required');
  process.exit(1);
}

const client = new S3Client({ region });
const keys = await listKeys(client, bucket, PREFIX);
const byId = Object.fromEntries([...FIXTURE_MESSAGE_IDS].map((id) => [id, 0]));
const fixtureKeys = [];
let other = 0;
let noMessageId = 0;
let errors = 0;

for (const key of keys) {
  try {
    const row = await classifyKey(client, bucket, key);
    if (row.isFixture) {
      fixtureKeys.push(row.key);
      byId[row.messageId] += 1;
    } else if (!row.messageId) {
      noMessageId += 1;
    } else {
      other += 1;
    }
  } catch (err) {
    errors += 1;
    console.error(`classify fail ${key}: ${err instanceof Error ? err.message : err}`);
  }
}

const plan = {
  mode: flags.execute ? 'execute' : 'dry-run',
  bucket,
  prefix: PREFIX,
  listed: keys.length,
  fixtureObjectCount: fixtureKeys.length,
  otherObjectCount: other,
  noMessageIdCount: noMessageId,
  classifyErrors: errors,
  byMessageId: byId,
  note: 'Only deletes objects whose Message-ID matches centurion-live fixtures. Live mail objects kept.',
};

if (!flags.execute) {
  if (flags.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log('delete-centurion-live-fixture-s3: DRY-RUN');
    console.log(`  bucket: ${bucket}`);
    console.log(`  listed: ${keys.length}`);
    console.log(`  fixture hits: ${fixtureKeys.length}`);
    console.log(`  other (kept): ${other}`);
    for (const [id, n] of Object.entries(byId)) {
      console.log(`    ${String(n).padStart(4)}  ${id}`);
    }
    console.log(
      'To execute: CONFIRM_DELETE_CENTURION_FIXTURE_S3=1 node scripts/delete-centurion-live-fixture-s3.mjs --execute',
    );
  }
  process.exit(errors > 0 ? 1 : 0);
}

const deleted = await deleteInBatches(client, bucket, fixtureKeys);
const result = { ...plan, deleted };
if (flags.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log('delete-centurion-live-fixture-s3: EXECUTE complete');
  console.log(`  deleted: ${deleted} / ${fixtureKeys.length}`);
}
if (deleted !== fixtureKeys.length) process.exitCode = 1;
