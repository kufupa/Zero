/**
 * Ops helper: run Centurion triage --quality floors + Q11 without retag coverage audit.
 *   node --import tsx scripts/run-centurion-triage-quality-audit.mjs --q11-volume q11.json
 *
 * --q11-volume JSON must supply live Un/Rsp/Act from conversation-signals (required; no WINDOW default).
 * Env: DATABASE_URL (ops / pilot only — never Vitest)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditCenturionTriageQuality,
  createPostgresCenturionTriageQualityDriver,
} from '../src/ops/centurion-triage-quality-audit.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const TRANSPORT_ID = 'transport-centurion';

function parseArgs(argv) {
  let q11VolumePath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--q11-volume') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--q11-volume requires a path');
      }
      q11VolumePath = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  return { q11VolumePath };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.q11VolumePath) {
  console.error('--q11-volume <path> required (live Un/Rsp/Act; refuse WINDOW default)');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(args.q11VolumePath, 'utf8'));
const q11VolumeOverride = {
  unanswered: raw.unanswered,
  responded: raw.responded,
  actionable: raw.actionable,
};
for (const key of ['unanswered', 'responded', 'actionable']) {
  if (typeof q11VolumeOverride[key] !== 'number') {
    console.error(`--q11-volume JSON missing numeric ${key}`);
    process.exit(1);
  }
}

const { default: postgres } = await import('postgres');
const ca = path.join(root, 'deploy', 'rds-ca-global.pem');
const sql = postgres(url, {
  ssl: fs.existsSync(ca)
    ? { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') }
    : 'require',
  max: 1,
  connect_timeout: 30,
});

try {
  const quality = await auditCenturionTriageQuality({
    driver: createPostgresCenturionTriageQualityDriver(sql, TRANSPORT_ID, q11VolumeOverride),
  });
  console.log(JSON.stringify(quality, null, 2));
  process.exit(quality.ok ? 0 : 1);
} finally {
  await sql.end({ timeout: 5 });
}
