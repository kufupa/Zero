/**
 * Ops helper: run Centurion triage --quality floors + Q11 without retag coverage audit.
 *   node --import tsx scripts/run-centurion-triage-quality-audit.mjs
 *
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

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
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
    driver: createPostgresCenturionTriageQualityDriver(sql, TRANSPORT_ID),
  });
  console.log(JSON.stringify(quality, null, 2));
  process.exit(quality.ok ? 0 : 1);
} finally {
  await sql.end({ timeout: 5 });
}
