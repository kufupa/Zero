import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const hard = new Set(['agency_name', 'organization_name', 'rate_plan', 'room_type', 'guarantee_type', 'billing_reference']);
const nativeNames = {
  agency_name: 'ta1', organization_name: 'company', rate_plan: 'rateplan', room_type: 'roomtype',
  guarantee_type: 'guaranteetype', billing_reference: 'billingreference', arrival_date: 'arrivaldate',
  departure_date: 'departuredate', first_name: 'firstname', last_name: 'lastname', adults: 'adults', board: 'mealplan',
};
type Field = keyof typeof nativeNames;
const fields = Object.keys(nativeNames).filter((key): key is Field => Object.hasOwn(nativeNames, key));
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? {...value} : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const bookings = (draft: unknown) => list(object(draft).bookings).map(object);
type Row = {
  workflow: string; created_at: Date; mode: string; initial: unknown; current: unknown; result: unknown;
  edit_paths: string[]; recent_edits: number; go_count: number;
  /** Optional existing-event markers for U9 funnel (null = unobserved, not failure). */
  stage_finished?: boolean | null;
  quote_artifacts_ready?: boolean | null;
  go_finished?: boolean | null;
  filtered?: boolean | null;
  disposition?: string | null;
};
const WORKFLOWS = ['create', 'quote', 'amend', 'cancel', 'filing', 'triage'] as const;
const day = 86_400_000;
const metric = (n: number, d: number) => ({n, d, rate: d ? n / d : null});
const STQN = /^STQN$/i;

/** Six-workflow existing-event funnel. Missing event evidence → null rate (N/A), never inferred success. */
export function workflowEventFunnel(rows: Row[]) {
  const empty = () => ({
    received: 0, filtered: 0, proposal_or_no_action: 0, eligible_stage: 0,
    stage_finished: 0, stage_finished_observed: 0,
    go_claimed: 0, go_finished: 0, go_finished_observed: 0,
    quote_artifacts_ready: 0, quote_artifacts_observed: 0,
    triage_terminal: 0,
  });
  const by = Object.fromEntries(WORKFLOWS.map(w => [w, empty()])) as Record<string, ReturnType<typeof empty>>;
  for (const row of rows) {
    const slot = by[row.workflow] ?? (by[row.workflow] = empty());
    slot.received += 1;
    if (row.filtered === true) {
      slot.filtered += 1;
      continue;
    }
    slot.proposal_or_no_action += 1;
    const disposition = row.disposition ?? String(object(row.initial).disposition ?? '');
    if (row.workflow === 'triage') {
      slot.triage_terminal += Number(disposition === 'skip' || disposition === 'propose'
        || disposition === 'staff_review' || disposition === 'needs_info' || disposition === 'decline');
      continue;
    }
    const write = row.workflow !== 'quote';
    if (row.workflow === 'quote' || disposition === 'propose' || disposition === 'staff_review' || disposition === 'needs_info') {
      slot.eligible_stage += 1;
    }
    if (row.stage_finished != null) {
      slot.stage_finished_observed += 1;
      slot.stage_finished += Number(row.stage_finished);
    }
    if (row.workflow === 'quote') {
      if (row.quote_artifacts_ready != null) {
        slot.quote_artifacts_observed += 1;
        slot.quote_artifacts_ready += Number(row.quote_artifacts_ready);
      }
      continue;
    }
    if (write) {
      // Count claim events as 0/1 per proposal — never go_count / proposals (can exceed 1.0).
      slot.go_claimed += Number(row.go_count > 0);
      if (row.go_finished != null) {
        slot.go_finished_observed += 1;
        slot.go_finished += Number(row.go_finished);
      }
      // Missing go_finished stays unobserved — never infer success from savedRooms alone.
    }
  }
  return Object.fromEntries(WORKFLOWS.map(workflow => {
    const s = by[workflow];
    const na = (label: string) => ({label, n: null as number | null, d: null as number | null, rate: null as number | null});
    return [workflow, {
      received: s.received,
      filtered: s.filtered,
      proposal_or_no_action: s.proposal_or_no_action,
      eligible_stage: s.eligible_stage,
      stage_finished: s.stage_finished_observed
        ? metric(s.stage_finished, s.stage_finished_observed)
        : na('stage_finished unobserved'),
      go_claimed: workflow === 'quote' || workflow === 'triage' ? na('go N/A') : metric(s.go_claimed, s.proposal_or_no_action),
      go_finished: workflow === 'quote' || workflow === 'triage' ? na('go N/A')
        : s.go_finished_observed ? metric(s.go_finished, s.go_finished_observed) : na('go_finished unobserved'),
      quote_artifacts_ready: workflow === 'quote'
        ? (s.quote_artifacts_observed ? metric(s.quote_artifacts_ready, s.quote_artifacts_observed) : na('quote_artifacts unobserved'))
        : na('quote N/A'),
      triage_terminal: workflow === 'triage' ? metric(s.triage_terminal, s.proposal_or_no_action) : na('triage N/A'),
    }];
  }));
}
function value(field: Field, input: unknown) {
  const s = typeof input === 'string' || typeof input === 'number' ? String(input).trim() : '';
  if (field === 'arrival_date' || field === 'departure_date') {
    const date = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(s);
    const month = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').indexOf(date?.[2]?.toUpperCase() ?? '');
    if (date && month >= 0) return `${date[3]}-${String(month + 1).padStart(2, '0')}-${date[1]}`;
  }
  return s;
}
function observed(readback: unknown, field: Field) {
  const matches = list(object(readback).fields).map(object).filter(f => f.name === nativeNames[field]);
  const v = matches[0]?.value;
  return matches.length === 1 && (v === null || typeof v === 'string' || typeof v === 'number') ? v : undefined;
}
const proof = (f: unknown) => /^proof$/i.test(String(object(f).first_name ?? '').trim())
  && /^labtest$/i.test(String(object(f).last_name ?? '').trim());
