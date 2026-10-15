import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

const postgres = (await import('postgres')).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: sslOptions() });

const TRANSPORT_ID = 'transport-centurion';

async function run() {
  const counts = await sql`
    SELECT
      count(*)::int as total_threads,
      count(*) FILTER (WHERE is_archived = true)::int as is_archived_true,
      count(*) FILTER (WHERE is_archived = false)::int as is_archived_false,
      count(*) FILTER (WHERE trashed_at IS NOT NULL)::int as trashed,
      count(*) FILTER (WHERE spam_at IS NOT NULL)::int as spam,
      count(*) FILTER (WHERE trashed_at IS NULL AND spam_at IS NULL AND is_archived = true)::int as archive_folder_total,
      count(*) FILTER (WHERE trashed_at IS NULL AND spam_at IS NULL AND is_archived = true AND is_read = false)::int as archive_folder_unread,
      count(*) FILTER (WHERE trashed_at IS NULL AND spam_at IS NULL AND is_archived = false)::int as active_inbox_candidate
    FROM mail_thread
    WHERE transport_id = ${TRANSPORT_ID}
  `;
  console.log('Thread counts:');
  console.log(JSON.stringify(counts[0], null, 2));

  const messagesInArchive = await sql`
    SELECT
      count(m.id)::int as message_count
    FROM message m
    JOIN mail_thread t ON t.id = m.thread_id
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
      AND t.is_archived = true
  `;
  console.log('Messages in archive threads:');
  console.log(JSON.stringify(messagesInArchive[0], null, 2));

  // Let us find everything in the DB that equals 869 or is close to 869
  const probes = await sql`
    SELECT 'threads where is_read = true' as descr, count(*)::int as count FROM mail_thread WHERE transport_id = ${TRANSPORT_ID} AND is_read = true
    UNION ALL
    SELECT 'threads where is_read = false' as descr, count(*)::int as count FROM mail_thread WHERE transport_id = ${TRANSPORT_ID} AND is_read = false
    UNION ALL
    SELECT 'threads outbound only' as descr, count(*)::int as count FROM mail_thread t WHERE transport_id = ${TRANSPORT_ID} AND NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.direction = 'inbound')
    UNION ALL
    SELECT 'total messages direction outbound' as descr, count(*)::int as count FROM message WHERE transport_id = ${TRANSPORT_ID} AND direction = 'outbound'
    UNION ALL
    SELECT 'total messages direction inbound' as descr, count(*)::int as count FROM message WHERE transport_id = ${TRANSPORT_ID} AND direction = 'inbound'
    UNION ALL
    SELECT 'total threads without category' as descr, count(*)::int as count FROM mail_thread t WHERE transport_id = ${TRANSPORT_ID} AND NOT EXISTS (SELECT 1 FROM mail_thread_category mtc WHERE mtc.thread_id = t.id)
    UNION ALL
    SELECT 'threads where is_archived = true' as descr, count(*)::int as count FROM mail_thread WHERE transport_id = ${TRANSPORT_ID} AND is_archived = true
    UNION ALL
    SELECT 'archive unread loadUnreadCounts' as descr, count(*)::int as count FROM mail_thread WHERE transport_id = ${TRANSPORT_ID} AND is_read = false AND trashed_at IS NULL AND spam_at IS NULL AND is_archived = true
    UNION ALL
    SELECT 'archive total loadUnreadCounts' as descr, count(*)::int as count FROM mail_thread WHERE transport_id = ${TRANSPORT_ID} AND trashed_at IS NULL AND spam_at IS NULL AND is_archived = true
  `;
  console.log('Probes:');
  console.table(probes);

  // Also check all transports in DB:
  const transports = await sql`
    SELECT transport_id, count(*)::int as threads, count(*) FILTER (WHERE is_archived = true)::int as archived FROM mail_thread GROUP BY transport_id
  `;
  console.log('Transports:');
  console.table(transports);

  // Also check folder unread counts API directly:
  const { loadUnreadCounts } = await import('../dist/mail/folder-unread-counts.js');
  const { createDatabaseClient } = await import('../dist/db/client.js');
  const db = createDatabaseClient({ databaseUrl: process.env.DATABASE_URL, ssl: sslOptions() });
  const countsApi = await loadUnreadCounts(db, TRANSPORT_ID);
  console.log('loadUnreadCounts API result for folders:');
  console.table(countsApi.folders);

  await sql.end();
}
run().catch(console.error);
