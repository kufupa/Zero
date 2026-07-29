#!/usr/bin/env node
/**
 * Centurion triage retag: unsettle AI-managed categories + spam_at, re-enqueue inbound_triage (triage-v4).
 *
 * Default: dry-run (counts only). Mutate with --apply.
 *
 * Usage:
 *   node scripts/retag-centurion-triage.mjs
 *   node scripts/retag-centurion-triage.mjs --apply
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const TRANSPORT_ID = 'transport-centurion';
const MODEL_ID = 'amazon.nova-lite-v1:0';
const PROMPT_VERSION = 'triage-v4';
const AI_MANAGED_SLUGS = [
  'new-bookings',
  'groups-events',
  'at-risk',
  'ops',
  'urgent',
];

// Legacy invent-WHO slugs — unsettle-only during retag (clear stale joins before triage-v4).
const LEGACY_INVENT_WHO_SLUGS = [
  'internal',
  'individual',
  'group',
  'travel-agents',
];

const RETAG_UNSETTLE_SLUGS = [...AI_MANAGED_SLUGS, ...LEGACY_INVENT_WHO_SLUGS];

function parseArgs(argv) {
  return {
    dryRun: !argv.includes('--apply'),
  };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function retagIdempotencyKey(messageId) {
  return `inbound-triage-retag-v4:${messageId}`;
}

const { dryRun } = parseArgs(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });

const counts = {
  scanned: 0,
  skipped_locked: 0,
  unsettled: 0,
  enqueued: 0,
};

try {
  const aiManagedCategoryIds = (
    await sql`
      SELECT id
      FROM mail_category
      WHERE transport_id = ${TRANSPORT_ID}
        AND slug = ANY(${RETAG_UNSETTLE_SLUGS})
    `
  ).map((row) => row.id);

  const threads = await sql`
    SELECT
      t.id AS thread_id,
      t.spam_user_locked_at,
      (
        SELECT m.id
        FROM message m
        WHERE m.thread_id = t.id
          AND m.direction = 'inbound'
        ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
        LIMIT 1
      ) AS latest_inbound_id
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND EXISTS (
        SELECT 1
        FROM message m2
        WHERE m2.thread_id = t.id
          AND m2.direction = 'inbound'
      )
    ORDER BY t.id
  `;

  counts.scanned = threads.length;

  for (const row of threads) {
    if (row.spam_user_locked_at) {
      counts.skipped_locked += 1;
      console.error(`skip locked thread_id=${row.thread_id}`);
      continue;
    }

    if (!row.latest_inbound_id) {
      console.error(`skip no inbound thread_id=${row.thread_id}`);
      continue;
    }

    const idempotencyKey = retagIdempotencyKey(row.latest_inbound_id);

    if (dryRun) {
      counts.unsettled += 1;
      counts.enqueued += 1;
      continue;
    }

    await sql.begin(async (tx) => {
      if (aiManagedCategoryIds.length > 0) {
        await tx`
          DELETE FROM mail_thread_category mtc
          WHERE mtc.thread_id = ${row.thread_id}
            AND mtc.transport_id = ${TRANSPORT_ID}
            AND mtc.category_id = ANY(${aiManagedCategoryIds})
        `;
      }

      await tx`
        UPDATE mail_thread
        SET spam_at = NULL, updated_at = now()
        WHERE id = ${row.thread_id}
          AND transport_id = ${TRANSPORT_ID}
      `;

      const now = new Date();
      await tx`
        INSERT INTO ai_workflow_run (
          id,
          transport_id,
          thread_id,
          trigger_message_id,
          run_kind,
          idempotency_key,
          model_id,
          prompt_version,
          state,
          created_at,
          updated_at
        )
        VALUES (
          ${randomUUID()},
          ${TRANSPORT_ID},
          ${row.thread_id},
          ${row.latest_inbound_id},
          'inbound_triage',
          ${idempotencyKey},
          ${MODEL_ID},
          ${PROMPT_VERSION},
          'queued',
          ${now},
          ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;

      counts.unsettled += 1;
      counts.enqueued += 1;
    });
  }

  console.log(
    JSON.stringify({
      mode: dryRun ? 'dry-run' : 'apply',
      transportId: TRANSPORT_ID,
      promptVersion: PROMPT_VERSION,
      ...counts,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