function savedRooms(row: Row) {
  const result = object(row.result), rooms = list(result.rooms).map(object);
  if (rooms.length) return rooms.filter(r => r.state === 'saved' && r.readback != null);
  return result.readback != null && !Array.isArray(result.readback) && result.confirmation && bookings(row.current).length === 1
    ? [{booking_id: bookings(row.current)[0]?.id, readback: result.readback}] : [];
}
const isProofReadback = (readback: unknown) =>
  proof({first_name: observed(readback, 'first_name'), last_name: observed(readback, 'last_name')});
const isLabtest = (row: Row) => row.mode === 'labtest' ||
  [...bookings(row.initial), ...bookings(row.current)].some(b => proof(b.fields)) ||
  savedRooms(row).some(r => isProofReadback(r.readback));
type Options = { days: number; property: string; includeLabtest: boolean; now: Date; gitSha: string; synthetic?: boolean };

export function scoreShadow(rows: Row[], options: Options) {
  const time = options.now.getTime();
  const recent = rows.filter(r => !isLabtest(r) && r.created_at.getTime() <= time);
  const real_proposals_24h = recent.filter(r => r.created_at.getTime() >= time - day).length;
  const real_edits_24h = recent.reduce((sum, r) => sum + r.recent_edits, 0);
  const window = rows.filter(r => r.created_at.getTime() >= time - options.days * day && r.created_at.getTime() <= time);
  const selected = window.filter(r => options.includeLabtest || !isLabtest(r));
  const workflow = new Map(['create', 'quote', 'amend', 'cancel', 'filing', 'triage'].map(w => [w, 0]));
  const disposition = new Map<string, number>();
  const counts = fields.map(field => ({field, saved: 0, savedHits: 0, editedOnly: 0, editedHits: 0, edits: 0, eligible: 0, blank: 0}));
  const go = {real_guest: 0, labtest: 0};
  let n_real_guest_saves = 0, n_labtest_saves = 0, staff_edit_count = 0, cohort_a_create_proposals = 0, initial_create_rooms = 0;
  // STQN application default: corrections among proposals where STQN was shown (Create-only).
  let stqn_shown = 0, stqn_changed = 0;
  for (const row of window) {
    const lab = isLabtest(row), rooms = savedRooms(row);
    for (const room of rooms) {
      const guest = bookings(row.current).find(b => b.id === room.booking_id)?.fields;
      if (row.mode === 'labtest' || isProofReadback(room.readback) || proof(guest)) n_labtest_saves++;
      else n_real_guest_saves++;
    }
    go[lab ? 'labtest' : 'real_guest'] += row.go_count;
  }
  for (const row of selected) {
    workflow.set(row.workflow, (workflow.get(row.workflow) ?? 0) + 1);
    const d = String(object(row.initial).disposition ?? 'unknown');
    disposition.set(d, (disposition.get(d) ?? 0) + 1);
    staff_edit_count += row.edit_paths.length;
    if (row.workflow !== 'create') continue;
    const initial = bookings(row.initial), current = bookings(row.current), saved = savedRooms(row);
    const cohort = row.edit_paths.some(path => path.startsWith('/bookings/')) || saved.length > 0;
    if (cohort) cohort_a_create_proposals++;
    initial_create_rooms += initial.length;
    for (const before of initial) {
      const finalIndex = current.findIndex(b => b.id === before.id);
      const after = object(current[finalIndex]?.fields);
      const readback = saved.find(r => r.booking_id === before.id)?.readback;
      const originalRoom = value('room_type', object(before.fields).room_type);
      if (STQN.test(originalRoom)) {
        stqn_shown += 1;
        const editedRoom = row.edit_paths.includes(`/bookings/${finalIndex}/fields/room_type`) && finalIndex >= 0;
        const afterRoom = value('room_type', after.room_type);
        const readbackRoom = observed(readback, 'room_type');
        const finalRoom = readbackRoom !== undefined ? value('room_type', readbackRoom) : afterRoom;
        if (editedRoom && finalRoom && !STQN.test(finalRoom)) stqn_changed += 1;
      }
      for (const c of counts) {
        const original = value(c.field, object(before.fields)[c.field]);
        if (!original) c.blank++;
        if (!cohort) continue;
        c.eligible++;
        const edited = row.edit_paths.includes(`/bookings/${finalIndex}/fields/${c.field}`) && finalIndex >= 0;
        if (edited) c.edits++;
        const actual = observed(readback, c.field);
        if (actual !== undefined) {
          c.saved++;
          if (original === value(c.field, actual)) c.savedHits++;
        } else if (edited && readback === undefined) {
          c.editedOnly++;
          if (original === value(c.field, after[c.field])) c.editedHits++;
        }
      }
    }
  }
  return {
    timestamp: options.now.toISOString(), property: options.property, days: options.days, git_sha: options.gitSha,
    synthetic: options.synthetic ?? false, includes_labtest: options.includeLabtest, n_proposals: selected.length,
    n_real_guest_saves, n_labtest_saves, real_proposals_24h, real_edits_24h,
    zero_staff_activity_alert: real_proposals_24h === 0 || real_edits_24h === 0,
    cohort_a_create_proposals, initial_create_rooms, workflow: Object.fromEntries(workflow),
    disposition: Object.fromEntries(disposition), staff_edit_count, go,
    stqn_default_corrections: metric(stqn_changed, stqn_shown),
    workflow_funnel: workflowEventFunnel(selected),
    fields: counts.map(c => ({field: c.field, saved_exact: metric(c.savedHits, c.saved),
      edited_only_exact: metric(c.editedHits, c.editedOnly), staff_edit_rate: metric(c.edits, c.eligible),
      initial_blank_rate: hard.has(c.field) ? metric(c.blank, initial_create_rooms) : null})),
  };
}

