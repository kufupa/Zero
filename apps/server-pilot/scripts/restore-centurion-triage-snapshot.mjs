/**
 * Restore Centurion AI-managed triage state from a cutover snapshot.
 *
 * Restores only v6 AI-managed legacy/workflow category joins + thread spam/lock fields.
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
  AI_MANAGED_SLUGS,
  TRANSPORT_ID,
} from './retag-centurion-triage.mjs';
import {
  assertValidSnapshot,
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
 *     restoreAiManagedState: (row: {
 *       threadId: string,
 *       spamAt: string|null,
 *       spamUserLockedAt: string|null,
 *       aiCategorySlugs: string[],
 *     }) => Promise<void>,
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

  for (const row of rows) {
    await opts.driver.restoreAiManagedState({
      threadId: row.threadId,
      spamAt: row.spamAt ?? null,
      spamUserLockedAt: row.spamUserLockedAt ?? null,
      aiCategorySlugs: [...(row.aiCategorySlugs ?? [])],
    });
  }

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

    async restoreAiManagedState(row) {
      await sql.begin(async (tx) => {
        const categoryRows = await tx`
          SELECT id, slug
          FROM mail_category
          WHERE transport_id = ${TRANSPORT_ID}
            AND slug = ANY(${AI_MANAGED_SLUGS})
        `;
        const idBySlug = new Map(categoryRows.map((r) => [r.slug, r.id]));
        const allAiIds = categoryRows.map((r) => r.id);

        if (allAiIds.length > 0) {
          await tx`
            DELETE FROM mail_thread_category
            WHERE thread_id = ${row.threadId}
              AND transport_id = ${TRANSPORT_ID}
              AND category_id = ANY(${allAiIds})
          `;
        }

        for (const slug of row.aiCategorySlugs ?? []) {
          const categoryId = idBySlug.get(slug);
          if (!categoryId) {
            throw new Error(`AI-managed category missing for restore: ${slug}`);
          }
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
