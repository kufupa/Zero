#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire('/home/ubuntu/repos/zero/apps/server-pilot/package.json');
const postgres = require('postgres');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const execFileAsync = promisify(execFile);

const INPUT_PATH = '/tmp/thanksgiving-p0p3-input.b64';
const OUTPUT_PATH = '/tmp/thanksgiving-p0p3-output.b64';
const BODY_KEY_RE = /(?<![0-9])(\d{6,12}-\d{1,2})(?![0-9])/g;
const CONFIRMATION_KEY_SHAPE_RE = /^\d{6,12}-\d{1,2}$/;
const SELF_MAIL_KEY_RE = /confirmation\s+no\s*:?\s*(\d{6,12}-\d{1,2})/gi;
const SELF_MAIL_SUBJECT_RE = /^pre[ -]stay([^0-9A-Za-z]|$)/i;
const CONFIRMATION_FILE_RE = /^hrcen_confirmation_letter_(\d{6,12}-\d{1,2})\.pdf$/i;



function confirmationKeysIn(text) {
  const out = new Set();
  const re = new RegExp(BODY_KEY_RE.source, 'g');
  for (const match of String(text || '').matchAll(re)) out.add(match[1]);
  return [...out];
}

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function cleanError(error) {
  return {
    code: error?.code || error?.name || 'error',
    message: String(error?.message || error).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]').slice(0, 500),
  };
}

