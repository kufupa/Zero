import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { aggregateFieldParity, buildNavaPrefill, linkConfirmationCandidates, normalizeSurname, scoreFieldParity, type ConfirmationTruthCandidate, type FieldParityField, type FieldParityValues, type ParityCause } from '../src/ai/field-parity.js';

const exec = promisify(execFile), APP = fileURLToPath(new URL('../', import.meta.url));
const PRIVATE = join(APP, '.private/hrdav-parity'), PAIRS = join(PRIVATE, 'pairs.json'), TRUTH = join(PRIVATE, 'truth.json');
const READER = join(APP, 'tooling/playwright-quote/read-reservation-fields.mjs');
const REPORT = resolve(APP, '../../docs/research/2026-10-28-hrdav-field-parity.md');
const MAILBOXES = "ARRAY['davinci','epick','fkhumalo','kmgidi','adladla']";
const CONFIRMATION = /\b\d{6,10}-\d{1,2}\b/g, CONTROL = '59898948-1', SERVICE_USER = 'NAVAAI';
type R = Record<string, any>;
type Pair = { id: string; messageId: string; threadId: string; receivedAt: string; email: string; subject: string | null; textBody: string | null; payload: R; action: string; surname: string | null; arrival: string | null; candidates: Array<{ confirmationNumber: string; messageId: string; threadId: string; receivedAt: string; sameThread: boolean }>; partyMatch: unknown; rateRun: unknown };
type PairFile = { schemaVersion: 1; generatedAt: string; rows: Pair[] };
type Reader = { conf: string; outcome: string; fields?: R; envelope?: unknown };
type TruthFile = { schemaVersion: 1; generatedAt: string; byConfirmation: Record<string, Reader> };
const rec = (v: unknown): R => v && typeof v === 'object' && !Array.isArray(v) ? v as R : {};
const text = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null;

function writePrivate(path: string, value: unknown): Promise<void> {
  return (async () => {
    await mkdir(PRIVATE, { recursive: true, mode: 0o700 }); await chmod(PRIVATE, 0o700);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(temp, 0o600);
    await rename(temp, path); await chmod(path, 0o600);
  })();
}
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;
const fold = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