export function shadowMarkdown(s: ReturnType<typeof scoreShadow>) {
  const fmt = (m: ReturnType<typeof metric> | null) => !m || m.rate === null ? '—' : `${m.n}/${m.d} (${(100 * m.rate).toFixed(1)}%)`;
  const counts = (map: Record<string, number>) => Object.entries(map).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
  return [
    `# Daily Live Shadow Scoreboard${s.synthetic ? ' (synthetic dry run)' : ''}`, '',
    `${s.timestamp} · ${s.property} · ${s.days} days · git_sha: ${s.git_sha} · Labtest ${s.includes_labtest ? 'included' : 'excluded'} from cohorts`,
    `n_proposals: ${s.n_proposals} · n_real_guest_saves: ${s.n_real_guest_saves} · n_labtest_saves: ${s.n_labtest_saves} (confirmed Create stays)`, '',
    `${s.zero_staff_activity_alert ? '**ALERT: ZERO STAFF ACTIVITY** — ' : ''}Last 24h: ${s.real_proposals_24h} real proposals, ${s.real_edits_24h} real field edits.`, '',
    `**A. Staff-edited / Go-saved:** ${s.cohort_a_create_proposals} Create proposals. Saved exact uses observed HMS values; edit-only exact uses staff-touched fields without a saved readback.`, '',
    '| Create field | Saved exact | Edit-only exact | Staff edit rate | Initial blank (B) |',
    '|---|---:|---:|---:|---:|',
    ...s.fields.map(f => `| ${f.field} | ${fmt(f.saved_exact)} | ${fmt(f.edited_only_exact)} | ${fmt(f.staff_edit_rate)} | ${fmt(f.initial_blank_rate)} |`), '',
    `STQN default corrections (changed/shown among Create rooms where STQN displayed): ${fmt(s.stqn_default_corrections)}.`, '',
    `**B. Live telemetry:** ${counts(s.workflow)}. Disposition: ${counts(s.disposition)}.`,
    `Staff field edits: ${s.staff_edit_count}. Go claims (including excluded Labtest): ${s.go.real_guest} real, ${s.go.labtest} Labtest.`, '',
    '**C. Proposal event coverage** (any revision; rates for stage/finish/artifact events use only proposals with observed events. Raw mail, upstream filters and native correctness are not measured here):', '',
    '| Workflow | proposal rows | proposal/no-action | stage_finished | go_claimed | go_finished | quote_artifacts | triage_terminal |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...WORKFLOWS.map(w => {
      const f = s.workflow_funnel[w];
      const cell = (m: {n: number | null; d: number | null; rate: number | null; label?: string} | ReturnType<typeof metric>) =>
        m.n === null || m.d === null ? ('label' in m && m.label ? m.label : 'N/A') : fmt(m as ReturnType<typeof metric>);
      return `| ${w} | ${f.received} | ${f.proposal_or_no_action} | ${cell(f.stage_finished)} | ${cell(f.go_claimed)} | ${cell(f.go_finished)} | ${cell(f.quote_artifacts_ready)} | ${cell(f.triage_terminal)} |`;
    }), '',
  ].join('\n');
}

