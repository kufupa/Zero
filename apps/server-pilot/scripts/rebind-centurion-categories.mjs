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

async function main() {
  console.log('=== CHECKING & REBINDING MAIL_THREAD_CATEGORY IDS ===');

  const beforeCounts = await sql`
    SELECT
      count(*)::int as total_rows,
      count(*) FILTER (WHERE category_id LIKE 'category-transport-nava-%')::int as nava_cat_rows,
      count(*) FILTER (WHERE category_id LIKE 'category-transport-centurion-%')::int as centurion_cat_rows
    FROM mail_thread_category
    WHERE transport_id = ${TRANSPORT_ID}
  `;
  console.log('Before counts:');
  console.table(beforeCounts);

  if (beforeCounts[0].nava_cat_rows > 0) {
    console.log(`Fixing ${beforeCounts[0].nava_cat_rows} rows mapped to transport-nava categories...`);

    // Perform safe update: replace 'category-transport-nava-' with 'category-transport-centurion-'
    // In case a duplicate (thread_id, centurion_category_id) already exists, delete duplicates first
    await sql.begin(async (tx) => {
      // 1. Delete rows where the centurion equivalent already exists on that thread
      const deletedDups = await tx`
        DELETE FROM mail_thread_category mtc
        WHERE mtc.transport_id = ${TRANSPORT_ID}
          AND mtc.category_id LIKE 'category-transport-nava-%'
          AND EXISTS (
            SELECT 1 FROM mail_thread_category mtc2
            WHERE mtc2.thread_id = mtc.thread_id
              AND mtc2.category_id = replace(mtc.category_id, 'category-transport-nava-', 'category-transport-centurion-')
          )
      `;
      console.log('Deleted duplicate rows:', deletedDups.count);

      // 2. Update remaining rows
      const updated = await tx`
        UPDATE mail_thread_category
        SET category_id = replace(category_id, 'category-transport-nava-', 'category-transport-centurion-')
        WHERE transport_id = ${TRANSPORT_ID}
          AND category_id LIKE 'category-transport-nava-%'
      `;
      console.log('Updated rows to centurion category IDs:', updated.count);
    });
  }

  const afterCounts = await sql`
    SELECT
      count(*)::int as total_rows,
      count(*) FILTER (WHERE category_id LIKE 'category-transport-nava-%')::int as nava_cat_rows,
      count(*) FILTER (WHERE category_id LIKE 'category-transport-centurion-%')::int as centurion_cat_rows
    FROM mail_thread_category
    WHERE transport_id = ${TRANSPORT_ID}
  `;
  console.log('After counts:');
  console.table(afterCounts);

  // Check category counts now on RDS
  const catBreakdown = await sql`
    SELECT
      mc.slug,
      count(DISTINCT mtc.thread_id)::int as thread_count
    FROM mail_category mc
    JOIN mail_thread_category mtc ON mtc.category_id = mc.id
    WHERE mc.transport_id = ${TRANSPORT_ID}
      AND mc.is_active = true
    GROUP BY mc.slug
    ORDER BY thread_count DESC
  `;
  console.log('Category thread counts on transport-centurion:');
  console.table(catBreakdown);

  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