async function pairs(): Promise<PairFile> {
  const url = process.env.DATABASE_URL?.trim(); if (!url) throw new Error('database_url_required_on_ec2');
  const db = postgres(url, { max: 1, connect_timeout: 10, ssl: getPostgresSslOptions(url) });
  try {
    const rows = await db.begin('read only', (tx) => tx.unsafe(`
      SELECT m.id AS "messageId", m.thread_id AS "threadId", m.received_at AS "receivedAt", m.subject,
        m.text_body AS "textBody", t.email, latest.payload, party.read_result AS "partyMatch",
        jsonb_build_object('prepared', COALESCE(rateRun.result, rate.ai_value), 'ratePick', rate.evidence->'ratePick') AS "rateRun",
        COALESCE(candidates.rows, '[]'::jsonb) AS candidates
      FROM message m JOIN mailbox_transport t ON t.id=m.transport_id
      JOIN LATERAL (SELECT e.payload FROM mail_extraction e WHERE e.message_id=m.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1) latest ON TRUE
      LEFT JOIN LATERAL (SELECT r.read_result FROM ai_workflow_run r WHERE r.trigger_message_id=m.id AND r.run_kind='read_tool' AND r.state='succeeded'
        AND r.read_request->>'kind'='party' AND r.read_request->>'matchVersion'='2' ORDER BY r.created_at DESC,r.id DESC LIMIT 1) party ON TRUE
      LEFT JOIN LATERAL (SELECT e.ai_value,e.evidence FROM work_event e JOIN work_item w ON w.id=e.work_item_id
        WHERE w.source_message_id=m.id AND w.transport_id=m.transport_id AND e.type='quote.prepared' ORDER BY e.at DESC,e.id DESC LIMIT 1) rate ON TRUE
      LEFT JOIN LATERAL (SELECT h.result FROM hitl_tool_run h WHERE h.message_id=m.id AND h.kind='quote' AND h.status='ok' ORDER BY h.started_at DESC,h.id DESC LIMIT 1) rateRun ON TRUE
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('messageId',c.id,'threadId',c.thread_id,'receivedAt',c.received_at,'subject',c.subject)) AS rows
        FROM message c JOIN mailbox_transport ct ON ct.id=c.transport_id
        WHERE c.received_at>m.received_at AND c.received_at<=m.received_at+interval '21 days' AND c.subject ~ '[0-9]{6,10}-[0-9]{1,2}'
          AND lower(split_part(ct.email,'@',2))='legacyhotels.co.za' AND lower(split_part(ct.email,'@',1))=ANY(${MAILBOXES})) candidates ON TRUE
      WHERE m.direction='inbound' AND m.received_at IS NOT NULL AND lower(split_part(t.email,'@',2))='legacyhotels.co.za'
        AND lower(split_part(t.email,'@',1))=ANY(${MAILBOXES}) AND latest.payload->>'action' IN ('new_booking','quote','quote_availability')
      ORDER BY m.received_at,m.id
    `)) as unknown as R[];
    const output: Pair[] = [];
    for (const row of rows) {
      const payload = rec(row.payload), action = text(payload.action) ?? '', stay = rec((Array.isArray(payload.stays) ? payload.stays : [])[0]);
      const guest = rec((Array.isArray(stay.guests) ? stay.guests : [])[0]);
      const surname = normalizeSurname(guest.name), arrival = text(rec(stay.requested).arrival);
      const candidates = (Array.isArray(row.candidates) ? row.candidates : []).flatMap((item: unknown) => {
        const c = rec(item), subject = text(c.subject); if (!subject || !surname || !(` ${fold(subject)} `).includes(` ${fold(surname)} `)) return [];
        return [...new Set(subject.match(CONFIRMATION) ?? [])].map((confirmationNumber) => ({ confirmationNumber, messageId: c.messageId, threadId: c.threadId, receivedAt: new Date(c.receivedAt).toISOString(), sameThread: c.threadId === row.threadId }));
      });
      const byConfirmation = new Map<string, typeof candidates[number]>();
      for (const candidate of candidates) {
        const previous = byConfirmation.get(candidate.confirmationNumber);
        if (!previous || (candidate.sameThread && !previous.sameThread) || (candidate.sameThread === previous.sameThread && candidate.receivedAt < previous.receivedAt)) byConfirmation.set(candidate.confirmationNumber, candidate);
      }
      const uniqueCandidates = [...byConfirmation.values()];
      if (action !== 'new_booking' && !uniqueCandidates.length) continue;
      output.push({ id: '', messageId: row.messageId, threadId: row.threadId, receivedAt: new Date(row.receivedAt).toISOString(), email: row.email,
        subject: row.subject, textBody: row.textBody, payload, action, surname: surname || null, arrival, candidates: uniqueCandidates,
        partyMatch: row.partyMatch, rateRun: row.rateRun?.prepared || row.rateRun?.ratePick ? row.rateRun : null });
    }
    output.forEach((row, i) => { row.id = `P${String(i + 1).padStart(3, '0')}`; });
    const result: PairFile = { schemaVersion: 1, generatedAt: new Date().toISOString(), rows: output };
    await writePrivate(PAIRS, result); return result;
  } finally { await db.end(); }
}

