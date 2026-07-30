/**
 * Supersede Centurion nonterminal inbound_triage + candidate_draft AI runs.
 *
 * Note: no shebang — Windows CRLF + shebang breaks Vitest/Vite transform.
 * Invoke via `node scripts/supersede-centurion-ai-runs.mjs`.
 *
 * Default: dry-run. Mutate with --apply.
 *
 * Usage:
 *   node scripts/supersede-centurion-ai-runs.mjs
 *   node scripts/supersede-centurion-ai-runs.mjs --apply
 *   node scripts/supersede-centurion-ai-runs.mjs --apply --reason "cutover-v5"
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const TRANSPORT_ID = 'transport-centurion';
export const SUPERSEDE_RUN_KINDS = ['inbound_triage', 'candidate_draft'];
export const SUPERSEDE_STATES = ['queued', 'claimed', 'running', 'retry_wait'];
export const DEFAULT_REASON = 'superseded for triage cutover';

/**
 * @param {string[]} argv
 */
export function parseSupersedeArgs(argv) {
  let dryRun = true;
  let reason = DEFAULT_REASON;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      dryRun = false;
      continue;
    }
    if (arg === '--reason') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--reason requires a value');
      }
      reason = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { dryRun, reason };
}

/**
 * @param {Array<{
 *   id: string,
 *   transportId: string,
 *   runKind: string,
 *   state: string,
 *   promptVersion?: string,
 * }>} rows
 */
export function selectSupersedeTargets(rows) {
  return rows.filter(
    (row) =>
      row.transportId === TRANSPORT_ID &&
      SUPERSEDE_RUN_KINDS.includes(row.runKind) &&
      SUPERSEDE_STATES.includes(row.state),
  );
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

/**
 * @param {import('postgres').Sql} sql
 */
export function createPostgresSupersedeDriver(sql) {
  return {
    async listCandidates() {
      return sql`
        SELECT
          id,
          transport_id AS "transportId",
          run_kind AS "runKind",
          state,
          prompt_version AS "promptVersion",
          claim_owner AS "claimOwner"
        FROM ai_workflow_run
        WHERE transport_id = ${TRANSPORT_ID}
          AND run_kind = ANY(${SUPERSEDE_RUN_KINDS})
          AND state = ANY(${SUPERSEDE_STATES})
        ORDER BY created_at ASC
      `;
    },
    /**
     * @param {{ ids: string[], reason: string, now: Date }} input
     */
    async supersede(input) {
      if (input.ids.length === 0) return 0;
      const metricsPatch = JSON.stringify({
        supersededAt: input.now.toISOString(),
        supersededReason: input.reason,
      });
      const rows = await sql`
        UPDATE ai_workflow_run
        SET
          state = 'superseded',
          claim_owner = NULL,
          last_error = ${input.reason},
          finished_at = ${input.now},
          updated_at = ${input.now},
          metrics = COALESCE(metrics, '{}'::jsonb) || ${metricsPatch}::jsonb
        WHERE id = ANY(${input.ids})
          AND transport_id = ${TRANSPORT_ID}
          AND run_kind = ANY(${SUPERSEDE_RUN_KINDS})
          AND state = ANY(${SUPERSEDE_STATES})
        RETURNING id
      `;
      return rows.length;
    },
  };
}

/**
 * @param {{
 *   driver: { listCandidates: Function, supersede: Function },
 *   dryRun: boolean,
 *   reason: string,
 *   now?: Date,
 * }} opts
 */
export async function runSupersedeCenturionAiRuns(opts) {
  const { driver, dryRun, reason, now = new Date() } = opts;
  const candidates = await driver.listCandidates();
  const targets = selectSupersedeTargets(candidates);

  if (dryRun) {
    return {
      mode: 'dry-run',
      transportId: TRANSPORT_ID,
      reason,
      matched: targets.length,
      wouldSupersede: targets.length,
      superseded: 0,
      ids: targets.map((row) => row.id),
    };
  }

  const superseded = await driver.supersede({
    ids: targets.map((row) => row.id),
    reason,
    now,
  });

  return {
    mode: 'apply',
    transportId: TRANSPORT_ID,
    reason,
    matched: targets.length,
    wouldSupersede: 0,
    superseded,
    ids: targets.map((row) => row.id),
  };
}

function isMain() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
}

async function main() {
  const args = parseSupersedeArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });
  try {
    const summary = await runSupersedeCenturionAiRuns({
      driver: createPostgresSupersedeDriver(sql),
      dryRun: args.dryRun,
      reason: args.reason,
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
