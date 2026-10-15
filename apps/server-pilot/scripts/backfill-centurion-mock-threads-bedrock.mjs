/**
 * Backfill Centurion mock/dead-letter threads using real Amazon Bedrock Nova Lite.
 *
 * Usage:
 *   node scripts/backfill-centurion-mock-threads-bedrock.mjs --dry-run --limit 5
 *   node scripts/backfill-centurion-mock-threads-bedrock.mjs --apply --concurrency 8
 *   node scripts/backfill-centurion-mock-threads-bedrock.mjs --apply --concurrency 10
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const isApply = process.argv.includes('--apply');
const _isDryRun = !isApply || process.argv.includes('--dry-run');

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

const limitArg = getArgValue('--limit');
const limit = limitArg ? parseInt(limitArg, 10) : null;

const concurrencyArg = getArgValue('--concurrency');
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg, 10) : 4;

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const postgres = (await import('postgres')).default;
const sql = postgres(url, { ssl: sslOptions(), max: Math.max(CONCURRENCY + 4, 15) });

const { createModelAdapter } = await import(path.join(root, 'dist/ai/bedrock/factory.js'));
const { classifyWorkflowMailTriage, TRIAGE_PROMPT_VERSION, TRIGGER_BODY_LIMIT, CONTEXT_BODY_LIMIT } = await import(path.join(root, 'dist/ai/workflows/mail-triage.js'));
const { refineTriageOutput, validateWorkflowTriageOutput } = await import(path.join(root, 'dist/ai/triage.js'));
const { AI_WORKFLOW_PRIMARY_SLUGS: WORKFLOW_PRIMARY_SLUGS } = await import(path.join(root, 'dist/ai/categories.js'));

const TRANSPORT_ID = 'transport-centurion';
const MODEL_ID = 'amazon.nova-lite-v1:0';

const AI_MANAGED_SLUGS = [
  ...WORKFLOW_PRIMARY_SLUGS,
  'urgent',
  'new-bookings',
  'groups-events',
  'at-risk',
  'ops',
  'internal',
  'individual',
  'group',
  'travel-agents'
];

async function main() {
  console.log(`=== CENTURION BEDROCK BACKFILL ===`);
  console.log(`Mode: ${isApply ? 'APPLY (Mutating DB)' : 'DRY RUN (Read Only)'}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (limit) console.log(`Limit: ${limit} threads`);

  // Ensure category ID map
  const categories = await sql`
    SELECT id, slug FROM mail_category WHERE is_active = true
  `;
  const categoryMap = new Map();
  for (const c of categories) {
    categoryMap.set(c.slug, c.id);
  }

  // 1. Identify all mock or dead-letter threads
  console.log('\nScanning for threads needing real Bedrock backfill...');
  const targetRows = await sql`
    WITH latest_runs AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        state,
        metrics,
        last_error,
        created_at,
        (metrics->'rawOutput'->>'rationale') AS raw_rationale,
        (metrics->'usage'->>'latencyMs')::int AS latency_ms
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
      ORDER BY thread_id, created_at DESC
    ),
    threads_with_inbound AS (
      SELECT DISTINCT thread_id
      FROM message
      WHERE transport_id = ${TRANSPORT_ID} AND direction = 'inbound'
    )
    SELECT
      t.id AS thread_id,
      t.subject,
      t.spam_at,
      t.spam_user_locked_at,
      lr.run_id,
      lr.state,
      lr.raw_rationale,
      lr.latency_ms,
      array_agg(mc.slug) FILTER (WHERE mc.slug IS NOT NULL) AS current_categories
    FROM mail_thread t
    JOIN threads_with_inbound twi ON twi.thread_id = t.id
    LEFT JOIN latest_runs lr ON lr.thread_id = t.id
    LEFT JOIN mail_thread_category mtc ON mtc.thread_id = t.id
    LEFT JOIN mail_category mc ON mc.id = mtc.category_id AND mc.is_active = true
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND (
        lr.run_id IS NULL
        OR lr.state = 'dead_letter'
        OR lr.raw_rationale IS NULL
        OR lr.raw_rationale IN (
          'Guest booking inquiry',
          'Group quote language',
          'Internal ops handover',
          'Spam offer',
          'Baseline legacy triage.',
          'Ops automation',
          'At-risk recovery'
        )
        OR lr.latency_ms = 15
      )
    GROUP BY t.id, t.subject, t.spam_at, t.spam_user_locked_at, lr.run_id, lr.state, lr.raw_rationale, lr.latency_ms
    ORDER BY t.created_at ASC
  `;

  console.log(`Found ${targetRows.length} threads needing real Bedrock triage.`);
  if (targetRows.length === 0) {
    console.log('No threads need backfill. Database is 100% up to date!');
    await sql.end();
    return;
  }

  const selectedTargets = limit ? targetRows.slice(0, limit) : targetRows;
  console.log(`Processing ${selectedTargets.length} threads.`);

  // 2. Write snapshot before mutation
  const snapshotPath = path.join(root, 'data', 'mock-backfill-pre-snapshot.json');
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(selectedTargets.map(t => ({
    threadId: t.thread_id,
    subject: t.subject,
    spamAt: t.spam_at,
    spamUserLockedAt: t.spam_user_locked_at,
    currentRunId: t.run_id,
    currentRationale: t.raw_rationale,
    currentCategories: t.current_categories || []
  })), null, 2));
  console.log(`Pre-mutation snapshot saved to ${snapshotPath}`);

  // 3. Initialize Bedrock adapter
  const adapter = createModelAdapter();

  // Progress metrics
  const stats = {
    total: selectedTargets.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    folderCounts: {},
    spamCount: 0,
    urgentCount: 0,
    startTime: Date.now()
  };

  // Helper to process a single thread
  async function processThread(thread) {
    const threadId = thread.thread_id;

    // Fetch messages for thread
    const msgs = await sql`
      SELECT
        id,
        direction,
        from_address,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        subject,
        text_body,
        html_body,
        created_at,
        received_at,
        sent_at
      FROM message
      WHERE thread_id = ${threadId}
      ORDER BY coalesce(received_at, created_at) ASC
    `;

    if (msgs.length === 0) {
      stats.skipped++;
      return;
    }

    // Identify latest inbound trigger message
    const inboundMsgs = msgs.filter(m => m.direction === 'inbound');
    const trigger = inboundMsgs.length > 0 ? inboundMsgs[inboundMsgs.length - 1] : msgs[msgs.length - 1];

    const rawTriggerBody = (trigger.text_body && trigger.text_body.trim().length > 0)
      ? trigger.text_body
      : (trigger.html_body || '');
    const cleanTriggerBody = rawTriggerBody.slice(0, TRIGGER_BODY_LIMIT);

    // Format causal message rows
    const triageMessageRows = msgs.slice(-10).map(m => {
      const b = (m.text_body && m.text_body.trim().length > 0) ? m.text_body : (m.html_body || '');
      return {
        id: m.id,
        direction: m.direction,
        from: m.from_address || '',
        to: m.to_addresses || [],
        cc: m.cc_addresses || [],
        bcc: m.bcc_addresses || [],
        subject: m.subject || '',
        body: b.slice(0, CONTEXT_BODY_LIMIT),
        createdAt: m.created_at,
        receivedAt: m.received_at,
        sentAt: m.sent_at,
      };
    });

    const triageInput = {
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: trigger.id,
      messages: triageMessageRows,
      from: trigger.from_address || '',
      to: trigger.to_addresses || [],
      cc: trigger.cc_addresses || [],
      bcc: trigger.bcc_addresses || [],
      subject: trigger.subject || '',
      body: cleanTriggerBody,
      asOf: trigger.received_at ? new Date(trigger.received_at).toISOString() : new Date().toISOString(),
      modelId: MODEL_ID,
      promptVersion: TRIAGE_PROMPT_VERSION,
    };

    // Invoke Bedrock with retry
    let classification = null;
    let retries = 0;
    const runStart = new Date();

    while (retries < 6) {
      try {
        classification = await classifyWorkflowMailTriage(triageInput, adapter);
        break;
      } catch (err) {
        retries++;
        if (retries >= 6) throw err;
        const isThrottle = /throttl|too many requests/i.test(err.message || '');
        const backoffMs = isThrottle
          ? Math.min(2500 * Math.pow(1.8, retries) + Math.random() * 1000, 20000)
          : Math.min(1000 * retries, 5000);
        console.warn(`[Worker retry] Thread ${threadId} attempt ${retries}/5: waiting ${Math.round(backoffMs)}ms (${err.message.slice(0, 80)})`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }

    const runEnd = new Date();
    const validatedOutput = validateWorkflowTriageOutput(classification.output);

    // Apply deterministic refinement layer
    const refined = refineTriageOutput(triageInput, validatedOutput);

    // Update stats
    const primaryFolder = refined.primaryFolder;
    stats.folderCounts[primaryFolder] = (stats.folderCounts[primaryFolder] || 0) + 1;
    if (refined.isSpam) stats.spamCount++;
    if (refined.urgent) stats.urgentCount++;

    if (isApply) {
      await sql.begin(async tx => {
        // 1. Insert new successful AI workflow run
        const runId = randomUUID();
        const idempotencyKey = `inbound-triage-backfill-bedrock-20260907:${trigger.id}`;

        await tx`
          INSERT INTO ai_workflow_run (
            id,
            transport_id,
            thread_id,
            trigger_message_id,
            run_kind,
            idempotency_key,
            model_id,
            prompt_version,
            prompt_hash,
            state,
            attempts,
            metrics,
            created_at,
            started_at,
            finished_at,
            updated_at
          ) VALUES (
            ${runId},
            ${TRANSPORT_ID},
            ${threadId},
            ${trigger.id},
            'inbound_triage',
            ${idempotencyKey},
            ${MODEL_ID},
            ${TRIAGE_PROMPT_VERSION},
            ${classification.promptHash || null},
            'succeeded',
            1,
            ${{
              usage: classification.usage,
              rawOutput: classification.rawOutput,
              canonicalOutput: refined,
              policyFlags: refined.policyFlags,
              rationale: refined.rationale,
              backfillVersion: 'natural-bedrock-v1',
              latencyMs: runEnd.getTime() - runStart.getTime()
            }},
            ${runStart},
            ${runStart},
            ${runEnd},
            ${runEnd}
          )
          ON CONFLICT (idempotency_key) DO UPDATE
          SET
            state = 'succeeded',
            metrics = EXCLUDED.metrics,
            finished_at = EXCLUDED.finished_at,
            updated_at = EXCLUDED.updated_at
        `;

        // 2. Clear stale AI managed categories
        await tx`
          DELETE FROM mail_thread_category
          WHERE thread_id = ${threadId}
            AND category_id IN (
              SELECT id FROM mail_category WHERE slug = ANY(${AI_MANAGED_SLUGS})
            )
        `;

        // 3. Insert new primary category
        const primaryCatId = categoryMap.get(primaryFolder);
        if (primaryCatId) {
          await tx`
            INSERT INTO mail_thread_category (thread_id, category_id, transport_id)
            VALUES (${threadId}, ${primaryCatId}, ${TRANSPORT_ID})
            ON CONFLICT DO NOTHING
          `;
        }

        // 4. Insert urgent overlay category if urgent
        if (refined.urgent) {
          const urgentCatId = categoryMap.get('urgent');
          if (urgentCatId) {
            await tx`
              INSERT INTO mail_thread_category (thread_id, category_id, transport_id)
              VALUES (${threadId}, ${urgentCatId}, ${TRANSPORT_ID})
              ON CONFLICT DO NOTHING
            `;
          }
        }

        // 5. Update spam_at on mail_thread (unless user locked)
        if (refined.isSpam) {
          await tx`
            UPDATE mail_thread
            SET spam_at = now()
            WHERE id = ${threadId} AND spam_user_locked_at IS NULL
          `;
        } else {
          await tx`
            UPDATE mail_thread
            SET spam_at = NULL
            WHERE id = ${threadId} AND spam_user_locked_at IS NULL
          `;
        }
      });
    }

    stats.succeeded++;
  }

  // Worker pool implementation
  let cursor = 0;
  async function worker(workerId) {
    while (cursor < selectedTargets.length) {
      const idx = cursor++;
      const thread = selectedTargets[idx];
      try {
        await processThread(thread);
      } catch (err) {
        stats.failed++;
        console.error(`[Worker ${workerId}] Error on thread ${thread.thread_id}:`, err.message);
      }
      stats.processed++;

      if (stats.processed % 25 === 0 || stats.processed === selectedTargets.length) {
        const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
        const rate = (stats.processed / Math.max(elapsed, 1)).toFixed(1);
        const pct = ((stats.processed / stats.total) * 100).toFixed(1);
        console.log(`[Progress] ${stats.processed}/${stats.total} (${pct}%) | Succeeded: ${stats.succeeded} | Failed: ${stats.failed} | ${rate} th/s | ${elapsed}s elapsed`);
        try {
          fs.writeFileSync('/tmp/backfill-progress.json', JSON.stringify({
            processed: stats.processed,
            total: stats.total,
            pct,
            succeeded: stats.succeeded,
            failed: stats.failed,
            rate,
            elapsed
          }));
        } catch {}
      }
    }
  }

  console.log(`\nLaunching worker pool with ${CONCURRENCY} concurrent workers...`);
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(i + 1));
  }
  await Promise.all(workers);

  const totalTime = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  console.log(`\n=== BACKFILL COMPLETE in ${totalTime}s ===`);
  console.log(`Total Target: ${stats.total}`);
  console.log(`Succeeded:    ${stats.succeeded}`);
  console.log(`Failed:       ${stats.failed}`);
  console.log(`Skipped:      ${stats.skipped}`);
  console.log(`Spam Threads: ${stats.spamCount}`);
  console.log(`Urgent:       ${stats.urgentCount}`);
  console.log('\nDistribution across Workflow Folders:');
  console.table(Object.entries(stats.folderCounts).map(([folder, count]) => ({ folder, count })));

  await sql.end();
}

main().catch(err => {
  console.error('Fatal error in backfill:', err);
  process.exit(1);
});
