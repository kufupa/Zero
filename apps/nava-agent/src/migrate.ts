import { readFile } from 'node:fs/promises';
import { sql } from './db.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
try {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nava_agent:migrate',0))`;
    for (const name of ['001_init.sql', '002_session_store.sql', '003_mail_prefilter.sql']) {
      await tx.unsafe(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
  });
} finally {
  await sql.end();
}
