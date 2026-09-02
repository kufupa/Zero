/**
 * Restore Centurion AI-managed triage state from a cutover snapshot.
 *
 * Restores only v6 retag-managed legacy/workflow/invent-WHO category joins
 * + thread spam/lock fields.
 * Preserves custom categories and sender preferences.
 *
 * Note: no shebang — Windows CRLF + shebang breaks Vitest/Vite transform.
 * Invoke via `node scripts/restore-centurion-triage-snapshot.mjs`.
 *
 * Default: dry-run. Mutate with --apply.
 *
 * Usage:
 *   node scripts/restore-centurion-triage-snapshot.mjs --snapshot snap.json
 *   node scripts/restore-centurion-triage-snapshot.mjs --snapshot snap.json --apply
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RETAG_UNSETTLE_SLUGS,
  TRANSPORT_ID,
} from './retag-centurion-triage.mjs';
import {
  assertValidSnapshot,
  assertRestoreSnapshotDrift,
  buildCenturionTriageSnapshot,
  createPostgresSnapshotDriver,
  verifySnapshotAgainstLive,
} from './snapshot-centurion-triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function parseRestoreArgs(argv) {
  let snapshotPath = null;
  let dryRun = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      dryRun = false;
      continue;
    }
    if (arg === '--snapshot') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--snapshot requires a path');
      }
      snapshotPath = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (!snapshotPath) {
    throw new Error('--snapshot <snapshot.json> required');
  }

  return { snapshotPath, dryRun };
}

function allSnapshotRows(snapshot) {
  const cohorts = snapshot.cohorts;
  return [
    ...(cohorts.eligible ?? []),
    ...(cohorts.locked ?? []),
    ...(cohorts.blocked ?? []),
    ...(cohorts.allowed ?? []),
    ...(cohorts.outboundOnly ?? []),
  ];
}

/**
 * @param {{
 *   driver: {
 *     restoreAiManagedStateBatch: (rows: Array<{
 *       threadId: string,
 *       spamAt: string|null,
 *       spamUserLockedAt: string|null,
 *       aiCategorySlugs: string[],
 *     }>, snapshot: object) => Promise<void>,
 *     listThreads: () => Promise<any[]>,
 *     listSenderPreferences: (emails: string[]) => Promise<Map<string, 'block'|'allow'>>,
 *   },
 *   snapshot: object,
 *   dryRun: boolean,
 * }} opts
 */
export async function restoreCenturionTriageSnapshot(opts) {
  const snapshot = assertValidSnapshot(opts.snapshot);
  const rows = allSnapshotRows(snapshot);

  if (opts.dryRun) {
    return {
      mode: 'dry-run',
      wouldRestore: rows.length,
      snapshotHash: snapshot.snapshotHash,
    };
  }

  if (typeof opts.driver.restoreAiManagedStateBatch !== 'function') {
    throw new Error('restore driver must support atomic restoreAiManagedStateBatch');
  }
  await opts.driver.restoreAiManagedStateBatch(
    rows.map((row) => ({
      threadId: row.threadId,
      spamAt: row.spamAt ?? null,
      spamUserLockedAt: row.spamUserLockedAt ?? null,
      aiCategorySlugs: [...(row.aiCategorySlugs ?? [])],
    })),
    snapshot,
  );

  await verifySnapshotAgainstLive({ driver: opts.driver, snapshot });

  return {
    mode: 'apply',
    restored: rows.length,
    snapshotHash: snapshot.snapshotHash,
  };
}

export function createPostgresRestoreDriver(sql) {
  const snapshotDriver = createPostgresSnapshotDriver(sql);
  return {
    ...snapshotDriver,

    async restoreAiManagedStateBatch(rows, snapshotInput) {
      await sql.begin(async (tx) => {
        const snapshot = assertValidSnapshot(snapshotInput);
        const threadIds = rows.map((row) => row.threadId);
        if (new Set(threadIds).size !== threadIds.length) {
          throw new Error('duplicate snapshot thread in restore batch');
        }

        // Lock every boundary used by the drift contract in this same
        // transaction. No newer trigger, sender preference, lock, or custom
        // category state may slip between validation and restore mutation.
        for (const threadId of threadIds) {
          await tx`
            SELECT id
            FROM message
            WHERE thread_id = ${threadId}
              AND direction = 'inbound'
            FOR SHARE
          `;
        }
        const txSnapshotDriver = createPostgresSnapshotDriver(tx);
        const live = await buildCenturionTriageSnapshot({
          driver: {
            listThreads: () =>
              txSnapshotDriver.listThreads({ threadIds, forUpdate: true }),
            listSenderPreferences: (emails) =>
              txSnapshotDriver.listSenderPreferences(emails, { forUpdate: true }),
          },
          generatedAt: snapshot.generatedAt,
        });
        assertRestoreSnapshotDrift(snapshot, live);

        const categoryRows = await tx`
          SELECT id, slug
          FROM mail_category
          WHERE transport_id = ${TRANSPORT_ID}
            AND slug = ANY(${RETAG_UNSETTLE_SLUGS})
        `;
        const idBySlug = new Map(categoryRows.map((r) => [r.slug, r.id]));
        const allRetagManagedIds = categoryRows.map((r) => r.id);

        const existingThreads = await tx`
          SELECT id
          FROM mail_thread
          WHERE transport_id = ${TRANSPORT_ID}
            AND id = ANY(${threadIds})
        `;
        if (existingThreads.length !== new Set(threadIds).size) {
          throw new Error('one or more snapshot threads missing for restore');
        }
        for (const row of rows) {
          for (const slug of row.aiCategorySlugs ?? []) {
            if (!idBySlug.has(slug)) {
              throw new Error(`AI-managed category missing for restore: ${slug}`);
            }
          }
        }

        for (const row of rows) {
          if (allRetagManagedIds.length > 0) {
            await tx`
              DELETE FROM mail_thread_category
              WHERE thread_id = ${row.threadId}
                AND transport_id = ${TRANSPORT_ID}
                AND category_id = ANY(${allRetagManagedIds})
            `;
          }
          for (const slug of row.aiCategorySlugs ?? []) {
            const categoryId = idBySlug.get(slug);
            await tx`
              INSERT INTO mail_thread_category (thread_id, transport_id, category_id)
              VALUES (${row.threadId}, ${TRANSPORT_ID}, ${categoryId})
              ON CONFLICT DO NOTHING
            `;
          }

          await tx`
            UPDATE mail_thread
            SET
              spam_at = ${row.spamAt},
              spam_user_locked_at = ${row.spamUserLockedAt},
              updated_at = now()
            WHERE id = ${row.threadId}
              AND transport_id = ${TRANSPORT_ID}
          `;
        }
      });
    },
  };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function isMain() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
}

async function main() {
  const args = parseRestoreArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(args.snapshotPath, 'utf8'));
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });
  try {
    const summary = await restoreCenturionTriageSnapshot({
      driver: createPostgresRestoreDriver(sql),
      snapshot,
      dryRun: args.dryRun,
    });
    console.log(JSON.stringify(summary));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