export async function readShadowRows(options: Options): Promise<Row[]> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required outside --dry-run');
  const {default: postgres} = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL, {max: 1});
  const end = options.now.toISOString(), start = new Date(options.now.getTime() - options.days * day).toISOString();
  const recent = new Date(options.now.getTime() - day).toISOString();
  try {
    return await sql.begin('read only', tx => tx<Row[]>`
      SELECT p.workflow, p.created_at, s.mode, p.original AS initial, p.current, p.result,
        coalesce(e.paths, ARRAY[]::text[]) AS edit_paths, e.recent AS recent_edits,
        g.n AS go_count, g.stage_finished, g.go_finished, g.quote_artifacts_ready
      FROM nava_agent.proposal p
      JOIN nava_agent.mail_thread t ON t.id = p.thread_id
      JOIN nava_agent.agent_session s ON s.id = p.session_id
      CROSS JOIN LATERAL (
        SELECT array_agg(path) AS paths, count(*) FILTER (WHERE at >= ${recent})::int AS recent
        FROM nava_agent.staff_edit WHERE proposal_id = p.id AND kind = 'edit' AND path IS NOT NULL AND at <= ${end}
      ) e
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE ev.kind='go_claimed')::int AS n,
          bool_or(ev.payload->>'ok'='true') FILTER (WHERE ev.kind='stage_finished' AND ev.payload->>'ok' IN ('true','false')) AS stage_finished,
          bool_or(ev.payload->>'outcome'='saved') FILTER (WHERE ev.kind='go_finished' AND ev.payload->>'outcome' IN ('saved','failed','uncertain')) AS go_finished,
          bool_or(true) FILTER (WHERE ev.kind='quote_artifacts_ready') AS quote_artifacts_ready
        FROM nava_agent.agent_event ev
        WHERE ev.session_id=p.session_id AND ev.payload->>'proposal_id'=p.id AND ev.at>=p.created_at AND ev.at<=${end}
          AND ev.kind IN ('stage_finished','go_claimed','go_finished','quote_artifacts_ready')
      ) g
      WHERE t.property_code = ${options.property} AND s.mode IN ('live', 'labtest')
        AND s.config->>'replay_id' IS NULL AND (s.mode = 'labtest' OR t.source IN ('outlook', 'webmail'))
        AND p.created_at <= ${end} AND (p.created_at >= ${start} OR p.created_at >= ${recent} OR e.recent > 0)
    `);
  } finally { await sql.end(); }
}

