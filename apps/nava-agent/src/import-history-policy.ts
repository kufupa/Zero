import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {indexHistoryPolicy} from './history-policy.js';
import {indexPartyUse} from './organization-use.js';
import {sql, json} from './db.js';

const [, , file, property = 'HRCEN', historyFile] = process.argv;
if (!file || !process.env.DATABASE_URL) throw new Error('Usage: import-history-policy.ts <policy.json> [property] [party-use.jsonl]; DATABASE_URL required');
try {
  const content = await readFile(file);
  const sha = createHash('sha256').update(content).digest('hex');
  const index = indexHistoryPolicy(JSON.parse(content.toString()));
  const count = Object.values(index).reduce((sum, rows) => sum + rows.length, 0);
  if (!count) throw new Error('History policy has no usable entries');
  const entries = historyFile ? {...index, _party_use: indexPartyUse(
    (await readFile(historyFile, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)),
  )} : index;
  await sql`INSERT INTO nava_agent.history_policy (property_code, snapshot_sha256, entries)
    VALUES (${property.toUpperCase()}, ${sha}, ${json(entries)})
    ON CONFLICT (property_code) DO UPDATE
      SET snapshot_sha256 = EXCLUDED.snapshot_sha256,
          entries = CASE WHEN history_policy.entries ? '_party_use' AND NOT (EXCLUDED.entries ? '_party_use')
            THEN EXCLUDED.entries || jsonb_build_object('_party_use', history_policy.entries -> '_party_use')
            ELSE EXCLUDED.entries END,
          loaded_at = now()
    WHERE history_policy.snapshot_sha256 <> EXCLUDED.snapshot_sha256 OR
          (EXCLUDED.entries ? '_party_use' AND history_policy.entries IS DISTINCT FROM EXCLUDED.entries)`;
  console.log(JSON.stringify({property: property.toUpperCase(), policy_sha256: sha, entries: count}));
} finally {
  await sql.end();
}
