/**
 * Pure collectors for gold-fact live packs.
 * Default method (2026-09-14): reuse session + context.request parallel finds +
 * drain-before-recycle + no soft-open recycle on 813.
 */

export const GOLD_FACT_LIVE_METHOD = {
  id: 'session_reuse_request_parallel_drain_before_recycle',
  sessionMode: 'reuse',
  findVia: 'context.request',
  /**
   * Real OSRESS.search (non-empty grids): one concurrent wave then session often
   * 813-poisons. Live probe 2026-09-14: P=16/24/32 all OK wave0, cliff wave1.
   * Synthetic empty RAMP searches held 2×P=32 — do not use that for budget.
   */
  parallelDefault: 32,
  /** Recycle after one real concurrent wave (≈PARALLEL finds). */
  searchBudgetDefault: 32,
  softOpenRecycleOn813: false,
  drainInflightBeforeRecycle: true,
  /**
   * Find-only ETA @3949 (login≈40s + wave≈4s per 32): ~⌈3949/32⌉×44s ≈ 90min.
   * Soft-opens: page.evaluate + HDR warm + conf/stayId bind; relogin every soft-open
   * (live 2026-09-15: 82 hits → folioOk 81 / notesOk 74 in ~62min with find).
   * context.request soft-open after concurrent find wave → near-total 813.
   */
  findOnlyEtaNote: 'real_wave_p32_then_recycle_~90min_for_3949',
  softOpenViaDefault: 'evaluate',
  softOpenReloginEveryDefault: 1,
  softOpenEtaNote: 'login_dominated_~40s_per_hit_at_relogin_every_1',
};

const HIT_STATUSES = new Set(['ok', 'partial', 'ambiguous']);

/** Bucket a tool dump into funnel counters (no PII). */
export function classifyToolDump(toolId, dump) {
  if (!dump || typeof dump !== 'object') {
    return { bucket: 'tool_missing', parseOk: false, hit: false, stub813: false };
  }
  const status = String(dump.status ?? (dump.ok === true ? 'ok' : dump.ok === false ? 'false' : ''));
  const parse = dump.parse;
  const responseClass = dump.responseClass;
  const bytes = dump.searchBytes;
  const stub813 =
    responseClass === 'loadLocalized' ||
    status === 'loadLocalized' ||
    (typeof bytes === 'number' && bytes > 0 && bytes < 1000 && parse && parse !== 'ok');

  if (status === 'skipped_no_candidate' || status === 'skipped_need_find' || status === 'skipped_no_room_codes') {
    return { bucket: status, parseOk: false, hit: false, stub813: false };
  }
  if (stub813) return { bucket: 'stub_813', parseOk: false, hit: false, stub813: true };
  if (status === 'error' || status === 'login') {
    return { bucket: status === 'login' ? 'login' : 'error', parseOk: false, hit: false, stub813: false };
  }
  if (parse === 'ok' || responseClass === 'pagedata') {
    const hit = HIT_STATUSES.has(status);
    return { bucket: hit ? 'hit' : status || 'pagedata', parseOk: true, hit, stub813: false };
  }
  if (status === 'ok' || status === 'not_found' || status === 'mismatch' || status === 'no_attachments') {
    return {
      bucket: status,
      parseOk: status === 'ok' || status === 'not_found',
      hit: HIT_STATUSES.has(status),
      stub813: false,
    };
  }
  if (dump.ok === true) return { bucket: 'ok', parseOk: true, hit: true, stub813: false };
  return { bucket: status || 'unknown', parseOk: false, hit: false, stub813: false };
}

export function emptyFunnel() {
  return {
    attempted: 0,
    hit: 0,
    pagedata: 0,
    not_found: 0,
    error: 0,
    stub_813: 0,
    login: 0,
    skipped_no_candidate: 0,
    skipped_need_find: 0,
    skipped_no_room_codes: 0,
    mismatch: 0,
    ok: 0,
    tool_missing: 0,
    unknown: 0,
    ms_sum: 0,
  };
}

export function observeFunnel(funnel, toolId, dump) {
  const next = { ...funnel };
  const { bucket, parseOk, hit, stub813 } = classifyToolDump(toolId, dump);
  next.attempted += 1;
  if (parseOk) next.pagedata += 1;
  if (hit) next.hit += 1;
  if (stub813) next.stub_813 += 1;
  // hit/pagedata/stub_813 are derived flags — don't double-count as bucket keys
  const skipBucket = bucket === 'hit' || bucket === 'stub_813';
  if (!skipBucket) {
    if (bucket in next) next[bucket] += 1;
    else next.unknown += 1;
  }
  if (typeof dump?.ms === 'number' && dump.ms >= 0) next.ms_sum += dump.ms;
  return next;
}

/**
 * Find → child cascade: separates child tool failure from find starvation.
 */