async function truthStage(): Promise<{ confirmations: number; cached: number; read: number }> {
  const source = await readJson<PairFile>(PAIRS);
  let cache: TruthFile;
  try { cache = await readJson<TruthFile>(TRUTH); if (cache.schemaVersion !== 1 || !rec(cache.byConfirmation)) throw new Error('invalid_truth_cache'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; cache = { schemaVersion: 1, generatedAt: new Date().toISOString(), byConfirmation: {} }; }
  const numbers = [...new Set(source.rows.flatMap((row) => row.candidates.map((c) => c.confirmationNumber)))], cachedAtStart = numbers.filter((n) => cache.byConfirmation[n]).length;
  let read = 0;
  for (let i = 0; i < numbers.length; i += 9) {
    const pending = numbers.slice(i, i + 9).filter((n) => !cache.byConfirmation[n]); if (!pending.length) continue;
    const dir = await mkdtemp(join(PRIVATE, '.reader-')), input = join(dir, 'input.json'), out = join(dir, 'truth.jsonl');
    try {
      await writeFile(input, JSON.stringify(pending), { mode: 0o600 });
      let failed = false;
      try { await exec(process.execPath, [READER, '--property', 'HRDAV', '--input', input, '--out', out, '--cap', '10'], { cwd: APP, env: process.env, maxBuffer: 2_000_000 }); }
      catch { failed = true; }
      let lines: Reader[] = [];
      try { lines = (await readFile(out, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Reader); } catch { /* reader failed before output */ }
      for (const row of lines) if (row.conf !== CONTROL || pending.includes(CONTROL)) { cache.byConfirmation[row.conf] = row; read++; }
      cache.generatedAt = new Date().toISOString(); await writePrivate(TRUTH, cache);
      if (failed) throw new Error('hrdav_reader_failed_check_ec2_runner_logs');
      for (const n of pending) if (!cache.byConfirmation[n]) cache.byConfirmation[n] = { conf: n, outcome: 'not_read' };
      await writePrivate(TRUTH, cache);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  await writePrivate(TRUTH, cache);
  return { confirmations: numbers.length, cached: cachedAtStart, read };
}

function hasKey(value: unknown, name: string): boolean {
  const row = rec(value), keys = Array.isArray(row.keys) ? row.keys : [];
  return keys.some((key) => String(key).toLowerCase() === name.toLowerCase()) || Object.values(rec(row.fields)).some((v) => hasKey(v, name));
}
function field(row: Reader, name: string): unknown { return name in rec(row.fields) ? row.fields![name] : hasKey(row.envelope, name) ? '' : undefined; }
function linkedCandidate(candidate: Pair['candidates'][number], read: Reader | undefined): ConfirmationTruthCandidate {
  const fields = rec(read?.fields), okay = read && ['read', 'thin'].includes(read.outcome);
  return { confirmationNumber: candidate.confirmationNumber, sameThread: candidate.sameThread,
    truth: okay ? { lastname: field(read, 'lastname'), arrivaldate: field(read, 'arrivaldate'), createdby: field(read, 'createdby'), fields, envelope: read.envelope } : null };
}
function scoreTruth(accepted: ReturnType<typeof linkConfirmationCandidates>['accepted']): FieldParityValues {
  const rows = accepted.map((c) => rec(c.truth)), first = rows[0] ?? {}, firstRead: Reader = { conf: '', outcome: 'read', fields: rec(first.fields), envelope: first.envelope };
  const out: FieldParityValues = {}, stay: Array<[FieldParityField, string]> = [
    ['agency','ta1'],['guaranteeType','guaranteetype'],['arrivalDate','arrivaldate'],['departureDate','departuredate'],['mealPlan','mealplan'],
    ['marketSegment','marketsegment'],['sourceOfBusiness','sourceofbusinessdesc'],['track','track'],['cmsSendMail','udfchkbox04'],['cmsMessageId','udfchar09'],['bookerEmail','udfchar13'],
  ];
  for (const [key, name] of stay) { const v = field(firstRead, name); if (v !== undefined) out[key] = v; }
  for (const [key, name] of [['roomType','roomtype'],['ratePlan','rateplan'],['adults','adults']] as Array<[FieldParityField,string]>) {
    const vals = rows.map((r) => field({ conf: '', outcome: 'read', fields: rec(r.fields), envelope: r.envelope }, name)); if (vals.some((v) => v !== undefined)) out[key] = vals;
  }
  const children = rows.map((r) => {
    const room: R = {}; for (const key of ['child1','child2','child3']) { const v = field({ conf: '', outcome: 'read', fields: rec(r.fields), envelope: r.envelope }, key); if (v !== undefined) room[key] = text(v) ?? 0; }
    return Object.keys(room).length ? room : undefined;
  });
  if (children.some(Boolean)) out.children = children;
  const note = field(firstRead, 'reservationnote'); if (note !== undefined) out.reservationNote = Boolean(text(note));
  return out;
}

function table(rows: Array<{ field: FieldParityField; n: number; hit: number; miss: number; excluded: number; causes: Record<ParityCause, number> }>): string[] {
  return ['| Field | n | hit | miss | excluded | causes |','| --- | ---: | ---: | ---: | ---: | --- |', ...rows.map((r) => `| ${r.field} | ${r.n} | ${r.hit} | ${r.miss} | ${r.excluded} | extract=${r.causes.extract}; lookup=${r.causes.lookup}; default=${r.causes.default}; not_in_email=${r.causes.not_in_email}; truth_drift=${r.causes.truth_drift} |`)];
}

async function scoreStage() {
  const [source, truth] = await Promise.all([readJson<PairFile>(PAIRS), readJson<TruthFile>(TRUTH)]), results = [];
  let unlinked = 0, labtest = 0, navaCreated = 0;
  for (const pair of source.rows) {
    const candidates = pair.candidates.map((c) => linkedCandidate(c, truth.byConfirmation[c.confirmationNumber]));
    const linked = linkConfirmationCandidates({ surname: pair.surname ?? '', arrival: pair.arrival ?? '', candidates, serviceUser: SERVICE_USER });
    if (!linked.accepted.length) { unlinked++; if (linked.excluded === 'labtest') labtest++; if (linked.excluded === 'nava_created') navaCreated++; continue; }
    const built = await buildNavaPrefill({ propertyCode: 'HRDAV', payload: pair.payload, partyMatch: pair.partyMatch, preparedRateRun: pair.rateRun, emailText: pair.textBody });
    results.push(scoreFieldParity({ id: pair.id, source: built.source, nava: built.nava, truth: scoreTruth(linked.accepted), provenance: built.provenance,
      partyBound: built.partyBound, mailbox: pair.email.toLowerCase().startsWith('fkhumalo@') ? 'faith' : 'other' }));
  }
  const aggregate = aggregateFieldParity(results), generated = new Date().toISOString();
  const text = [
    '# HRDAV field parity','',`Generated: ${generated}`,'',`Linked: ${results.length}; unlinked: ${unlinked}; excluded Labtest: ${labtest}; excluded Nava-created: ${navaCreated}.`,'',
    '## Overall','',...table(aggregate.fields),'','## CMS Message Id','','| Cohort | n | hit |','| --- | ---: | ---: |',
    `| agency-bound | ${aggregate.cmsMessageIdMix.agencyBound.n} | ${aggregate.cmsMessageIdMix.agencyBound.hit} |`,`| direct | ${aggregate.cmsMessageIdMix.direct.n} | ${aggregate.cmsMessageIdMix.direct.hit} |`,'',
    '## Guarantee-type mix','','| Type | count |','| --- | ---: | ---: |',...Object.entries(aggregate.guaranteeTypeMix).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `| ${k} | ${v} |`),'',
    '## Faith mailbox','',`Pairs: ${aggregate.faithMailbox.pairs}`,'',...table(aggregate.faithMailbox.fields),'','No names, email addresses, confirmation numbers, message IDs, or raw values are included.','',
  ].join('\n');
  await mkdir(dirname(REPORT), { recursive: true }); await writeFile(REPORT, text, { mode: 0o600 }); await chmod(REPORT, 0o600);
  console.log(JSON.stringify({ inputPairs: source.rows.length, linked: results.length, unlinked, excluded: { labtest, navaCreated }, aggregate }, null, 2));
}

async function main() {
  const [stage, ...extra] = process.argv.slice(2);
  if (extra.length || !['pairs','truth','score'].includes(stage ?? '')) { console.error('usage: hrdav-field-parity.ts <pairs|truth|score>'); process.exitCode = 2; return; }
  if (stage === 'pairs') { const result = await pairs(); console.log(JSON.stringify({ stage, rows: result.rows.length, confirmations: new Set(result.rows.flatMap((r) => r.candidates.map((c) => c.confirmationNumber))).size })); }
  else if (stage === 'truth') console.log(JSON.stringify({ stage, ...await truthStage() }));
  else { await scoreStage(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : 'unknown_error';
  const safe = new Set(['database_url_required_on_ec2','invalid_truth_cache','hrdav_reader_failed_check_ec2_runner_logs','field_parity_id_must_be_sanitized','hrdav_room_options_unavailable']);
  console.error(safe.has(message) ? message : 'hrdav_field_parity_failed_redacted'); process.exitCode = 1;
});