function splitSqlStatements(text) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && next === '"') {
        current += next;
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      current += ch + next;
      i += 1;
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      current += ch + next;
      i += 1;
      inBlockComment = true;
      continue;
    }
    if (ch === "'") inSingle = true;
    if (ch === '"') inDouble = true;
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function chunkRows(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function extractDomain(address) {
  const match = /[^@\s<>]+@([a-z0-9.-]+)/i.exec(String(address || ''));
  return match ? match[1].toLowerCase() : null;
}

function domainMatches(host, domain) {
  return host === domain || Boolean(host && host.endsWith('.' + domain));
}

function bodyTextParts(row) {
  return [row.subject, row.text_body, row.html_body].filter((part) => typeof part === 'string' && part.length > 0);
}

function exactBodyHash(row) {
  const parts = bodyTextParts(row);
  if (!parts.length) return null;
  return createHash('sha256').update(parts.join('\x1f'), 'utf8').digest('hex');
}

async function main() {
  const packedInput = readFileSync(INPUT_PATH, 'utf8').trim();
  const input = JSON.parse(gunzipSync(Buffer.from(packedInput, 'base64')).toString('utf8'));
  const runId = input.runId;
  const result = {
    ok: false,
    run_id: runId,
    generated_at: new Date().toISOString(),
    stages: [],
    sql_statements: [],
    scan: {},
    extraction: {},
    hms_load: {},
    metrics: [],
    miss_samples: [],
    errors: [],
  };

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing in remote environment');
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    connection: {
      application_name: 'thanksgiving-p0-p3',
      statement_timeout: '15min',
      lock_timeout: '5s',
      idle_in_transaction_session_timeout: '15min',
    },
  });

  async function executeSql(name, text) {
    const statements = splitSqlStatements(text.replaceAll('__RUN_ID__', runId.replaceAll("'", "''")));
    let ordinal = 0;
    for (const statement of statements) {
      ordinal += 1;
      const started = Date.now();
      const rows = await sql.unsafe(statement);
      result.sql_statements.push({
        file: name,
        ordinal,
        ms: Date.now() - started,
        row_count: Number.isFinite(rows?.count) ? rows.count : null,
      });
    }
    result.stages.push({ stage: name, statements: statements.length, finished_at: new Date().toISOString() });
  }

  async function bulkInsert({ table, columns, rows, conflict, batchSize = 400 }) {
    let inserted = 0;
    for (const batch of chunkRows(rows, batchSize)) {
      const params = [];
      const tuples = batch.map((row) => `(${columns.map((column) => {
        params.push(row[column] ?? null);
        return `$${params.length}`;
      }).join(',')})`);
      const statement = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict}`;
      const response = await sql.unsafe(statement, params);
      inserted += Number.isFinite(response?.count) ? response.count : batch.length;
    }
    return inserted;
  }

  async function updateBodyHashes(updates) {
    let updated = 0;
    for (const batch of chunkRows(updates, 200)) {
      const params = [];
      const tuples = batch.map((row) => {
        params.push(row.message_id, row.body_sha256);
        return `($${params.length - 1}::text,$${params.length}::text)`;
      }).join(',');
      const response = await sql.unsafe(`
        UPDATE thanksgiving.message tm
        SET body_sha256 = v.body_sha256,
            updated_at = now()
        FROM (VALUES ${tuples}) AS v(message_id, body_sha256)
        WHERE tm.message_id = v.message_id
      `, params);
      updated += Number.isFinite(response?.count) ? response.count : batch.length;
    }
    return updated;
  }

  try {
    await executeSql('001_schema.sql', input.sql.schema);

    await sql`
      INSERT INTO thanksgiving.pipeline_run (run_id, stage, git_sha, status, params_json)
      VALUES (${runId}, 'p0-p3', ${input.gitSha || null}, 'running', ${sql.json(input.params || {})})
      ON CONFLICT (run_id) DO UPDATE SET
        stage = EXCLUDED.stage,
        git_sha = EXCLUDED.git_sha,
        status = EXCLUDED.status,
        params_json = EXCLUDED.params_json,
        started_at = now(),
        finished_at = NULL
    `;

    const domainRows = [
      ...(input.domains?.ota || []).map((domain) => ({ domain, rule_type: 'ota_channel', source: 'apps/nava-agent/src/mail-ingest.ts:otaChannelDomains' })),
      ...(input.domains?.system || []).map((domain) => ({ domain, rule_type: 'system_notice', source: 'apps/nava-agent/src/mail-ingest.ts:systemDomains' })),
    ].map((row) => ({ ...row, is_active: true, updated_at: new Date().toISOString() }));
    await sql`UPDATE thanksgiving.domain_rule SET is_active = false, updated_at = now() WHERE is_active`;
    await bulkInsert({
      table: 'thanksgiving.domain_rule',
      columns: ['domain', 'rule_type', 'source', 'is_active', 'updated_at'],
      rows: domainRows,
      conflict: `ON CONFLICT (domain, rule_type) DO UPDATE SET
        source = EXCLUDED.source,
        is_active = EXCLUDED.is_active,
        updated_at = EXCLUDED.updated_at`,
    });

    await executeSql('002_p0_register.sql', input.sql.p0);

    const keyMap = new Map();
    const scan = {
      batch_size: 250,
      messages_scanned: 0,
      messages_hashed: 0,
      hash_rows_updated: 0,
      body_bytes_scanned: 0,
      body_key_candidates: 0,
      self_mail_key_candidates: 0,
      attachment_filename_key_candidates: 0,
      pdf_candidates: 0,
      pdf_read_ok: 0,
      pdf_read_errors: 0,
      pdf_key_candidates: 0,
    };
    const addKey = (row, confirmationKey, source, confidence) => {
      if (!CONFIRMATION_KEY_SHAPE_RE.test(confirmationKey)) return;
      const id = `${row.id}\0${confirmationKey}\0${source}`;
      if (!keyMap.has(id)) {
        keyMap.set(id, {
          message_id: row.id,
          thread_id: row.thread_id,
          confirmation_key: confirmationKey,
          source,
          confidence,
          is_active: true,
          run_id: runId,
          extracted_at: new Date().toISOString(),
        });
        if (source === 'body_regex') scan.body_key_candidates += 1;
        if (source === 'self_mail_confirmation_no') scan.self_mail_key_candidates += 1;
      }
    };

    let lastId = '';
    for (;;) {
      const rows = await sql`
        SELECT id, thread_id, direction, from_address, subject, text_body, html_body
        FROM public.message
        WHERE id > ${lastId}
        ORDER BY id
        LIMIT ${scan.batch_size}
      `;
      if (!rows.length) break;
      const hashUpdates = [];
      for (const row of rows) {
        scan.messages_scanned += 1;
        scan.body_bytes_scanned += (row.subject?.length || 0) + (row.text_body?.length || 0) + (row.html_body?.length || 0);
        const bodyHash = exactBodyHash(row);
        if (bodyHash) scan.messages_hashed += 1;
        hashUpdates.push({ message_id: row.id, body_sha256: bodyHash });

        const host = extractDomain(row.from_address);
        const isSelfMail = domainMatches(host, 'legacyhotels.co.za') && SELF_MAIL_SUBJECT_RE.test(String(row.subject || ''));
        for (const part of bodyTextParts(row)) {
          for (const match of part.matchAll(BODY_KEY_RE)) addKey(row, match[1], 'body_regex', 0.70);
          if (isSelfMail) {
            for (const match of part.matchAll(SELF_MAIL_KEY_RE)) addKey(row, match[1], 'self_mail_confirmation_no', 0.95);
          }
        }
      }
      scan.hash_rows_updated += await updateBodyHashes(hashUpdates);
      lastId = rows[rows.length - 1].id;
    }
    result.scan = scan;

    await executeSql('003_p1_cut.sql', input.sql.p1);

    const filenameRows = await sql`
      SELECT a.message_id AS id, m.thread_id, a.filename
      FROM thanksgiving.attachment a
      JOIN thanksgiving.message m ON m.message_id = a.message_id
      WHERE m.direction = 'outbound'
        AND a.filename ~* '^hrcen_confirmation_letter_[0-9]{6,12}-[0-9]{1,2}\.pdf$'
    `;
    for (const row of filenameRows) {
      const match = CONFIRMATION_FILE_RE.exec(row.filename || '');
      if (match) {
        addKey(row, match[1], 'outbound_attachment_filename', 0.99);
        scan.attachment_filename_key_candidates += 1;
      }
    }


    const pdfStats = {
      enabled: input.params?.pdf_text_enabled !== false,
      candidates: 0,
      read_ok: 0,
      read_errors: 0,
      no_key: 0,
      rows_with_keys: 0,
      key_rows: 0,
      errors: [],
    };
    result.pdf_text = pdfStats;
    if (pdfStats.enabled) {
      const pdfCandidates = await sql`
        WITH ranked AS (
          SELECT
            a.attachment_id,
            a.message_id AS id,
            m.thread_id,
            a.filename,
            a.s3_key,
            a.sha256,
            a.size_bytes,
            row_number() OVER (
              PARTITION BY a.message_id, COALESCE(NULLIF(a.sha256, ''), a.attachment_id)
              ORDER BY a.attachment_id
            ) AS sha_rank
          FROM thanksgiving.attachment a
          JOIN thanksgiving.message m ON m.message_id = a.message_id
          WHERE m.direction = 'outbound'
            AND a.filename ILIKE '%confirmation%'
            AND a.filename !~* '^hrcen_confirmation_letter_[0-9]{6,12}-[0-9]{1,2}\.pdf$'
            AND (a.mime_type ILIKE '%pdf%' OR a.filename ILIKE '%.pdf')
            AND COALESCE(a.size_bytes, 0) <= 5242880
            AND NOT a.is_cut
        )
        SELECT attachment_id, id, thread_id, filename, s3_key, sha256, size_bytes
        FROM ranked
        WHERE sha_rank = 1
        ORDER BY attachment_id
      `;
      pdfStats.candidates = pdfCandidates.length;
      scan.pdf_candidates = pdfCandidates.length;
      if (pdfCandidates.length) {
        const bucket = process.env.S3_BUCKET;
        if (!bucket) throw new Error('S3_BUCKET missing in remote environment');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'af-south-1' });
        let nextIndex = 0;
        const workerCount = 4;
        const maxBytes = 5 * 1024 * 1024;
        const processPdf = async (row) => {
          const tmpPath = `/tmp/thanksgiving-p0p3-${row.attachment_id.replace(/[^A-Za-z0-9_.-]/g, '_')}.pdf`;
          try {
            const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.s3_key }));
            const chunks = [];
            let bytes = 0;
            for await (const chunk of object.Body) {
              bytes += chunk.length;
              if (bytes > maxBytes) throw new Error('pdf_too_large');
              chunks.push(chunk);
            }
            writeFileSync(tmpPath, Buffer.concat(chunks), { mode: 0o600 });
            const textResult = await execFileAsync('pdftotext', ['-f', '1', '-l', '3', '-layout', tmpPath, '-'], {
              timeout: 10000,
              maxBuffer: 2 * 1024 * 1024,
            });
            pdfStats.read_ok += 1;
            scan.pdf_read_ok += 1;
            const keys = confirmationKeysIn(textResult.stdout);
            if (!keys.length) {
              pdfStats.no_key += 1;
            } else {
              pdfStats.rows_with_keys += 1;
              for (const key of keys) {
                const before = keyMap.size;
                addKey(row, key, 'pdf_text', 0.85);
                if (keyMap.size > before) {
                  pdfStats.key_rows += 1;
                  scan.pdf_key_candidates += 1;
                }
              }
            }
          } catch (error) {
            pdfStats.read_errors += 1;
            scan.pdf_read_errors += 1;
            if (pdfStats.errors.length < 10) {
              pdfStats.errors.push({ attachment_id: row.attachment_id, ...cleanError(error) });
            }
          } finally {
            try { unlinkSync(tmpPath); } catch {}
          }
        };
        await Promise.all(Array.from({ length: workerCount }, async () => {
          while (nextIndex < pdfCandidates.length) {
            const index = nextIndex;
            nextIndex += 1;
            await processPdf(pdfCandidates[index]);
          }
        }));
      }
    }

    const allConfirmationRows = [...keyMap.values()];
    const donorRows = await sql`
      SELECT message_id, is_cut, cut_reason
      FROM thanksgiving.message
    `;
    const donorByMessage = new Map(donorRows.map((row) => [row.message_id, row]));
    const selfPrestayCutReasons = new Set(['hotel_self_prestay_confirmation', 'owner_prestay_form_only']);
    const donatesP3 = (row) => {
      const donor = donorByMessage.get(row.message_id);
      return Boolean(donor && (!donor.is_cut || selfPrestayCutReasons.has(donor.cut_reason)));
    };
    const donorRowsFiltered = allConfirmationRows.filter(donatesP3);
    let validHmsKeys;
    if (input.hmsRows?.length) {
      validHmsKeys = new Set(input.hmsRows.map((values) => values[0]));
    } else {
      const hmsKeyRows = await sql`SELECT confirmation_key FROM thanksgiving.hms_reservation WHERE is_active`;
      validHmsKeys = new Set(hmsKeyRows.map((row) => row.confirmation_key));
    }
    const confirmationRows = donorRowsFiltered.filter((row) => validHmsKeys.has(row.confirmation_key));
    await sql`UPDATE thanksgiving.confirmation_key SET is_active = false WHERE is_active`;
    const confirmationInserted = await bulkInsert({
      table: 'thanksgiving.confirmation_key',
      columns: ['message_id', 'thread_id', 'confirmation_key', 'source', 'confidence', 'is_active', 'run_id', 'extracted_at'],
      rows: confirmationRows,
      conflict: `ON CONFLICT (message_id, confirmation_key, source) DO UPDATE SET
        thread_id = EXCLUDED.thread_id,
        confidence = EXCLUDED.confidence,
        is_active = EXCLUDED.is_active,
        run_id = EXCLUDED.run_id,
        extracted_at = EXCLUDED.extracted_at`,
      batchSize: 500,
    });
    result.extraction = {
      rows_candidate_before_filters: allConfirmationRows.length,
      rows_rejected_cut_donor: allConfirmationRows.length - donorRowsFiltered.length,
      rows_rejected_not_in_hms: donorRowsFiltered.length - confirmationRows.length,
      rows_active_this_run: confirmationRows.length,
      rows_upserted: confirmationInserted,
      distinct_keys: new Set(confirmationRows.map((row) => row.confirmation_key)).size,
      threads_with_keys: new Set(confirmationRows.map((row) => row.thread_id)).size,
    };

    const columns = input.hmsColumns;
    const hmsRows = input.hmsRows.map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
    if (hmsRows.length) {
      const loadedAt = new Date().toISOString();
      const insertRows = hmsRows.map((row) => ({
        confirmation_key: row.confirmation_number,
        property_code: row.property_code,
        status: row.status,
        created_at: row.created_at,
        created_by: row.created_by,
        updated_at: row.updated_at,
        source_of_business: row.source_of_business,
        arrival_date: row.arrival_date,
        departure_date: row.departure_date,
        guest_name: row.guest_name,
        company: row.company,
        travel_agency_1: row.travel_agency_1,
        email_address: row.email_address,
        caller: row.caller,
        billing_reference: row.billing_reference,
        reservation_note: row.reservation_note,
        rate_plan: row.rate_plan,
        room_type: row.room_type,
        meal_plan: row.meal_plan,
        adults: row.adults,
        children: row.children,
        is_labtest: row.is_labtest === true,
        evidence_kind: row.evidence_kind,
        capture_completeness: row.capture_completeness,
        observed_at: row.observed_at,
        observation_id: row.observation_id,
        stable_payload_sha256: row.stable_payload_sha256,
        is_active: true,
        run_id: runId,
        loaded_at: loadedAt,
      }));
      await sql`UPDATE thanksgiving.hms_reservation SET is_active = false WHERE is_active`;
      const hmsInserted = await bulkInsert({
        table: 'thanksgiving.hms_reservation',
        columns: [
          'confirmation_key', 'property_code', 'status', 'created_at', 'created_by', 'updated_at',
          'source_of_business', 'arrival_date', 'departure_date', 'guest_name', 'company', 'travel_agency_1',
          'email_address', 'caller', 'billing_reference', 'reservation_note', 'rate_plan', 'room_type', 'meal_plan',
          'adults', 'children', 'is_labtest',
          'evidence_kind', 'capture_completeness', 'observed_at', 'observation_id', 'stable_payload_sha256',
          'is_active', 'run_id', 'loaded_at'
        ],
        rows: insertRows,
        conflict: `ON CONFLICT (property_code, confirmation_key) DO UPDATE SET
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          created_by = EXCLUDED.created_by,
          updated_at = EXCLUDED.updated_at,
          source_of_business = EXCLUDED.source_of_business,
          arrival_date = EXCLUDED.arrival_date,
          departure_date = EXCLUDED.departure_date,
          guest_name = EXCLUDED.guest_name,
          company = EXCLUDED.company,
          travel_agency_1 = EXCLUDED.travel_agency_1,
          email_address = EXCLUDED.email_address,
          caller = EXCLUDED.caller,
          billing_reference = EXCLUDED.billing_reference,
          reservation_note = EXCLUDED.reservation_note,
          rate_plan = EXCLUDED.rate_plan,
          room_type = EXCLUDED.room_type,
          meal_plan = EXCLUDED.meal_plan,
          adults = EXCLUDED.adults,
          children = EXCLUDED.children,
          is_labtest = EXCLUDED.is_labtest,
          evidence_kind = EXCLUDED.evidence_kind,
          capture_completeness = EXCLUDED.capture_completeness,
          observed_at = EXCLUDED.observed_at,
          observation_id = EXCLUDED.observation_id,
          stable_payload_sha256 = EXCLUDED.stable_payload_sha256,
          is_active = EXCLUDED.is_active,
          run_id = EXCLUDED.run_id,
          loaded_at = EXCLUDED.loaded_at`,
        batchSize: 350,
      });
      result.hms_load = {
        rows_input: hmsRows.length,
        rows_upserted: hmsInserted,
        evidence_counts: insertRows.reduce((acc, row) => {
          const key = `${row.evidence_kind || 'unknown'}:${row.capture_completeness || 'unknown'}`;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
      };
    } else {
      const [existingHms] = await sql`SELECT count(*)::int AS count FROM thanksgiving.hms_reservation WHERE is_active`;
      result.hms_load = { rows_input: 0, rows_upserted: 0, reused_existing: true, active_rows: existingHms.count };
    }

    await executeSql('004_p3_match.sql', input.sql.p3);
    await executeSql('005_metrics.sql', input.sql.metrics);

    result.metrics = await sql`
      SELECT metric_name, numerator, denominator, rate, details
      FROM thanksgiving.metric_snapshot
      WHERE run_id = ${runId}
      ORDER BY metric_name
    `;
    result.miss_samples = await sql`
      SELECT direction, ordinal, entity_id, confirmation_key, reason, details
      FROM thanksgiving.miss_sample
      WHERE run_id = ${runId}
      ORDER BY direction, ordinal
    `;
    const [counts] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM thanksgiving.message) AS messages,
        (SELECT count(*)::bigint FROM thanksgiving.attachment) AS attachments,
        (SELECT count(*)::bigint FROM thanksgiving.confirmation_key WHERE is_active) AS active_confirmation_key_rows,
        (SELECT count(*)::bigint FROM thanksgiving.hms_reservation WHERE is_active) AS active_hms_reservations,
        (SELECT count(*)::bigint FROM thanksgiving.thread_hms_match WHERE is_active) AS active_thread_hms_matches
    `;
    result.table_counts = counts;
    await sql`
      UPDATE thanksgiving.pipeline_run
      SET finished_at = now(), status = 'succeeded'
      WHERE run_id = ${runId}
    `;
    result.ok = true;
  } catch (error) {
    result.errors.push({ stage: 'remote_pipeline', ...cleanError(error) });
    try {
      await sql`
        UPDATE thanksgiving.pipeline_run
        SET finished_at = now(), status = 'failed'
        WHERE run_id = ${runId}
      `;
    } catch {}
  } finally {
    try { await sql.end({ timeout: 3 }); } catch {}
  }

  const packed = gzipSync(Buffer.from(JSON.stringify(result, jsonReplacer), 'utf8')).toString('base64');
  writeFileSync(OUTPUT_PATH, packed, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(JSON.stringify({
    ok: result.ok,
    output_path: OUTPUT_PATH,
    packed_chars: packed.length,
    packed_sha256: createHash('sha256').update(packed).digest('hex'),
    errors: result.errors.length,
  }) + '\n');
}

main().catch((error) => {
  const fallback = { ok: false, errors: [{ stage: 'startup', ...cleanError(error) }] };
  const packed = gzipSync(Buffer.from(JSON.stringify(fallback, jsonReplacer), 'utf8')).toString('base64');
  try {
    writeFileSync(OUTPUT_PATH, packed, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: false, output_path: OUTPUT_PATH, packed_chars: packed.length, errors: 1 }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, errors: 1 }) + '\n');
  }
});
