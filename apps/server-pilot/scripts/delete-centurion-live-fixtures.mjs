#!/usr/bin/env node
/**
 * Delete re-ingested centurion-live fixture copies from transport-centurion.
 *
 * Match key: message_id_header / thread_root_id from
 * tests/fixtures/centurion-live/*.eml (angles stripped on ingest).
 *
 * Default: dry-run (report only). No DB writes.
 *
 * Execute (destructive):
 *   CONFIRM_DELETE_CENTURION_FIXTURES=1 node scripts/delete-centurion-live-fixtures.mjs --execute
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const TRANSPORT_ID = 'transport-centurion';

/** Message-IDs from tests/fixtures/centurion-live/*.eml (stripAngles form). */
const FIXTURE_MESSAGE_IDS = [
  'live-group-overflow@example.com',
  'live-hotel-sent-reply@example.com',
  'live-individual-municipality@example.com',
  'live-individual-quotation@example.com',
  'live-individual-urgent-invoice@example.com',
  'live-internal-handover@example.com',
  'live-spam-viqal@example.com',
  'live-travel-agents-quote@example.com',
  'live-travel-agents-four@example.com',
];

const FIXTURE_SUBJECTS = [
  'Handover: VIP arrivals Thursday',
  'Urgent Tax invoice',
  'Request for a quotation',
  'Maple Estate Overflow Rooms 23 July',
  'RE 4 ROOMS CHECK IN THE 09 JUL AND OUT THE 10 JUL',
  'booking',
  'Video inside: Virtual Hotel Concierge',
  'Re: Booking confirmation HRCEN-50140001',
  'REQUEST FOR QUOTATION',
];

function parseArgs(argv) {
  return {
    execute: argv.includes('--execute'),
    json: argv.includes('--json'),
  };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function assertExecuteAllowed(flags) {
  if (!flags.execute) return;
  if (process.env.CONFIRM_DELETE_CENTURION_FIXTURES !== '1') {
    console.error(
      'refusing --execute: set CONFIRM_DELETE_CENTURION_FIXTURES=1',
    );
    process.exit(1);
  }
}

const flags = parseArgs(process.argv.slice(2));
assertExecuteAllowed(flags);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });

