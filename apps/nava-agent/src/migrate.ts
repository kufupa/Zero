import { readFile } from 'node:fs/promises';
import { sql } from './db.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
try {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nava_agent:migrate',0))`;
    for (const name of [
      '001_init.sql', '002_session_store.sql', '003_mail_prefilter.sql', '004_prepare_selection.sql',
      '005_party_booking_memory.sql', '006_sender_party_memory.sql', '007_memory_observation.sql',
      '008_sender_party_stay.sql', '009_history_policy.sql',
    ]) {
      // 006 lives under src/migrations; 001–005 and 007 under apps/nava-agent/migrations.
      const rel = name.startsWith('006_') ? `./migrations/${name}` : `../migrations/${name}`;
      await tx.unsafe(await readFile(new URL(rel, import.meta.url), 'utf8'));
    }
  });
} finally {
  await sql.end();
}
