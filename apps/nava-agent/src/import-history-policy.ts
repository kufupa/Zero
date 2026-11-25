import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {indexHistoryPolicy} from './history-policy.js';
import {sql, json} from './db.js';

const [, , file, property = 'HRCEN'] = process.argv;
if (!file || !process.env.DATABASE_URL) throw new Error('Usage: import-history-policy.ts <policy.json> [property]; DATABASE_URL required');
try {
  const content = await readFile(file);
  const sha = createHash('sha256').update(content).digest('hex');
  const index = indexHistoryPolicy(JSON.parse(content.toString()));
  const count = Object.values(index).reduce((sum, rows) => sum + rows.length, 0);
  if (!count) throw new Error('History policy has no usable entries');
  await sql`INSERT INTO nava_agent.history_policy (property_code, snapshot_sha256, entries)
    VALUES (${property.toUpperCase()}, ${sha}, ${json(index)})
    ON CONFLICT (property_code) DO UPDATE
      SET snapshot_sha256 = EXCLUDED.snapshot_sha256, entries = EXCLUDED.entries, loaded_at = now()
    WHERE history_policy.snapshot_sha256 <> EXCLUDED.snapshot_sha256`;
  console.log(JSON.stringify({property: property.toUpperCase(), policy_sha256: sha, entries: count}));
} finally {
  await sql.end();
}
