#!/usr/bin/env node
/**
 * Mark threads read when latest message is outbound (shared-inbox ball-in-court backfill).
 *
 * Dry-run (default):
 *   node --env-file=... scripts/backfill-outbound-latest-read.mjs --transport=transport-centurion
 *
 * Apply (non-pilot):
 *   node --env-file=... scripts/backfill-outbound-latest-read.mjs --transport=transport-centurion --apply
 *
 * Pilot RDS apply requires explicit operator confirm (never for Vitest):
 *   ... --transport=transport-centurion --apply --confirm-pilot-rds
 *
 * Prints counts only — no subjects, addresses, or bodies.
 */
import postgres from 'postgres';

function parseArgs(argv) {
  let transportId = null;
  let apply = false;
  let confirmPilotRds = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--confirm-pilot-rds') confirmPilotRds = true;
    else if (arg.startsWith('--transport=')) transportId = arg.slice('--transport='.length);
  }
  return { transportId, apply, confirmPilotRds };
}

function refusePilotUrl(url, { apply, confirmPilotRds }) {
  if (!url) throw new Error('DATABASE_URL required');
  if (!url.includes('nava-zero-mail-pilot')) return;
  if (apply && !confirmPilotRds) {
    throw new Error(
      'REFUSE: pilot RDS apply needs --confirm-pilot-rds (operator-only; not for Vitest).',
    );
  }
  if (!apply && !confirmPilotRds) {
    throw new Error(
      'REFUSE: pilot RDS dry-run also needs --confirm-pilot-rds so counts are intentional.',
    );
  }
}

async function main() {
  const { transportId, apply, confirmPilotRds } = parseArgs(process.argv.slice(2));
  if (!transportId) {
    console.error(
      'Usage: backfill-outbound-latest-read.mjs --transport=<id> [--apply] [--confirm-pilot-rds]',
    );
    process.exit(2);
  }

  const url = process.env.DATABASE_URL?.trim();
  refusePilotUrl(url, { apply, confirmPilotRds });

  const sslmode = (() => {
    try {
      return new URL(url).searchParams.get('sslmode');
    } catch {
      return null;
    }
  })();
  const ssl =
    sslmode === 'disable' || sslmode === 'allow' || sslmode === 'prefer'
      ? false
      : { rejectUnauthorized: false };

  const sql = postgres(url, { max: 1, ssl, connect_timeout: 15 });

  try {
    const candidates = await sql`
      WITH latest AS (
        SELECT DISTINCT ON (m.thread_id)
          m.thread_id,
          m.direction
        FROM message m
        WHERE m.transport_id = ${transportId}
        ORDER BY
          m.thread_id,
          COALESCE(m.received_at, m.sent_at, m.created_at) DESC,
          m.created_at DESC,
          m.id DESC
      )
      SELECT l.thread_id
      FROM latest l
      INNER JOIN mail_thread t
        ON t.id = l.thread_id AND t.transport_id = ${transportId}
      WHERE l.direction = 'outbound'
        AND (
          t.is_read = false
          OR EXISTS (
            SELECT 1 FROM message m2
            WHERE m2.thread_id = l.thread_id
              AND m2.transport_id = ${transportId}
              AND m2.is_read = false
          )
        )
    `;

    const threadIds = candidates.map((r) => r.thread_id);
    console.log(
      JSON.stringify({
        transportId,
        mode: apply ? 'apply' : 'dry-run',
        candidateThreads: threadIds.length,
      }),
    );

    if (!apply || threadIds.length === 0) {
      return;
    }

    await sql.begin(async (tx) => {
      await tx`
        UPDATE mail_thread
        SET is_read = true, updated_at = now()
        WHERE transport_id = ${transportId}
          AND id = ANY(${threadIds})
      `;
      await tx`
        UPDATE message
        SET is_read = true, updated_at = now()
        WHERE transport_id = ${transportId}
          AND thread_id = ANY(${threadIds})
      `;
    });

    console.log(JSON.stringify({ transportId, updatedThreads: threadIds.length }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