try {
  const messages = await sql`
    SELECT
      m.id,
      m.thread_id,
      m.direction,
      m.subject,
      m.from_address,
      m.message_id_header,
      m.pop3_uidl,
      m.raw_mime_s3_key,
      m.received_at,
      m.sent_at,
      m.created_at
    FROM message m
    WHERE m.transport_id = ${TRANSPORT_ID}
      AND m.message_id_header = ANY(${FIXTURE_MESSAGE_IDS})
    ORDER BY m.message_id_header, m.created_at, m.id
  `;

  const threadsByRoot = await sql`
    SELECT
      t.id,
      t.thread_root_id,
      t.subject,
      t.latest_message_at,
      (
        SELECT count(*)::int FROM message m WHERE m.thread_id = t.id
      ) AS message_count,
      (
        SELECT count(*)::int
        FROM message m
        WHERE m.thread_id = t.id
          AND (
            m.message_id_header IS NULL
            OR NOT (m.message_id_header = ANY(${FIXTURE_MESSAGE_IDS}))
          )
      ) AS non_fixture_message_count
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.thread_root_id = ANY(${FIXTURE_MESSAGE_IDS})
    ORDER BY t.thread_root_id
  `;

  const mixedThreads = threadsByRoot.filter((t) => t.non_fixture_message_count > 0);
  if (mixedThreads.length > 0) {
    console.error(
      JSON.stringify(
        {
          error: 'mixed_threads_refuse',
          detail:
            'fixture thread_root_id threads also contain non-fixture messages; refuse delete',
          mixedThreads,
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  // Orphan fixture messages sitting on threads whose root is NOT a fixture id
  // (should be empty; refuse if present so we do not leave half-deleted threads).
  const messageThreadIds = [...new Set(messages.map((m) => m.thread_id))];
  const rootThreadIds = new Set(threadsByRoot.map((t) => t.id));
  const orphanMsgThreads = messageThreadIds.filter((id) => !rootThreadIds.has(id));
  if (orphanMsgThreads.length > 0) {
    const sample = messages.filter((m) => orphanMsgThreads.includes(m.thread_id)).slice(0, 20);
    console.error(
      JSON.stringify(
        {
          error: 'fixture_messages_outside_fixture_root_threads',
          detail:
            'messages match fixture Message-IDs but their threads do not; refuse delete',
          orphanThreadIds: orphanMsgThreads,
          sample,
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const byHeader = {};
  for (const id of FIXTURE_MESSAGE_IDS) byHeader[id] = 0;
  for (const m of messages) {
    byHeader[m.message_id_header] = (byHeader[m.message_id_header] ?? 0) + 1;
  }

  const s3Keys = [
    ...new Set(
      messages.map((m) => m.raw_mime_s3_key).filter((k) => typeof k === 'string' && k.length > 0),
    ),
  ];

  const plan = {
    mode: flags.execute ? 'execute' : 'dry-run',
    transportId: TRANSPORT_ID,
    fixtureMessageIds: FIXTURE_MESSAGE_IDS,
    fixtureSubjects: FIXTURE_SUBJECTS,
    messageCount: messages.length,
    threadCount: threadsByRoot.length,
    byMessageIdHeader: byHeader,
    threads: threadsByRoot.map((t) => ({
      id: t.id,
      threadRootId: t.thread_root_id,
      subject: t.subject,
      messageCount: t.message_count,
    })),
    rawMimeS3KeyCount: s3Keys.length,
    note: 'S3 objects (raw MIME / attachments) are NOT deleted; DB cascade only.',
  };

  if (!flags.execute) {
    if (flags.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log('delete-centurion-live-fixtures: DRY-RUN (no writes)');
      console.log(`  transport: ${TRANSPORT_ID}`);
      console.log(`  would delete messages: ${plan.messageCount}`);
      console.log(`  would delete threads:  ${plan.threadCount}`);
      console.log('  by Message-ID:');
      for (const [mid, n] of Object.entries(byHeader)) {
        console.log(`    ${n.toString().padStart(4)}  ${mid}`);
      }
      console.log('  threads:');
      for (const t of plan.threads) {
        console.log(`    ${t.messageCount.toString().padStart(4)} msgs  ${t.threadRootId}  ${t.subject ?? ''}`);
      }
      console.log(`  raw_mime_s3_key rows (orphan after delete): ${s3Keys.length}`);
      console.log('');
      console.log('To execute:');
      console.log(
        '  CONFIRM_DELETE_CENTURION_FIXTURES=1 node scripts/delete-centurion-live-fixtures.mjs --execute',
      );
    }
    process.exit(0);
  }

  // Delete threads → CASCADE messages → CASCADE attachments / ai_workflow_run.
  const deletedThreads = await sql`
    DELETE FROM mail_thread
    WHERE transport_id = ${TRANSPORT_ID}
      AND thread_root_id = ANY(${FIXTURE_MESSAGE_IDS})
    RETURNING id, thread_root_id, subject
  `;

  // Belt-and-suspenders: any leftover fixture messages (should be 0).
  const leftover = await sql`
    DELETE FROM message
    WHERE transport_id = ${TRANSPORT_ID}
      AND message_id_header = ANY(${FIXTURE_MESSAGE_IDS})
    RETURNING id
  `;

  const remaining = await sql`
    SELECT count(*)::int AS n
    FROM message
    WHERE transport_id = ${TRANSPORT_ID}
      AND message_id_header = ANY(${FIXTURE_MESSAGE_IDS})
  `;

  const result = {
    ...plan,
    deletedThreadCount: deletedThreads.length,
    leftoverMessageDeletes: leftover.length,
    remainingFixtureMessages: remaining[0]?.n ?? -1,
    deletedThreads: deletedThreads.map((t) => ({
      id: t.id,
      threadRootId: t.thread_root_id,
      subject: t.subject,
    })),
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('delete-centurion-live-fixtures: EXECUTE complete');
    console.log(`  deleted threads:  ${result.deletedThreadCount}`);
    console.log(`  leftover msgs:    ${result.leftoverMessageDeletes}`);
    console.log(`  remaining match:  ${result.remainingFixtureMessages}`);
  }

  if ((remaining[0]?.n ?? 1) !== 0) {
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
}