export function buildCascade(findDump, children = {}) {
  const findStatus = findDump?.status ?? null;
  const findHit = HIT_STATUSES.has(String(findStatus));
  const findKey = Boolean(findDump?.confirmation || findDump?.stayId);
  const out = {
    find_status: findStatus,
    find_hit: findHit,
    find_key_present: findKey,
    find_parse: findDump?.parse ?? null,
    find_responseClass: findDump?.responseClass ?? null,
    find_via: findDump?.findVia ?? null,
    children: {},
  };
  for (const [toolId, dump] of Object.entries(children)) {
    const status = dump?.status ?? null;
    const skippedNeedFind = status === 'skipped_need_find';
    out.children[toolId] = {
      status,
      skipped_need_find: skippedNeedFind,
      cascade: !findHit && skippedNeedFind ? 'starved_by_find' : findHit && skippedNeedFind ? 'unexpected_skip' : status || 'missing',
      via: dump?.via ?? dump?.findVia ?? null,
      ms: dump?.ms ?? null,
    };
  }
  return out;
}

/** When find hits, deepen collection with folio/notes soft-opens even if agent omitted them. */
export function picksWithForcedChildren(picks, findDump, { force = true } = {}) {
  if (!force) return [...picks];
  const findHit = HIT_STATUSES.has(String(findDump?.status));
  const findKey = Boolean(findDump?.confirmation || findDump?.stayId);
  if (!findHit || !findKey) return [...picks];
  const next = new Set(picks);
  next.add('hms_read_folio');
  next.add('hms_read_notes_traces');
  return [...next];
}

export function archiveRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Claim-oriented fact rows (stable claimKeys) layered on top of legacy scoreFacts.
 */
export function scoreClaimKeys({ gold, toolDumps, picks, cascade }) {
  const rows = [];
  const goldConfs = gold?.confirmation_candidates || [];
  const goldDates = gold?.date_strings || [];
  const find = toolDumps?.hms_find_reservation;

  if (picks.includes('hms_find_reservation') && find && find.status !== 'skipped_no_candidate') {
    rows.push({
      fact: 'claim:find.status',
      claimKey: 'find.status',
      verdict: find.parse === 'ok' || find.responseClass === 'pagedata' ? 'match' : 'mismatch',
      detail: `${find.status}:${find.parse || find.responseClass || ''}`,
    });
    if (HIT_STATUSES.has(String(find.status)) && goldConfs.length) {
      const conf = find.confirmation;
      const confOk =
        conf &&
        goldConfs.some(
          (c) => String(c).includes(String(conf)) || String(conf).includes(String(c)),
        );
      rows.push({
        fact: 'claim:find.confirmation',
        claimKey: 'find.confirmation',
        verdict: confOk ? 'match' : 'mismatch',
        detail: conf ? 'present' : 'absent',
      });
    }
    if (HIT_STATUSES.has(String(find.status)) && goldDates.length && find.arrival) {
      const hit = goldDates.some(
        (d) =>
          String(find.arrival).includes(String(d).slice(5)) ||
          String(d).includes(String(find.arrival).slice(0, 4)),
      );
      rows.push({
        fact: 'claim:find.arrival',
        claimKey: 'find.arrival',
        verdict: hit ? 'match' : 'mismatch',
        detail: 'compared',
      });
    }
  }

  if (cascade?.children) {
    for (const [toolId, child] of Object.entries(cascade.children)) {
      if (child.cascade === 'starved_by_find') {
        rows.push({
          fact: `claim:cascade.${toolId}`,
          claimKey: `cascade.${toolId}`,
          verdict: 'tool_missing',
          detail: 'starved_by_find',
        });
      } else if (child.status === 'ok') {
        rows.push({
          fact: `claim:cascade.${toolId}`,
          claimKey: `cascade.${toolId}`,
          verdict: 'match',
          detail: child.status,
        });
      } else if (child.status) {
        rows.push({
          fact: `claim:cascade.${toolId}`,
          claimKey: `cascade.${toolId}`,
          verdict: child.status === 'skipped_need_find' ? 'tool_missing' : 'mismatch',
          detail: child.cascade || child.status,
        });
      }
    }
  }

  return rows;
}

export function mergeFactRows(legacyRows, claimRows) {
  return [...(legacyRows || []), ...(claimRows || [])];
}

export function summarizeVerdicts(rows) {
  const summary = {
    match: 0,
    mismatch: 0,
    tool_missing: 0,
    blocked_expected: 0,
    not_in_tool_scope: 0,
  };
  for (const row of rows || []) {
    if (row.verdict in summary) summary[row.verdict] += 1;
  }
  return summary;
}

export function aggregateCaseFunnels(caseFunnels) {
  const byTool = {};
  for (const cf of caseFunnels || []) {
    for (const [toolId, funnel] of Object.entries(cf.tools || {})) {
      if (!byTool[toolId]) byTool[toolId] = emptyFunnel();
      for (const [k, v] of Object.entries(funnel)) {
        byTool[toolId][k] = (byTool[toolId][k] || 0) + (v || 0);
      }
    }
  }
  return byTool;
}
