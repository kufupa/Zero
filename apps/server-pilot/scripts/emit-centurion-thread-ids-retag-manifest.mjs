/**
 * Emit a bound Centurion retag manifest for an explicit thread-id list
 * (already-tagged quality repair). Model output wins at apply.
 *
 * Usage (EC2, with DATABASE_URL):
 *   node scripts/emit-centurion-thread-ids-retag-manifest.mjs \
 *     --thread-ids id1,id2 --out-snapshot snap.json --out-targets targets.json
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  buildActionableUntaggedRepairArtifacts,
} from './emit-centurion-actionable-untagged-manifest.mjs';
import {
  createPostgresRetagDriver,
  DEFAULT_MODEL_ID,
  DEFAULT_PROMPT_VERSION,
} from './retag-centurion-triage.mjs';
import { writePrivateJson } from './snapshot-centurion-triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let outSnapshot = null;
  let outTargets = null;
  let threadIdsRaw = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out-snapshot') {
      outSnapshot = argv[++i];
      continue;
    }
    if (arg === '--out-targets') {
      outTargets = argv[++i];
      continue;
    }
    if (arg === '--thread-ids') {
      threadIdsRaw = argv[++i];
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!outSnapshot || !outTargets || !threadIdsRaw) {
    throw new Error('require --thread-ids <csv> --out-snapshot <path> --out-targets <path>');
  }
  const threadIds = threadIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (threadIds.length === 0) throw new Error('--thread-ids empty');
  return { outSnapshot, outTargets, threadIds };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function isoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const sql = postgres(databaseUrl, { ssl: sslOptions(), max: 2 });
  try {
    const retagDriver = createPostgresRetagDriver(sql);
    const live = await retagDriver.listThreads({ threadIds: args.threadIds });
    const byId = new Map(live.map((row) => [String(row.threadId), row]));
    for (const id of args.threadIds) {
      if (!byId.has(id)) throw new Error(`thread missing: ${id}`);
    }

    const subjectRows = await sql`
      SELECT id, subject FROM mail_thread WHERE id = ANY(${args.threadIds})
    `;
    const subjectById = new Map(
      subjectRows.map((r) => [String(r.id), r.subject != null ? String(r.subject) : null]),
    );

    const rows = args.threadIds.map((id) => {
      const row = byId.get(id);
      return {
        threadId: id,
        spamAt: row.spamAt != null ? isoOrNull(row.spamAt) : null,
        spamUserLockedAt:
          row.spamUserLockedAt != null ? isoOrNull(row.spamUserLockedAt) : null,
        hasInbound: Boolean(row.hasInbound),
        latestInboundId: row.latestInboundId ? String(row.latestInboundId) : null,
        latestInboundFrom: row.latestInboundFrom ? String(row.latestInboundFrom) : null,
        latestInboundCreatedAt:
          row.latestInboundCreatedAt != null ? isoOrNull(row.latestInboundCreatedAt) : null,
        subject: subjectById.get(id) ?? null,
        aiCategorySlugs: Array.isArray(row.aiCategorySlugs)
          ? row.aiCategorySlugs.map(String)
          : [],
      };
    });

    const promptSource = await fs.promises.readFile(
      path.join(root, 'src/ai/workflows/mail-triage.ts'),
      'utf8',
    );
    const promptHash = createHash('sha256').update(promptSource).digest('hex');

    const artifacts = buildActionableUntaggedRepairArtifacts({
      rows,
      promptHash,
      modelId: DEFAULT_MODEL_ID,
      promptVersion: DEFAULT_PROMPT_VERSION,
      sourceLabel: `quality-thread-ids-${args.threadIds.length}`,
      skipActionableFilter: true,
    });

    writePrivateJson(args.outSnapshot, artifacts.snapshot);
    writePrivateJson(args.outTargets, artifacts.manifest);
    console.log(
      JSON.stringify({
        ok: true,
        targetCount: artifacts.manifest.targets.length,
        outSnapshot: args.outSnapshot,
        outTargets: args.outTargets,
      }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
