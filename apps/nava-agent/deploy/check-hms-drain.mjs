import postgres from '../node_modules/postgres/src/index.js';

const e=process.env;
let sql;
try {
  if (!e.DATABASE_URL || e.DATABASE_URL !== e.HMS_CREDENTIAL_LEASE_DATABASE_URL) throw Error('DB_MISMATCH');
  const db=new URL(e.DATABASE_URL);
  if (db.hostname !== '127.0.0.1' || db.port !== '5433') throw Error('DB_MISMATCH');
  sql=postgres(e.DATABASE_URL,{max:1});
  const [r]=await sql.begin('read only',tx=>tx`SELECT
    (SELECT count(*) FROM nava_agent.agent_session WHERE lease_until > now()) AS leases,
    (SELECT count(*) FROM nava_agent.proposal WHERE phase IN ('staging','saving')) AS active_proposals,
    (SELECT count(*) FROM nava_agent.agent_event WHERE kind IN ('mail_pending','context_pending') AND payload->>'delivered'='false') AS pending,
    (SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted) AS locks`);
  console.log('drain='+JSON.stringify(r));
  if (Object.values(r).some(n=>Number(n)!==0)) process.exitCode=1;
} catch {
  console.error('drain_check=unavailable');
  process.exitCode=1;
} finally {
  if (sql) await sql.end({timeout:5});
}
