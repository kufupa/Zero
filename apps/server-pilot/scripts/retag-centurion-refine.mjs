/**
 * Retag Centurion threads with updated triage refinements.
 *
 * Usage:
 *   node scripts/retag-centurion-refine.mjs               # dry run
 *   node scripts/retag-centurion-refine.mjs --apply       # apply to DB
 *   node scripts/retag-centurion-refine.mjs --apply --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const isApply = process.argv.includes('--apply');
const isVerbose = process.argv.includes('--verbose');

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

const { getDb, closeDb } = await import(path.join(root, 'dist/db/client.js'));
const { applyDurableTriageResult, refineTriageOutput } = await import(path.join(root, 'dist/ai/triage.js'));
const { AI_WORKFLOW_PRIMARY_SLUGS: WORKFLOW_PRIMARY_SLUGS } = await import(path.join(root, 'dist/ai/categories.js'));
const postgres = (await import('postgres')).default;
const sql = postgres(url, { ssl: sslOptions(), max: 2 });
const db = getDb();

const TRANSPORT_ID = 'transport-centurion';

function normalizeToWorkflowOutput(raw, livePrimary, liveUrgent, liveSpam) {
  if (raw && typeof raw === 'object' && 'primaryFolder' in raw && raw.primaryFolder) {
    return {
      primaryFolder: raw.primaryFolder,
      priority: raw.priority || 'P3',
      urgent: Boolean(raw.urgent),
      overlays: raw.overlays || {},
      isSpam: Boolean(raw.isSpam),
      suggestedTools: raw.suggestedTools || [],
      sourceScope: raw.sourceScope || 'external',
      automationState: raw.automationState || 'candidate',
      humanAction: raw.humanAction || 'review_required',
      confidence: raw.confidence ?? 0.8,
      rationale: raw.rationale || 'Baseline triage.',
      policyFlags: raw.policyFlags || [],
      abstainReason: raw.abstainReason ?? null,
    };
  }

  const cat = raw?.category;
  let folder = 'bookings';
  if (cat === 'new-bookings') folder = 'bookings';
  else if (cat === 'groups-events') folder = 'groups-events';
  else if (cat === 'at-risk') folder = 'exceptions-recovery';
  else if (cat === 'ops') folder = 'automated-channel';
  else if (livePrimary) folder = livePrimary;

  return {
    primaryFolder: folder,
    priority: raw?.priority || 'P3',
    urgent: Boolean(raw?.urgent ?? liveUrgent),
    overlays: raw?.overlays || {},
    isSpam: Boolean(cat === 'spam' || raw?.isSpam || liveSpam),
    suggestedTools: raw?.suggestedTools || [],
    sourceScope: raw?.sourceScope || 'external',
    automationState: raw?.automationState || 'candidate',
    humanAction: raw?.humanAction || 'review_required',
    confidence: raw?.confidence ?? 0.8,
    rationale: raw?.rationale || 'Baseline legacy triage.',
    policyFlags: raw?.policyFlags || [],
    abstainReason: null,
  };
}

async function main() {
  console.log(`== Centurion Refine Retag (${isApply ? 'APPLY' : 'DRY-RUN'}) ==`);

  const threads = await sql`
    WITH latest_inbound AS (
      SELECT DISTINCT ON (m.thread_id)
        m.id AS message_id,
        m.thread_id,
        m.from_address,
        m.to_addresses,
        m.cc_addresses,
        m.bcc_addresses,
        m.subject,
        m.text_body,
        m.html_body,
        m.received_at,
        m.created_at
      FROM message m
      WHERE m.transport_id = ${TRANSPORT_ID}
        AND m.direction = 'inbound'
      ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
    ),
    cats AS (
      SELECT
        mtc.thread_id,
        array_agg(mc.slug ORDER BY mc.slug) AS slugs
      FROM mail_thread_category mtc
      JOIN mail_category mc ON mc.id = mtc.category_id
      WHERE mc.transport_id = ${TRANSPORT_ID}
        AND mc.is_active = true
      GROUP BY mtc.thread_id
    ),
    latest_run AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        metrics,
        state,
        created_at AS run_at
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
      ORDER BY thread_id, created_at DESC
    )
    SELECT
      t.id AS thread_id,
      t.spam_at,
      t.spam_user_locked_at,
      c.slugs AS category_slugs,
      li.message_id AS latest_inbound_id,
      li.from_address AS latest_inbound_from,
      li.to_addresses AS latest_inbound_to,
      li.cc_addresses AS latest_inbound_cc,
      li.bcc_addresses AS latest_inbound_bcc,
      li.subject,
      li.text_body,
      li.html_body,
      coalesce(li.received_at, li.created_at) AS latest_inbound_at,
      lr.run_id,
      lr.metrics AS run_metrics,
      lr.state AS run_state
    FROM mail_thread t
    JOIN latest_inbound li ON li.thread_id = t.id
    LEFT JOIN cats c ON c.thread_id = t.id
    LEFT JOIN latest_run lr ON lr.thread_id = t.id
    WHERE t.transport_id = ${TRANSPORT_ID}
    ORDER BY li.created_at ASC
  `;

  console.log(`Scanned ${threads.length} threads with inbound messages.`);

  const stats = {
    total: threads.length,
    changed: 0,
    unchanged: 0,
    skippedLocked: 0,
    changesByTransition: {},
    highlightedCases: [],
  };

  const toApply = [];

  for (const row of threads) {
    const liveCats = row.category_slugs || [];
    const livePrimary = WORKFLOW_PRIMARY_SLUGS.find((s) => liveCats.includes(s)) || (liveCats.includes('new-bookings') ? 'bookings' : null);
    const liveUrgent = liveCats.includes('urgent');
    const liveSpam = row.spam_at != null;

    const candidateRaw = row.run_metrics?.rawOutput || row.run_metrics?.canonicalOutput;
    const rawOutput = normalizeToWorkflowOutput(candidateRaw, livePrimary, liveUrgent, liveSpam);

    const triageInput = {
      transportId: TRANSPORT_ID,
      threadId: row.thread_id,
      from: row.latest_inbound_from || '',
      subject: row.subject || '',
      body: row.text_body || row.html_body || '',
      asOf: row.latest_inbound_at ? new Date(row.latest_inbound_at).toISOString() : new Date().toISOString(),
    };

    const refined = refineTriageOutput(triageInput, rawOutput);

    const newPrimary = refined.primaryFolder;
    const newUrgent = refined.urgent;
    const newSpam = refined.isSpam;

    const primaryChanged = livePrimary !== newPrimary;
    const urgentChanged = liveUrgent !== newUrgent;
    const spamChanged = liveSpam !== newSpam;

    const isDifferent = primaryChanged || urgentChanged || spamChanged;

    const subj = (row.subject || '').toLowerCase();
    const from = (row.latest_inbound_from || '').toLowerCase();
    const body = (triageInput.body || '').toLowerCase();

    let highlightReason = null;
    if (from.includes('pmbobo') || (subj.includes('quotation') && from.includes('penny'))) {
      highlightReason = 'Penny Mbobo staff forward';
    } else if (from.includes('cmartin') || subj.includes('dinner allowance')) {
      highlightReason = 'Cindy Martin rate mapping';
    } else if (subj.includes('voucher a057096') || (from.includes('nexus') && subj.includes('voucher'))) {
      highlightReason = 'Nexus travel voucher';
    } else if (from.includes('rennies') || (subj.includes('voucher') && (subj.includes('invoice') || subj.includes('tax')))) {
      highlightReason = 'Rennies voucher / invoice';
    } else if (subj.includes('application') || body.includes('stock controller') || body.includes('hiring manager')) {
      highlightReason = 'Job application / CV';
    } else if (subj.includes('jaco smit') || (subj.includes('booking.com') && (body.includes('12 hours') || body.includes('12h') || body.includes('jaco')))) {
      highlightReason = 'Jaco Smit 12h change';
    } else if (from.includes('nedbank') || subj.includes('nedbank merchant')) {
      highlightReason = 'Nedbank receipt';
    }

    if (highlightReason) {
      stats.highlightedCases.push({
        threadId: row.thread_id,
        reason: highlightReason,
        subject: row.subject,
        from: row.latest_inbound_from,
        before: { primary: livePrimary, urgent: liveUrgent, spam: liveSpam },
        after: { primary: newPrimary, urgent: newUrgent, spam: newSpam, policyFlags: refined.policyFlags },
      });
    }

    if (isDifferent) {
      stats.changed++;
      const transitionKey = `${livePrimary || 'none'}${liveUrgent ? '(urgent)' : ''}${liveSpam ? '(spam)' : ''} -> ${newPrimary}${newUrgent ? '(urgent)' : ''}${newSpam ? '(spam)' : ''}`;
      stats.changesByTransition[transitionKey] = (stats.changesByTransition[transitionKey] || 0) + 1;

      toApply.push({
        row,
        refined,
        transitionKey,
      });
    } else {
      stats.unchanged++;
    }
  }

  console.log(`\n=== Summary of Changes ===`);
  console.log(`Total threads scanned: ${stats.total}`);
  console.log(`Threads to update:     ${stats.changed}`);
  console.log(`Threads unchanged:     ${stats.unchanged}`);
  console.log(`\n=== Transitions Breakdown ===`);
  for (const [trans, cnt] of Object.entries(stats.changesByTransition).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${trans.padEnd(55)}: ${cnt}`);
  }

  console.log(`\n=== Highlighted Test Cases ===`);
  for (const c of stats.highlightedCases) {
    console.log(`\n- [${c.reason}] thread=${c.threadId}`);
    console.log(`  From:    ${c.from}`);
    console.log(`  Subject: ${c.subject}`);
    console.log(`  Before:  primary=${c.before.primary} urgent=${c.before.urgent} spam=${c.before.spam}`);
    console.log(`  After:   primary=${c.after.primary} urgent=${c.after.urgent} spam=${c.after.spam}`);
    console.log(`  Flags:   ${c.after.policyFlags.join(', ')}`);
  }

  if (!isApply) {
    console.log(`\n[DRY-RUN COMPLETE] Run with --apply to commit these updates to RDS.`);
    return;
  }

  console.log(`\n=== Applying Updates to RDS (${toApply.length} threads) ===`);
  let appliedCount = 0;
  let failCount = 0;

  for (let i = 0; i < toApply.length; i++) {
    const { row, refined, transitionKey } = toApply[i];
    try {
      await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId: row.thread_id,
        output: refined,
        writeGateEnabled: true,
        workflowTriageEnabled: true,
        forceUnsettle: true,
        from: row.latest_inbound_from || undefined,
        to: row.latest_inbound_to || undefined,
        cc: row.latest_inbound_cc || undefined,
        bcc: row.latest_inbound_bcc || undefined,
      });

      if (row.run_id) {
        await sql`
          UPDATE ai_workflow_run
          SET
            metrics = jsonb_set(
              jsonb_set(
                case when jsonb_typeof(metrics) = 'object' then metrics else '{}'::jsonb end,
                '{canonicalOutput}',
                ${JSON.stringify(refined)}::jsonb
              ),
              '{policyFlags}',
              ${JSON.stringify(refined.policyFlags)}::jsonb
            ),
            updated_at = now()
          WHERE id = ${row.run_id}
        `;
      }

      appliedCount++;
      if (isVerbose || (i + 1) % 50 === 0 || i === toApply.length - 1) {
        console.log(`Applied [${i + 1}/${toApply.length}] thread=${row.thread_id}: ${transitionKey}`);
      }
    } catch (err) {
      failCount++;
      console.error(`Failed to apply thread=${row.thread_id}:`, err);
    }
  }

  console.log(`\n=== Done Applying ===`);
  console.log(`Successfully applied: ${appliedCount}`);
  console.log(`Failed:               ${failCount}`);
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
    await closeDb?.();
  });