function gitSha() {
  for (const path of [new URL('../../../COMMIT_SHA', import.meta.url), './COMMIT_SHA']) {
    try { const sha = readFileSync(path, 'utf8').trim(); if (sha) return sha; } catch { /* Local checkout. */ }
  }
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: new URL('.', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
  catch { return 'unknown'; }
}

function selfCheck(options: Options) {
  const draft = (name: string, rate: string, last = 'Guest') => ({disposition: 'propose',
    bookings: [{id: 'room', fields: {first_name: name, last_name: last, rate_plan: rate, arrival_date: '2027-01-02'}}]});
  const row = (initial: unknown, current: unknown, result: unknown, edited = false): Row => ({
    workflow: 'create', created_at: options.now, mode: 'live', initial, current, result,
    edit_paths: edited ? ['/bookings/0/fields/rate_plan'] : [], recent_edits: Number(edited), go_count: Number(result !== null),
  });
  const saved = (rate: string) => ({confirmation: 'synthetic', readback: {fields: [
    {name: 'rateplan', value: rate}, {name: 'arrivaldate', value: '02-JAN-2027'},
  ]}});
  const rows = [row(draft('A', 'BAR'), draft('A', 'BAR'), saved('CORP')),
    row(draft('B', 'BAR'), draft('B', 'BAR'), saved('BAR')),
    row(draft('C', ''), draft('C', 'BAR'), null, true),
    row(draft('Proof', 'BAR', 'Labtest'), draft('Proof', 'BAR', 'Labtest'), saved('BAR'))];
  const baseline = scoreShadow(rows, {...options, includeLabtest: false});
  const rate = baseline.fields.find(f => f.field === 'rate_plan');
  assert.deepEqual(rate, {field: 'rate_plan', saved_exact: metric(1, 2), edited_only_exact: metric(0, 1),
    staff_edit_rate: metric(1, 3), initial_blank_rate: metric(1, 3)});
  assert.deepEqual(baseline.fields.find(f => f.field === 'arrival_date')?.saved_exact, metric(2, 2));
  assert.deepEqual(baseline.fields.find(f => f.field === 'board')?.saved_exact, metric(0, 0));
  assert.deepEqual([baseline.n_proposals, baseline.n_real_guest_saves, baseline.n_labtest_saves, baseline.go.labtest], [3, 2, 1, 1]);
  assert.equal(baseline.zero_staff_activity_alert, false);
  assert.deepEqual(baseline.stqn_default_corrections, metric(0, 0));
  assert.equal(baseline.workflow_funnel.create.received, 3);
  assert.equal(baseline.workflow_funnel.triage.triage_terminal.rate, null);
  assert.equal(baseline.workflow_funnel.quote.quote_artifacts_ready.n, null);
  assert.equal(scoreShadow(rows.slice(0, 1), options).zero_staff_activity_alert, true);
  assert.equal(scoreShadow(rows, {...options, includeLabtest: true}).n_proposals, 4);
  const partial = row(draft('A', 'BAR'), draft('A', 'BAR'), {rooms: [
    {booking_id: 'room', state: 'saved', readback: saved('BAR').readback},
    {booking_id: 'other', state: 'uncertain', readback: saved('BAR').readback},
  ]});
  const oldEdit = {...rows[2]!, created_at: new Date(options.now.getTime() - (options.days + 1) * day)};
  const batch = scoreShadow([partial, oldEdit], options);
  assert.deepEqual([batch.n_proposals, batch.n_real_guest_saves, batch.real_edits_24h, batch.zero_staff_activity_alert],
    [1, 1, 1, false]);
  return scoreShadow(rows, options);
}

async function main() {
  const {values} = parseArgs({options: {
    days: {type: 'string', default: '7'}, property: {type: 'string', default: 'HRCEN'},
    'include-labtest': {type: 'boolean'}, json: {type: 'string'}, md: {type: 'string'}, 'dry-run': {type: 'boolean'},
  }});
  const days = Number(values.days);
  if (!Number.isSafeInteger(days) || days <= 0 || !Number.isFinite(new Date(Date.now() - days * day).getTime()))
    throw new Error('--days must be a positive integer within the date range');
  const options = {days, property: (values.property ?? 'HRCEN').trim().toUpperCase(), includeLabtest: values['include-labtest'] ?? false,
    now: new Date(), gitSha: gitSha(), synthetic: values['dry-run'] ?? false};
  const score = options.synthetic ? selfCheck(options) : scoreShadow(await readShadowRows(options), options);
  const markdown = shadowMarkdown(score);
  if (values.json) writeFileSync(values.json, JSON.stringify(score, null, 2) + '\n');
  if (values.md) writeFileSync(values.md, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
