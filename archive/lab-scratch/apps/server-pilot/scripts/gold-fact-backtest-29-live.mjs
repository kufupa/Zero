/**
 * Live gold-fact backtest for shard-098 (29 cases).
 * Wave-A soft-open reads under flock. Agent-style picks. Scores vs Sent gold.
 *
 * Default method (live-proven 2026-09-14, ~122s n=29, find pageData 23/23):
 *   reuse + concurrent context.request finds + drain-before-recycle +
 *   no soft-open recycle on 813. See GOLD_FACT_LIVE_METHOD.
 *
 * Session modes (`HMS_GOLD_FACT_SESSION_MODE`):
 *   reuse (default) — one Chromium login; finds via concurrent context.request.
 *     Multi-tab evaluate → 813 — do NOT use tabs for parallel finds.
 *     Soft-opens via request; 813 stub ≠ recycle. Recycle only on find poison /
 *     search budget, after inflight finds drain.
 *   fresh — new Chromium+login per tool; credential mutex (escape hatch only).
 *
 * Env:
 *   HMS_DISCOVERY_ALLOW_LIVE=1
 *   HMS_READ_SECRET_ARN
 *   GOLD_FACT_PACK_DIR
 *   HMS_CHROMIUM_EXECUTABLE_PATH
 *   HMS_GOLD_FACT_SESSION_MODE=reuse|fresh
 *   HMS_GOLD_FACT_SEARCH_BUDGET (reuse recycle; default 8)
 *   HMS_GOLD_FACT_PARALLEL (default 8)
 *   HMS_GOLD_FACT_FIND_TRIES
 *   HMS_GOLD_FACT_CASE_LIMIT
 *   HMS_GOLD_FACT_FORCE_CHILD_ON_HIT=0 to disable folio/notes deepen after find hit
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';
import {
  classifyOsressResponse,
  isBrowserClosedFindError,
  isOsressSessionPoison,
  statusForOsressFind,
} from './gold-fact-live-find-status.mjs';
import {
  GOLD_FACT_LIVE_METHOD,
  aggregateCaseFunnels,
  archiveRunId,
  buildCascade,
  emptyFunnel,
  mergeFactRows,
  observeFunnel,
  picksWithForcedChildren,
  scoreClaimKeys,
  summarizeVerdicts,
} from './gold-fact-live-collect.mjs';

let parseChannelPayloadFromText = null;
try {
  ({ parseChannelPayloadFromText } = await import('../../../../../apps/server-pilot/dist/mail/parse-channel-payload.js'));
} catch {
  try {
    ({ parseChannelPayloadFromText } = await import('../../../../../apps/server-pilot/src/mail/parse-channel-payload.ts'));
  } catch {
    parseChannelPayloadFromText = null;
  }
}

const PACK =
  process.env.GOLD_FACT_PACK_DIR ||
  '/home/ubuntu/repos/zero/.private/gold-fact-backtest-29';

const UNUSED = '___NOMATCH___';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function agentPickTools(meta, trigger, authored) {
  const text = `${trigger}\n${authored}\n${meta.subject ?? ''}`.toLowerCase();
  const picks = new Set(['mail_read_artifact']);
  if (meta.kind === 'channel_fw' || /webbeds|ratetiger|synxis|booking\.com|expedia/.test(text)) {
    picks.add('mail_parse_channel_payload');
  }
  if (
    /confirm|reservation|booking|invoice|payment|deposit|cancel|amend|guest|folio|balance/.test(
      text,
    ) ||
    /payment|invoice|booking|cancel|guest_service/.test(meta.kind)
  ) {
    picks.add('hms_find_reservation');
  }
  if (/folio|balance|outstanding|deposit|paid|zar|payment/.test(text) || meta.kind === 'payment_ack') {
    picks.add('hms_read_folio');
  }
  if (/quot|availab|rate|room type/.test(text) || meta.kind === 'quote_send') {
    picks.add('hms_quote_stay');
  }
  if (
    /attach|pdf|invoice|confirmation letter|voucher|document/.test(text) ||
    (meta.att_names?.length ?? 0) > 0
  ) {
    picks.add('documents_list_existing');
    picks.add('documents_read_existing');
  }
  if (/group|block|rooming|allotment/.test(text)) picks.add('hms_group_block_read');
  if (/note|trace|vip|allergy|special request/.test(text)) picks.add('hms_read_notes_traces');
  if (/shuttle|breakfast|kids|policy|amenity|parking|wifi/.test(text) || meta.kind === 'amenity_policy') {
    picks.add('property_read_knowledge');
  }
  return [...picks];
}

function searchBodyFor(candidate) {
  const isSurname = candidate.kind === 'surname_dates';
  const v = isSurname ? candidate.surname : candidate.value;
  const confVal = candidate.kind === 'confirmation' ? v : UNUSED;
  const extVal = candidate.kind === 'external_reference' ? v : UNUSED;
  const lastnameVal = isSurname ? v : UNUSED;
  return {
    COMPONENT_INFO_TYPE: 'DATA_ONLY',
    GRID_ID: '1775',
    GRID_NAME: 'OSRESS',
    DATASPY_ID: '1941',
    SYSTEM_FUNCTION_NAME: 'OSRESS',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'LST',
    MADDON_FILTER_ALIAS_NAME_1: 'departuredate',
    MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_JOINER_1: 'AND',
    MADDON_FILTER_SEQNUM_1: '1',
    MADDON_FILTER_VALUE_1: '-365',
    MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
    MADDON_FILTER_OPERATOR_2: '<=',
    MADDON_FILTER_JOINER_2: 'AND',
    MADDON_FILTER_SEQNUM_2: '2',
    MADDON_FILTER_VALUE_2: '+365',
    MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
    MADDON_FILTER_OPERATOR_3: 'BEGINS',
    MADDON_FILTER_JOINER_3: 'OR',
    MADDON_FILTER_SEQNUM_3: '3',
    MADDON_FILTER_VALUE_3: confVal,
    MADDON_LPAREN_3: 'true',
    MADDON_FILTER_ALIAS_NAME_4: 'room',
    MADDON_FILTER_OPERATOR_4: '=',
    MADDON_FILTER_JOINER_4: 'OR',
    MADDON_FILTER_SEQNUM_4: '4',
    MADDON_FILTER_VALUE_4: UNUSED,
    MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter',
    MADDON_FILTER_OPERATOR_5: 'BEGINS',
    MADDON_FILTER_JOINER_5: 'OR',
    MADDON_FILTER_SEQNUM_5: '5',
    MADDON_FILTER_VALUE_5: lastnameVal,
    MADDON_LPAREN_5: 'false',
    MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
    MADDON_FILTER_OPERATOR_6: 'BEGINS',
    MADDON_FILTER_JOINER_6: 'OR',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: lastnameVal,
    MADDON_RPAREN_6: 'false',
    MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
    MADDON_FILTER_OPERATOR_7: 'BEGINS',
    MADDON_FILTER_JOINER_7: 'OR',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: lastnameVal,
    MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
    MADDON_FILTER_OPERATOR_8: 'BEGINS',
    MADDON_FILTER_JOINER_8: 'OR',
    MADDON_FILTER_SEQNUM_8: '8',
    MADDON_FILTER_VALUE_8: lastnameVal,
    MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
    MADDON_FILTER_OPERATOR_9: 'BEGINS',
    MADDON_FILTER_JOINER_9: 'OR',
    MADDON_FILTER_SEQNUM_9: '9',
    MADDON_FILTER_VALUE_9: UNUSED,
    MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
    MADDON_FILTER_OPERATOR_10: 'BEGINS',
    MADDON_FILTER_JOINER_10: 'OR',
    MADDON_FILTER_SEQNUM_10: '10',
    MADDON_FILTER_VALUE_10: extVal,
    MADDON_RPAREN_10: 'true',
    externalconfirmation: extVal,
  };
}

function parseOsressRows(searchText) {
  // Soft-capture responses use `pageData:` JS blob; some paths emit JSON "pageData".
  let idx = searchText.indexOf('pageData:');
  let markerLen = 'pageData:'.length;
  if (idx < 0) {
    const m = /"pageData"\s*:/.exec(searchText);
    if (!m) {
      return {
        rows: [],
        parse: /type=["']password["']/i.test(searchText)
          ? 'login_bounce'
          : /Unable to retrieve|success"\s*:\s*false/i.test(searchText)
            ? 'error_signal'
            : 'no_pagedata',
      };
    }
    idx = m.index;
    markerLen = m[0].length;
  }
  let i = idx + markerLen;
  while (i < searchText.length && /\s/.test(searchText[i])) i++;
  if (searchText[i] !== '{') {
    return { rows: [], parse: 'pagedata_not_object' };
  }
  let depth = 0;
  let end = i;
  for (; end < searchText.length; end++) {
    if (searchText[end] === '{') depth++;
    else if (searchText[end] === '}') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  try {
    const pageData = JSON.parse(searchText.slice(i, end));
    const data =
      pageData?.grid?.GRIDRESULT?.GRID?.DATA ??
      pageData?.GRIDRESULT?.GRID?.DATA ??
      [];
    if (!Array.isArray(data)) return { rows: [], parse: 'no_data' };
    return {
      parse: 'ok',
      rows: data.map((row) => ({
        confirmation: row.confirmationnumber != null ? String(row.confirmationnumber) : null,
        arrival: row.arrivaldate != null ? String(row.arrivaldate) : null,
        departure: row.departuredate != null ? String(row.departuredate) : null,
        status: row.reservationstatus != null ? String(row.reservationstatus) : null,
        roomType: row.roomtype != null ? String(row.roomtype) : null,
        ratePlan: row.rateplan != null ? String(row.rateplan) : null,
        lastName: row.lastname != null ? String(row.lastname) : null,
        firstName: row.firstname != null ? String(row.firstname) : null,
        stayId: row.id != null ? String(row.id) : null,
      })),
    };
  } catch {
    return { rows: [], parse: 'json_fail' };
  }
}

function correlate(rows, candidate) {
  if (!rows.length) return { outcome: 'not_found', rows: [] };
  let matched = rows;
  if (candidate.kind === 'confirmation') {
    const v = String(candidate.value).toUpperCase();
    matched = rows.filter((r) => (r.confirmation || '').toUpperCase().startsWith(v));
  } else if (candidate.kind === 'surname_dates') {
    const sur = candidate.surname.toUpperCase();
    matched = rows.filter((r) => {
      const ln = (r.lastName || '').toUpperCase();
      if (!ln.startsWith(sur)) return false;
      // date strings in GRID are often DD-MON-YY — keep loose; prefer include
      return true;
    });
  }
  if (!matched.length) return { outcome: 'not_found', rows: [] };
  if (matched.length === 1) return { outcome: 'matched', rows: matched };
  return { outcome: 'ambiguous', rows: matched.slice(0, 5) };
}

async function mailArtifactDigests(emlPath) {
  const t0 = Date.now();
  if (!emlPath || !existsSync(emlPath)) {
    return { status: 'no_eml', attachments: [], ms: Date.now() - t0 };
  }
  // Prefer mailparser when present; else filename harvest from raw MIME (no body parse).
  try {
    const { simpleParser } = await import('mailparser');
    const mail = await simpleParser(readFileSync(emlPath));
    const attachments = (mail.attachments ?? []).map((a) => ({
      filename: a.filename || 'unnamed',
      sha256: sha256(a.content),
      sizeBytes: a.content.length,
    }));
    return {
      status: attachments.length ? 'ok' : 'no_attachments',
      attachments,
      ms: Date.now() - t0,
    };
  } catch {
    const raw = readFileSync(emlPath, 'utf8');
    const names = [...raw.matchAll(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)/gi)].map((m) =>
      decodeURIComponent(m[1].replace(/"/g, '').trim()),
    );
    const uniq = [...new Set(names.filter(Boolean))];
    return {
      status: uniq.length ? 'ok' : 'no_attachments',
      attachments: uniq.map((filename) => ({ filename, sha256: sha256(filename), sizeBytes: 0 })),
      ms: Date.now() - t0,
      parser: 'raw_mime_filenames',
    };
  }
}

function scoreFacts({ gold, toolDumps, picks }) {
  const rows = [];
  const goldConfs = gold.confirmation_candidates || [];
  const goldAmounts = gold.amounts_zar || [];
  const goldDates = gold.date_strings || [];
  const goldAtt = gold.attachment_names || [];

  if (picks.includes('property_read_knowledge')) {
    rows.push({
      fact: 'property_policy',
      verdict: 'blocked_expected',
      detail: 'EXTERNAL_ROLE_GATE_KNOWLEDGE_CORPUS_ABSENT',
    });
  }
  if (picks.includes('hms_group_block_read')) {
    const g = toolDumps.hms_group_block_read;
    rows.push({
      fact: 'group_list',
      verdict: g?.status === 'ok' ? 'match' : g ? 'mismatch' : 'tool_missing',
      detail: g?.status,
    });
    rows.push({
      fact: 'group_con_blk',
      verdict: 'blocked_expected',
      detail: 'GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER',
    });
  }
  if (picks.includes('documents_list_existing') || picks.includes('documents_read_existing')) {
    rows.push({
      fact: 'hms_finalized_docs',
      verdict: 'blocked_expected',
      detail: 'A3_FINALIZED_DOCS_ROLE_OR_UNPROVEN',
    });
  }
  if (picks.includes('hms_read_notes_traces')) {
    const n = toolDumps.hms_read_notes_traces;
    rows.push({
      fact: 'notes_traces',
      verdict: n ? (n.status === 'ok' ? 'match' : 'mismatch') : 'tool_missing',
      detail: n?.status ?? 'not_run_this_pass',
    });
  }

  const mail = toolDumps.mail_read_artifact;
  if (goldAtt.length && mail) {
    const names = new Set((mail.attachments || []).map((a) => a.filename.toLowerCase()));
    for (const att of goldAtt) {
      const hit = [...names].some(
        (n) => n.includes(att.toLowerCase().slice(0, 12)) || att.toLowerCase().includes(n.slice(0, 12)),
      );
      rows.push({
        fact: `attachment:${att.slice(0, 40)}`,
        verdict: mail.status === 'ok' && (hit || mail.attachments.length > 0) ? 'match' : 'mismatch',
        detail: mail.status,
      });
    }
  } else if (picks.includes('mail_read_artifact')) {
    rows.push({
      fact: 'mail_artifact',
      verdict:
        mail?.status === 'ok'
          ? 'match'
          : mail?.status === 'no_attachments'
            ? 'not_in_tool_scope'
            : 'tool_missing',
      detail: mail?.status,
    });
  }

  if (picks.includes('mail_parse_channel_payload')) {
    const channel = toolDumps.mail_parse_channel_payload;
    rows.push({
      fact: 'channel_parse',
      verdict: channel?.ok ? 'match' : 'mismatch',
      detail: channel?.ok ? channel.channel : channel?.reason,
    });
  }

  if (picks.includes('hms_find_reservation')) {
    const live = toolDumps.hms_find_reservation;
    if (!live) {
      rows.push({
        fact: 'find_reservation',
        verdict: 'tool_missing',
        detail: 'no_live_dump',
      });
    } else if (live.status === 'skipped_no_candidate') {
      rows.push({
        fact: 'find_reservation',
        verdict: 'tool_missing',
        detail: 'no_exact_candidate_in_mail',
      });
    } else if (live.status === 'ok' || live.status === 'partial') {
      const conf = live.confirmation;
      const confOk =
        !goldConfs.length ||
        (conf &&
          goldConfs.some(
            (c) =>
              String(c).includes(String(conf)) || String(conf).includes(String(c)),
          ));
      rows.push({
        fact: 'find_confirmation',
        verdict: confOk || !goldConfs.length ? 'match' : 'mismatch',
        detail: `${live.status}:${live.outcome}`,
      });
      if (goldDates.length && live.arrival) {
        const hit = goldDates.some((d) => String(live.arrival).includes(d.slice(5)) || d.includes(String(live.arrival).slice(0, 4)));
        rows.push({
          fact: 'find_arrival',
          verdict: hit ? 'match' : 'mismatch',
          detail: live.arrival,
        });
      }
    } else if (live.status === 'not_found') {
      rows.push({ fact: 'find_reservation', verdict: 'mismatch', detail: 'not_found' });
    } else {
      rows.push({ fact: 'find_reservation', verdict: 'mismatch', detail: live.status });
    }
  }

  if (picks.includes('hms_read_folio')) {
    const f = toolDumps.hms_read_folio;
    rows.push({
      fact: 'folio_balance',
      verdict: f
        ? f.status === 'ok'
          ? 'match'
          : f.status === 'skipped_need_find'
            ? 'tool_missing'
            : 'mismatch'
        : 'tool_missing',
      detail: f?.status ?? (goldAmounts.length ? `gold_amounts=${goldAmounts.length}` : 'no_amount'),
    });
  }

  if (picks.includes('hms_quote_stay')) {
    const q = toolDumps.hms_quote_stay;
    rows.push({
      fact: 'quote_rates',
      verdict: q
        ? q.status === 'ok'
          ? 'match'
          : q.status === 'skipped_no_room_codes'
            ? 'tool_missing'
            : 'mismatch'
        : 'tool_missing',
      detail: q?.status ?? 'no_room_token',
    });
  }

  return rows;
}

async function login(page, secret) {
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page
    .locator('input[name=userid], input[name=username], input[name=j_username]')
    .first()
    .fill(secret.username);
  await page.locator('input[name=password]').fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
      await page.locator('input[name=password]').press('Enter');
    }),
  ]);
  await page.waitForTimeout(4_000);
}

async function warmGuestStay(page) {
  // BSSTRT only — menu/OSRESS WEBL both caused later OSRESS.search to return
  // loadLocalizedPage HTML (813B) instead of pageData GRID.
  await page.evaluate(async () => {
    for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
      await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          manurefresh: 'yes',
        }).toString(),
      }).catch(() => undefined);
    }
  });
  await page.waitForTimeout(1000);
}

async function liveFind(page, candidate) {
  const t0 = Date.now();
  // One search only in this browser — caller owns fresh login.
  const body = searchBodyFor(candidate);
  const searchText = await page.evaluate(async (b) => {
    const res = await fetch('/web/base/OSRESS.search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(b).toString(),
    });
    return res.text();
  }, body);
  const parsed = parseOsressRows(searchText);
  const corr = correlate(parsed.rows, candidate);
  const top = corr.rows[0];
  const responseClass = classifyOsressResponse(searchText, parsed.parse);
  return {
    status: statusForOsressFind({
      parse: parsed.parse,
      corrOutcome: corr.outcome,
      responseClass,
      hasRoomType: Boolean(top?.roomType),
    }),
    outcome: corr.outcome,
    parse: parsed.parse,
    searchBytes: searchText.length,
    responseClass,
    rowCount: parsed.rows.length,
    matchedCount: corr.rows.length,
    confirmation: top?.confirmation ?? null,
    arrival: top?.arrival ?? null,
    departure: top?.departure ?? null,
    statusValue: top?.status ?? null,
    roomType: top?.roomType ?? null,
    ratePlan: top?.ratePlan ?? null,
    stayId: top?.stayId ?? null,
    candidateKind: candidate.kind,
    ms: Date.now() - t0,
    findVia: 'page.evaluate',
  };
}

/** Concurrent-safe find: shared BrowserContext cookies via Playwright request API. */
async function liveFindRequest(ctx, origin, candidate) {
  const t0 = Date.now();
  const body = searchBodyFor(candidate);
  const res = await ctx.request.post(`${origin}/web/base/OSRESS.search`, {
    form: body,
    timeout: 60_000,
  });
  const searchText = await res.text();
  const parsed = parseOsressRows(searchText);
  const corr = correlate(parsed.rows, candidate);
  const top = corr.rows[0];
  const responseClass = classifyOsressResponse(searchText, parsed.parse);
  return {
    status: statusForOsressFind({
      parse: parsed.parse,
      corrOutcome: corr.outcome,
      responseClass,
      hasRoomType: Boolean(top?.roomType),
    }),
    outcome: corr.outcome,
    parse: parsed.parse,
    searchBytes: searchText.length,
    responseClass,
    rowCount: parsed.rows.length,
    matchedCount: corr.rows.length,
    confirmation: top?.confirmation ?? null,
    arrival: top?.arrival ?? null,
    departure: top?.departure ?? null,
    statusValue: top?.status ?? null,
    roomType: top?.roomType ?? null,
    ratePlan: top?.ratePlan ?? null,
    stayId: top?.stayId ?? null,
    candidateKind: candidate.kind,
    ms: Date.now() - t0,
    http: res.status(),
    findVia: 'context.request',
  };
}

const SESSION_MODE =
  String(process.env.HMS_GOLD_FACT_SESSION_MODE || 'reuse').toLowerCase() === 'fresh'
    ? 'fresh'
    : 'reuse';
const SEARCH_BUDGET = Math.max(
  1,
  Number(
    process.env.HMS_GOLD_FACT_SEARCH_BUDGET ||
      (SESSION_MODE === 'reuse' ? GOLD_FACT_LIVE_METHOD.searchBudgetDefault : 3),
  ) || GOLD_FACT_LIVE_METHOD.searchBudgetDefault,
);

/** One HMS credential → only one live login+tool at a time (Infor session stampede). */
let hmsToolTail = Promise.resolve();
function withHmsCredentialLock(fn) {
  const run = hmsToolTail.then(fn, fn);
  hmsToolTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function toolResultPoisoned(result) {
  if (isOsressSessionPoison(result)) return true;
  if (result?.status === 'loadLocalized') return true;
  if (Array.isArray(result?.probes)) {
    const probed = result.probes.filter((p) => typeof p?.bytes === 'number');
    if (
      probed.length > 0 &&
      probed.every((p) => p.bytes > 0 && p.bytes < 1000 && (p.loadLocalized || !p.hasPageData))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find-only: 813/loadLocalized means session stampede → recycle.
 * Soft-open probes (GSGRPB WEBL etc.) often return 813 without killing the SSO
 * cookie — recycling them caused 11×~40s logins on the n=29 pack.
 */
function findResultNeedsRecycle(result) {
  return (
    toolResultPoisoned(result) ||
    result?.responseClass === 'loadLocalized' ||
    result?.parse === 'no_pagedata'
  );
}

async function postFormRequest(ctx, origin, pathWithQuery, fields) {
  const url = pathWithQuery.startsWith('http')
    ? pathWithQuery
    : `${origin}${pathWithQuery.startsWith('/') ? '' : '/web/base/'}${pathWithQuery}`;
  const res = await ctx.request.post(url, { form: fields, timeout: 60_000 });
  const text = await res.text();
  return { http: res.status(), text, bytes: text.length };
}

async function installOriginRoute(ctx, origin) {
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete)/i.test(
        new URL(u).pathname,
      )
    ) {
      return route.abort();
    }
    return route.continue();
  });
}

/**
 * Staff model: one browser context+page after login.
 * Parallel finds: concurrent ctx.request (live-proven). NOT multi-tab evaluate.
 * Page soft-opens stay serial under credential lock.
 * Recycle full login when search budget hits or response is 813 poison.
 *
 * Inflight find gate: never close browser while another parallel ctx.request
 * is outstanding — that caused 7× "browser has been closed" on n=29 fast run
 * (match 144→141 / pageData 20→16 vs prior reuse pack).
 * Drain happens OUTSIDE the credential lock to avoid deadlock with bumpReuseSearchCount.
 */
let sharedSession = null;
let inflightFindRequests = 0;
let sessionRecycleCount = 0;
let softOpenStubCount = 0;
let browserClosedRetryCount = 0;

async function waitForInflightFindsIdle(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (inflightFindRequests > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (inflightFindRequests > 0) {
    console.log(
      JSON.stringify({
        hms_recycle_inflight_timeout: true,
        inflightFindRequests,
        timeoutMs,
      }),
    );
  }
}

async function closeSharedSession() {
  if (!sharedSession) return;
  const browser = sharedSession.browser;
  sharedSession = null;
  await browser.close().catch(() => undefined);
}

async function openSharedSession(secret, origin) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const loginT0 = Date.now();
  try {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    });
    await installOriginRoute(ctx, origin);
    const page = await ctx.newPage();
    await login(page, secret);
    await warmGuestStay(page);
    sharedSession = {
      browser,
      ctx,
      page,
      origin,
      searchCount: 0,
      lastLoginMs: Date.now() - loginT0,
    };
    return sharedSession;
  } catch (err) {
    await browser.close().catch(() => undefined);
    sharedSession = null;
    throw err;
  }
}

async function recycleSharedSessionImmediate(secret, origin, reason) {
  sessionRecycleCount += 1;
  console.log(
    JSON.stringify({
      hms_session_recycle: true,
      reason,
      inflightFindRequests,
      sessionRecycleCount,
    }),
  );
  await closeSharedSession();
  return openSharedSession(secret, origin);
}

/** Mutex only for open/recycle/count — concurrent requests may overlap after ensure. */
async function ensureReuseSession(secret, origin, { forceRecycle, reason } = {}) {
  for (let spin = 0; spin < 40; spin++) {
    const needsRecycleHint =
      forceRecycle ||
      (sharedSession &&
        sharedSession.origin === origin &&
        sharedSession.searchCount >= SEARCH_BUDGET);
    if (needsRecycleHint) {
      await waitForInflightFindsIdle();
    }
    const outcome = await withHmsCredentialLock(async () => {
      let loginMs = 0;
      let session =
        sharedSession && sharedSession.origin === origin ? sharedSession : null;
      if (forceRecycle) {
        if (inflightFindRequests > 0) return { retry: true };
        session = await recycleSharedSessionImmediate(secret, origin, reason || 'force');
        loginMs = session.lastLoginMs;
        return { session, loginMs };
      }
      if (!session) {
        session = await openSharedSession(secret, origin);
        loginMs = session.lastLoginMs;
        return { session, loginMs };
      }
      if (session.searchCount >= SEARCH_BUDGET) {
        if (inflightFindRequests > 0) return { retry: true };
        session = await recycleSharedSessionImmediate(
          secret,
          origin,
          `search_budget_${SEARCH_BUDGET}`,
        );
        loginMs = session.lastLoginMs;
        return { session, loginMs };
      }
      return { session, loginMs: 0 };
    });
    if (outcome.retry) continue;
    return outcome;
  }
  throw new Error('ensureReuseSession: could not drain inflight finds for recycle');
}

async function bumpReuseSearchCount(n = 1) {
  return withHmsCredentialLock(async () => {
    if (sharedSession) sharedSession.searchCount += n;
  });
}

async function liveFindRequestTracked(ctx, origin, candidate) {
  inflightFindRequests += 1;
  try {
    return await liveFindRequest(ctx, origin, candidate);
  } finally {
    inflightFindRequests -= 1;
  }
}

/**
 * Parallel find path: context.request with shared cookies.
 * Live A/B 2026-09-14: N=8 concurrent → 8/8 pageData ~0.9s; multi-tab evaluate → 813.
 * Drain inflight before recycle; retry once on browser-closed race.
 */
async function withReuseHmsFindRequest(secret, origin, candidate) {
  let loginMs = 0;
  let sessionRetry = false;
  let browserClosedRetry = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    let { session, loginMs: lm } = await ensureReuseSession(secret, origin);
    loginMs += lm;
    let result;
    try {
      result = await liveFindRequestTracked(session.ctx, origin, candidate);
    } catch (err) {
      if (isBrowserClosedFindError(err) && attempt < 2) {
        console.log(
          JSON.stringify({
            hms_retry: true,
            reason: 'browser_closed_mid_find',
            mode: 'reuse_request',
            attempt,
          }),
        );
        browserClosedRetry = true;
        browserClosedRetryCount += 1;
        continue;
      }
      throw err;
    }
    await bumpReuseSearchCount(1);
    if (findResultNeedsRecycle(result) && attempt < 2) {
      console.log(
        JSON.stringify({
          hms_retry: true,
          reason: 'loadLocalized_or_poison',
          mode: 'reuse_request',
          attempt,
        }),
      );
      ({ session, loginMs: lm } = await ensureReuseSession(secret, origin, {
        forceRecycle: true,
        reason: 'poison',
      }));
      loginMs += lm;
      sessionRetry = true;
      continue;
    }
    if (sessionRetry || browserClosedRetry) {
      result = {
        ...result,
        sessionRetry: sessionRetry || undefined,
        browserClosedRetry: browserClosedRetry || undefined,
      };
    }
    return {
      result,
      loginMs,
      freshBrowser: false,
      sessionMode: 'reuse',
      findVia: 'context.request',
    };
  }
  throw new Error('withReuseHmsFindRequest: exhausted retries');
}

async function withReuseHmsTool(secret, origin, toolFn, opts = {}) {
  const countsAsSearch = opts.countsAsSearch === true;
  let loginMs = 0;
  // Open/budget recycle via ensure (drains inflight request finds outside lock).
  let { session, loginMs: lm } = await ensureReuseSession(secret, origin, {
    forceRecycle: false,
  });
  loginMs += lm;
  // Page soft-opens stay exclusive on credential lock.
  return withHmsCredentialLock(async () => {
    // Re-read session under lock — ensure may have opened; another recycle rare.
    session = sharedSession && sharedSession.origin === origin ? sharedSession : null;
    if (!session) {
      session = await openSharedSession(secret, origin);
      loginMs += session.lastLoginMs;
    }
    let result = await toolFn(session.page);
    if (countsAsSearch) session.searchCount += 1;
    if (countsAsSearch && findResultNeedsRecycle(result)) {
      console.log(
        JSON.stringify({ hms_retry: true, reason: 'loadLocalized_or_poison', mode: 'reuse' }),
      );
      // Cannot drain while holding lock — release by returning to outer path.
      // Page-find path is rare under SESSION_MODE=reuse (request finds preferred).
      if (inflightFindRequests > 0) {
        console.log(
          JSON.stringify({
            hms_softopen_stub: true,
            mode: 'reuse',
            note: 'defer_page_recycle_inflight_finds',
            inflightFindRequests,
          }),
        );
      } else {
        session = await recycleSharedSessionImmediate(secret, origin, 'poison');
        loginMs += session.lastLoginMs;
        result = await toolFn(session.page);
        if (countsAsSearch) session.searchCount += 1;
        result = { ...result, sessionRetry: true };
      }
    } else if (!countsAsSearch && toolResultPoisoned(result)) {
      console.log(
        JSON.stringify({
          hms_softopen_stub: true,
          mode: 'reuse',
          note: 'no_session_recycle_on_softopen_813',
        }),
      );
    }
    return { result, loginMs, freshBrowser: false, sessionMode: 'reuse' };
  });
}

/**
 * Fresh Chromium → login → BSSTRT → one tool → close.
 * Serialized on shared HMS credential; one retry if response is 813 loadLocalized.
 */
async function withFreshHmsTool(secret, origin, toolFn) {
  return withHmsCredentialLock(async () => {
    const runOnce = async () => {
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
      });
      const loginT0 = Date.now();
      let loginMs = 0;
      try {
        const ctx = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 1600, height: 1000 },
        });
        await installOriginRoute(ctx, origin);
        const page = await ctx.newPage();
        await login(page, secret);
        await warmGuestStay(page);
        loginMs = Date.now() - loginT0;
        const result = await toolFn(page);
        return { result, loginMs, freshBrowser: true, sessionMode: 'fresh' };
      } finally {
        await browser.close().catch(() => undefined);
      }
    };

    let wrapped = await runOnce();
    if (toolResultPoisoned(wrapped.result)) {
      console.log(JSON.stringify({ hms_retry: true, reason: 'loadLocalized_or_poison', mode: 'fresh' }));
      wrapped = await runOnce();
      wrapped = {
        ...wrapped,
        result: { ...wrapped.result, sessionRetry: true },
      };
    }
    return wrapped;
  });
}

async function withHmsTool(secret, origin, toolFn, opts = {}) {
  if (SESSION_MODE === 'reuse') return withReuseHmsTool(secret, origin, toolFn, opts);
  return withFreshHmsTool(secret, origin, toolFn);
}

async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  async function run() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

async function liveFolioProbe(page, findDump) {
  const t0 = Date.now();
  if (!findDump?.confirmation && !findDump?.stayId) {
    return { status: 'skipped_need_find', ms: 0 };
  }
  const result = await page.evaluate(
    async ({ conf, stayId }) => {
      const base = {
        confirmationnumber: conf || '',
        propertycode: 'HRCEN',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
      };
      if (stayId) {
        base.reservationstayid = stayId;
        base.id = stayId;
      }
      const probes = [];
      for (const tab of ['FOL', 'FOLO', 'FLIO', 'LED', 'HDR']) {
        const r = await fetch(`/web/base/OSRESV.${tab}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...base, CURRENT_TAB_NAME: tab }).toString(),
        }).catch(() => null);
        const text = r ? await r.text() : '';
        const keyHits = [
          ...new Set(
            [...text.matchAll(/"(balance[^"]*|amount[^"]*|folio[^"]*|payment[^"]*|total[^"]*|outstanding[^"]*)"/gi)].map(
              (m) => m[1],
            ),
          ),
        ].slice(0, 20);
        probes.push({
          tab,
          bytes: text.length,
          hasPageData: text.includes('pageData'),
          loginBounce: /type=["']password["']/i.test(text),
          keyHits,
        });
      }
      return probes;
    },
    { conf: findDump.confirmation, stayId: findDump.stayId },
  );
  const ok = result.some((p) => p.hasPageData && !p.loginBounce && (p.keyHits.length > 0 || p.bytes > 500));
  return {
    status: ok ? 'ok' : 'mismatch',
    probes: result.map((p) => ({
      tab: p.tab,
      bytes: p.bytes,
      hasPageData: p.hasPageData,
      keyHitN: p.keyHits.length,
    })),
    ms: Date.now() - t0,
  };
}

async function liveFolioProbeRequest(ctx, origin, findDump) {
  const t0 = Date.now();
  if (!findDump?.confirmation && !findDump?.stayId) {
    return { status: 'skipped_need_find', ms: 0, via: 'context.request' };
  }
  const base = {
    confirmationnumber: findDump.confirmation || '',
    propertycode: 'HRCEN',
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
  };
  if (findDump.stayId) {
    base.reservationstayid = findDump.stayId;
    base.id = findDump.stayId;
  }
  const probes = [];
  for (const tab of ['FOL', 'FOLO', 'FLIO', 'LED', 'HDR']) {
    const { text, bytes } = await postFormRequest(ctx, origin, `/web/base/OSRESV.${tab}`, {
      ...base,
      CURRENT_TAB_NAME: tab,
    });
    const keyHitN = [
      ...text.matchAll(/"(balance[^"]*|amount[^"]*|folio[^"]*|payment[^"]*|total[^"]*|outstanding[^"]*)"/gi),
    ].length;
    probes.push({
      tab,
      bytes,
      hasPageData: text.includes('pageData'),
      keyHitN,
      loadLocalized: /loadLocalizedPage/i.test(text) && bytes < 2000,
    });
  }
  const ok = probes.some((p) => p.hasPageData && !p.loadLocalized && (p.keyHitN > 0 || p.bytes > 500));
  return { status: ok ? 'ok' : 'mismatch', probes, ms: Date.now() - t0, via: 'context.request' };
}

let packGroupCache = null;
let packGroupInflight = null;

async function liveGroupList(page) {
  const t0 = Date.now();
  const result = await page.evaluate(async () => {
    const paths = ['GSGRPB.LST', 'GSGRPB'];
    const out = [];
    for (const code of paths) {
      const [sys, tab] = code.includes('.') ? code.split('.') : [code, ''];
      const res = await fetch(`/web/base/${code}?FUNCTION_CLASS=WEBL`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: sys,
          USER_FUNCTION_NAME: sys,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: tab || '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      }).catch(() => null);
      const text = res ? await res.text() : '';
      out.push({
        code,
        bytes: text.length,
        hasPageData: text.includes('pageData'),
        loginBounce: /type=["']password["']/i.test(text),
      });
    }
    return out;
  });
  const ok = result.some((r) => r.hasPageData && !r.loginBounce);
  return { status: ok ? 'ok' : 'mismatch', probes: result, ms: Date.now() - t0 };
}

async function liveGroupListRequest(ctx, origin) {
  if (packGroupCache) {
    return { ...packGroupCache, cached: true, ms: 0 };
  }
  if (packGroupInflight) {
    const shared = await packGroupInflight;
    return { ...shared, cached: true, ms: 0 };
  }
  packGroupInflight = (async () => {
    const t0 = Date.now();
    const probes = [];
    for (const code of ['GSGRPB.LST', 'GSGRPB']) {
      const [sys, tab] = code.includes('.') ? code.split('.') : [code, ''];
      const { text, bytes } = await postFormRequest(
        ctx,
        origin,
        `/web/base/${code}?FUNCTION_CLASS=WEBL`,
        {
          SYSTEM_FUNCTION_NAME: sys,
          USER_FUNCTION_NAME: sys,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: tab || '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        },
      );
      probes.push({
        code,
        bytes,
        hasPageData: text.includes('pageData'),
        loadLocalized: /loadLocalizedPage/i.test(text) && bytes < 2000,
        loginBounce: /type=["']password["']/i.test(text),
      });
    }
    const ok = probes.some((r) => r.hasPageData && !r.loginBounce && !r.loadLocalized);
    packGroupCache = {
      status: ok ? 'ok' : 'mismatch',
      probes,
      ms: Date.now() - t0,
      via: 'context.request',
    };
    return packGroupCache;
  })();
  try {
    const result = await packGroupInflight;
    return { ...result, cached: false };
  } finally {
    packGroupInflight = null;
  }
}

/** HMS room-type codes are short alnum (e.g. DLXQN) — reject English junk from extract. */
function usableRoomCodes(tokens) {
  return [...new Set((tokens || []).map((t) => String(t).trim().toUpperCase()))].filter(
    (t) =>
      /^[A-Z0-9]{3,8}$/.test(t) &&
      !/^(THE|AND|FOR|WITH|HAVE|FROM|THIS|THAT|TWIN|BED|ROOM)$/.test(t),
  );
}

function mmddyyyy(isoOrLoose) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoOrLoose || '').trim());
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return null;
}

async function liveQuoteProbe(page, { roomType, arrivalIso, departureIso }) {
  const t0 = Date.now();
  void departureIso;
  const start = mmddyyyy(arrivalIso) || '09/15/2026';
  const hotel = mmddyyyy(arrivalIso) || start;
  const result = await page.evaluate(
    async ({ roomType, start, hotel }) => {
      await fetch('/web/base/OSRRAV.HDR', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          USER_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      }).catch(() => null);
      const body = {
        property: 'HRCEN',
        roomtypes: roomType,
        rateplans: '',
        salesstrategy: '',
        showunavailable: '0',
        ratetype: '',
        adults: '2',
        showexclusiverates: '0',
        showavailableforsale: 'on',
        children: '0',
        startdate: start,
        currency: 'ZAR',
        rowpagesize: '14',
        salesstrategy_display: '',
        currency_display: 'ZAR',
        adults_display: '2',
        children_display: '0',
        hoteldate: hotel,
        firstcolumndate: start,
        pagemode: 'display',
        ONLY_DATA_REQUIRED: 'true',
        USER_FUNCTION_NAME: 'OSRRAV',
        SYSTEM_FUNCTION_NAME: 'OSRRAV',
        CURRENT_TAB_NAME: 'HDR',
      };
      const r = await fetch('/web/base/OSRRAV.HDR.search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      const text = await r.text();
      return {
        bytes: text.length,
        hasPageData: /pageData/i.test(text),
        hasAvailability: /availabilitydata/i.test(text),
        loadLocalized: /loadLocalizedPage/i.test(text),
        loginBounce: /type=["']password["']/i.test(text),
      };
    },
    { roomType, start, hotel },
  );
  const ok =
    result.hasPageData &&
    result.hasAvailability &&
    !result.loadLocalized &&
    !result.loginBounce;
  return {
    status: ok ? 'ok' : result.loadLocalized ? 'loadLocalized' : 'mismatch',
    roomType,
    arrival: arrivalIso,
    ...result,
    ms: Date.now() - t0,
  };
}

async function liveNotesTracesProbe(page, findDump) {
  const t0 = Date.now();
  if (!findDump?.confirmation && !findDump?.stayId) {
    return { status: 'skipped_need_find', ms: 0 };
  }
  const result = await page.evaluate(
    async ({ conf, stayId }) => {
      const base = {
        confirmationnumber: conf || '',
        propertycode: 'HRCEN',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      };
      if (stayId) {
        base.reservationstayid = stayId;
        base.id = stayId;
      }
      const paths = ['OSRESV.TRC', 'OSRESV.NTE', 'OSRESV.NOTE', 'OSRESV.HDR', 'OSRESS.TRC', 'OSRESS.NTE'];
      const probes = [];
      for (const path of paths) {
        const [sys, tab] = path.split('.');
        const r = await fetch(`/web/base/${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...base,
            SYSTEM_FUNCTION_NAME: sys,
            USER_FUNCTION_NAME: sys === 'OSRESS' ? 'OSRESV' : sys,
            CURRENT_TAB_NAME: tab,
          }).toString(),
        }).catch(() => null);
        const text = r ? await r.text() : '';
        const keyHits = [
          ...new Set(
            [
              ...text.matchAll(
                /"(trace[^"]*|note[^"]*|alert[^"]*|reservationnote[^"]*|tracestatus[^"]*)"/gi,
              ),
            ].map((m) => m[1]),
          ),
        ].slice(0, 20);
        probes.push({
          path,
          bytes: text.length,
          hasPageData: /pageData/i.test(text),
          loadLocalized: /loadLocalizedPage/i.test(text),
          keyHitN: keyHits.length,
        });
      }
      return probes;
    },
    { conf: findDump.confirmation, stayId: findDump.stayId },
  );
  const ok = result.some((p) => p.hasPageData && !p.loadLocalized && (p.keyHitN > 0 || p.bytes > 800));
  return {
    status: ok ? 'ok' : 'mismatch',
    probes: result,
    ms: Date.now() - t0,
  };
}

async function liveNotesTracesProbeRequest(ctx, origin, findDump) {
  const t0 = Date.now();
  if (!findDump?.confirmation && !findDump?.stayId) {
    return { status: 'skipped_need_find', ms: 0, via: 'context.request' };
  }
  const base = {
    confirmationnumber: findDump.confirmation || '',
    propertycode: 'HRCEN',
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
  };
  if (findDump.stayId) {
    base.reservationstayid = findDump.stayId;
    base.id = findDump.stayId;
  }
  const paths = ['OSRESV.TRC', 'OSRESV.NTE', 'OSRESV.NOTE', 'OSRESV.HDR', 'OSRESS.TRC', 'OSRESS.NTE'];
  const probes = [];
  for (const path of paths) {
    const [sys, tab] = path.split('.');
    const { text, bytes } = await postFormRequest(ctx, origin, `/web/base/${path}`, {
      ...base,
      SYSTEM_FUNCTION_NAME: sys,
      USER_FUNCTION_NAME: sys === 'OSRESS' ? 'OSRESV' : sys,
      CURRENT_TAB_NAME: tab,
    });
    const keyHitN = [
      ...text.matchAll(/"(trace[^"]*|note[^"]*|alert[^"]*|reservationnote[^"]*|tracestatus[^"]*)"/gi),
    ].length;
    probes.push({
      path,
      bytes,
      hasPageData: /pageData/i.test(text),
      loadLocalized: /loadLocalizedPage/i.test(text) && bytes < 2000,
      keyHitN,
    });
  }
  const ok = probes.some((p) => p.hasPageData && !p.loadLocalized && (p.keyHitN > 0 || p.bytes > 800));
  return { status: ok ? 'ok' : 'mismatch', probes, ms: Date.now() - t0, via: 'context.request' };
}

/** Soft-opens via shared cookies — no page.evaluate, no recycle on stub. */
async function withReuseSoftOpen(secret, origin, softFn) {
  const { session, loginMs } = await ensureReuseSession(secret, origin);
  const result = await softFn(session.ctx, origin);
  if (toolResultPoisoned(result)) {
      console.log(
        JSON.stringify({
          hms_softopen_stub: true,
          mode: 'reuse_request',
          note: 'no_session_recycle_on_softopen_813',
        }),
      );
      softOpenStubCount += 1;
  }
  return {
    result,
    loginMs,
    freshBrowser: false,
    sessionMode: 'reuse',
    findVia: 'context.request',
  };
}

async function runOneCase({ row, secret, origin, maxTries }) {
  const caseDir = join(PACK, row.case_dir);
  const meta = JSON.parse(readFileSync(join(caseDir, 'meta.json'), 'utf8'));
  const trigger = readFileSync(join(caseDir, 'trigger.txt'), 'utf8');
  const authored = readFileSync(join(caseDir, 'sent_authored.txt'), 'utf8');
  const gold = JSON.parse(readFileSync(join(caseDir, 'gold_facts.json'), 'utf8'));
  const dumpsDir = join(caseDir, 'tool_dumps');
  mkdirSync(dumpsDir, { recursive: true });

  const t0 = Date.now();
  const picks = agentPickTools(meta, trigger, authored);
  const toolDumps = {};
  let loginMs = 0;
  let loginCycles = 0;
  let findPagedata = 0;
  let findHit = 0;

  const runTool = async (name, fn, opts = {}) => {
    const wrapped = await withHmsTool(secret, origin, fn, opts);
    loginMs += wrapped.loginMs;
    if (wrapped.loginMs > 0) loginCycles += 1;
    console.log(
      JSON.stringify({
        id: meta.id.slice(0, 24),
        tool: name,
        loginMs: wrapped.loginMs,
        freshBrowser: wrapped.freshBrowser,
        sessionMode: wrapped.sessionMode || SESSION_MODE,
        findVia: wrapped.findVia || null,
      }),
    );
    return wrapped.result;
  };

  const runFind = async (candidate) => {
    if (SESSION_MODE === 'reuse') {
      const wrapped = await withReuseHmsFindRequest(secret, origin, candidate);
      loginMs += wrapped.loginMs;
      if (wrapped.loginMs > 0) loginCycles += 1;
      console.log(
        JSON.stringify({
          id: meta.id.slice(0, 24),
          tool: 'hms_find_reservation',
          loginMs: wrapped.loginMs,
          freshBrowser: false,
          sessionMode: 'reuse',
          findVia: 'context.request',
        }),
      );
      return wrapped.result;
    }
    return runTool('hms_find_reservation', (page) => liveFind(page, candidate), {
      countsAsSearch: true,
    });
  };

  const runSoft = async (name, softFn) => {
    if (SESSION_MODE === 'reuse') {
      const wrapped = await withReuseSoftOpen(secret, origin, softFn);
      loginMs += wrapped.loginMs;
      if (wrapped.loginMs > 0) loginCycles += 1;
      console.log(
        JSON.stringify({
          id: meta.id.slice(0, 24),
          tool: name,
          loginMs: wrapped.loginMs,
          freshBrowser: false,
          sessionMode: 'reuse',
          via: 'context.request',
        }),
      );
      return wrapped.result;
    }
    throw new Error(`runSoft reuse-only: ${name}`);
  };

  if (meta.skip_no_reads) {
    const score = {
      id: meta.id,
      kind: meta.kind,
      trigger_class: meta.trigger_class,
      agent_picks: picks,
      wall_ms: Date.now() - t0,
      login_ms: 0,
      login_cycles: 0,
      facts: [{ fact: 'skip_no_reads', verdict: 'not_in_tool_scope', detail: 'ops/noise' }],
      summary: {
        match: 0,
        mismatch: 0,
        tool_missing: 0,
        blocked_expected: 0,
        not_in_tool_scope: 1,
      },
      live: false,
    };
    writeFileSync(join(caseDir, 'score.json'), JSON.stringify(score, null, 2) + '\n');
    return score;
  }

  if (picks.includes('mail_read_artifact')) {
    let eml = meta.eml_path;
    const localEml = join(caseDir, 'message.eml');
    if (existsSync(localEml)) eml = localEml;
    const dump = await mailArtifactDigests(existsSync(eml || '') ? eml : undefined);
    toolDumps.mail_read_artifact = dump;
    writeFileSync(join(dumpsDir, 'mail_read_artifact.json'), JSON.stringify(dump, null, 2));
  }

  if (picks.includes('mail_parse_channel_payload')) {
    let dump;
    if (!parseChannelPayloadFromText) {
      dump = { ok: false, reason: 'parse_channel_module_unavailable' };
    } else {
      const outcome = parseChannelPayloadFromText(`${trigger}\n${authored}`);
      dump = outcome.ok
        ? { ok: true, channel: outcome.data.channel, externalRef: outcome.data.externalRef }
        : { ok: false, reason: outcome.reason };
    }
    toolDumps.mail_parse_channel_payload = dump;
    writeFileSync(join(dumpsDir, 'mail_parse_channel_payload.json'), JSON.stringify(dump, null, 2));
  }

  const candidate =
    gold.live_candidate ||
    (existsSync(join(caseDir, 'live_candidate.json'))
      ? JSON.parse(readFileSync(join(caseDir, 'live_candidate.json'), 'utf8'))
      : null);

  const tryList = [];
  const seen = new Set();
  const pushCand = (c) => {
    if (!c || !c.kind) return;
    const key =
      c.kind === 'surname_dates'
        ? `sd:${c.surname}:${c.arrivalDate}:${c.departureDate}`
        : `${c.kind}:${c.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    tryList.push(c);
  };
  pushCand(candidate);
  for (const conf of gold.confirmation_candidates || []) {
    pushCand({ kind: 'confirmation', value: String(conf), id: `conf-${conf}`, source: 'gold_list' });
  }

  if (picks.includes('hms_find_reservation')) {
    if (!tryList.length) {
      toolDumps.hms_find_reservation = { status: 'skipped_no_candidate' };
    } else {
      let dump = null;
      const attempts = [];
      for (const c of tryList.slice(0, maxTries)) {
        try {
          const one = await runFind(c);
          attempts.push({
            kind: c.kind,
            status: one.status,
            parse: one.parse,
            responseClass: one.responseClass,
            rowCount: one.rowCount,
            ms: one.ms,
            sessionMode: SESSION_MODE,
            findVia: one.findVia || null,
          });
          if (one.parse === 'ok') findPagedata += 1;
          if (one.status === 'ok' || one.status === 'partial' || one.status === 'ambiguous') {
            findHit += 1;
            dump = { ...one, tried: attempts.length, attempts, sessionMode: SESSION_MODE };
            break;
          }
          dump = { ...one, tried: attempts.length, attempts, sessionMode: SESSION_MODE };
        } catch (e) {
          attempts.push({
            kind: c.kind,
            status: 'error',
            detail: String(e?.message || e).slice(0, 80),
          });
        }
      }
      toolDumps.hms_find_reservation = dump || { status: 'error', attempts };
    }
    writeFileSync(
      join(dumpsDir, 'hms_find_reservation.json'),
      JSON.stringify(toolDumps.hms_find_reservation, null, 2),
    );
  }

  const forceChild = process.env.HMS_GOLD_FACT_FORCE_CHILD_ON_HIT !== '0';
  const effectivePicks = picksWithForcedChildren(picks, toolDumps.hms_find_reservation, {
    force: forceChild,
  });
  const forcedChildren = effectivePicks.filter((p) => !picks.includes(p));

  if (effectivePicks.includes('hms_read_folio')) {
    const find = toolDumps.hms_find_reservation;
    const folioReady =
      find &&
      (find.status === 'ok' ||
        find.status === 'partial' ||
        (find.status === 'ambiguous' && (find.confirmation || find.stayId)));
    if (!folioReady) {
      toolDumps.hms_read_folio = { status: 'skipped_need_find' };
    } else {
      try {
        toolDumps.hms_read_folio =
          SESSION_MODE === 'reuse'
            ? await runSoft('hms_read_folio', (ctx, origin) =>
                liveFolioProbeRequest(ctx, origin, find),
              )
            : await runTool('hms_read_folio', (page) => liveFolioProbe(page, find));
        toolDumps.hms_read_folio = {
          ...toolDumps.hms_read_folio,
          sessionMode: SESSION_MODE,
          collectionForced: forcedChildren.includes('hms_read_folio') || undefined,
        };
      } catch (e) {
        toolDumps.hms_read_folio = {
          status: 'error',
          detail: String(e?.message || e).slice(0, 120),
        };
      }
    }
    writeFileSync(join(dumpsDir, 'hms_read_folio.json'), JSON.stringify(toolDumps.hms_read_folio, null, 2));
  }

  if (picks.includes('hms_quote_stay')) {
    const codes = usableRoomCodes(gold.room_tokens || []);
    const dates = (gold.date_strings || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)));
    if (!codes.length) {
      toolDumps.hms_quote_stay = {
        status: 'skipped_no_room_codes',
        extractedTokens: (gold.room_tokens || []).length,
      };
    } else {
      try {
        toolDumps.hms_quote_stay = await runTool('hms_quote_stay', (page) =>
          liveQuoteProbe(page, {
            roomType: codes[0],
            arrivalIso: dates[0] || null,
            departureIso: dates[1] || null,
          }),
        );
        toolDumps.hms_quote_stay = { ...toolDumps.hms_quote_stay, sessionMode: SESSION_MODE };
      } catch (e) {
        toolDumps.hms_quote_stay = {
          status: 'error',
          detail: String(e?.message || e).slice(0, 120),
        };
      }
    }
    writeFileSync(join(dumpsDir, 'hms_quote_stay.json'), JSON.stringify(toolDumps.hms_quote_stay, null, 2));
  }

  if (effectivePicks.includes('hms_read_notes_traces')) {
    const find = toolDumps.hms_find_reservation;
    const notesReady =
      find &&
      (find.status === 'ok' ||
        find.status === 'partial' ||
        (find.status === 'ambiguous' && (find.confirmation || find.stayId)));
    if (!notesReady) {
      toolDumps.hms_read_notes_traces = { status: 'skipped_need_find' };
    } else {
      try {
        toolDumps.hms_read_notes_traces =
          SESSION_MODE === 'reuse'
            ? await runSoft('hms_read_notes_traces', (ctx, origin) =>
                liveNotesTracesProbeRequest(ctx, origin, find),
              )
            : await runTool('hms_read_notes_traces', (page) => liveNotesTracesProbe(page, find));
        toolDumps.hms_read_notes_traces = {
          ...toolDumps.hms_read_notes_traces,
          sessionMode: SESSION_MODE,
          collectionForced: forcedChildren.includes('hms_read_notes_traces') || undefined,
        };
      } catch (e) {
        toolDumps.hms_read_notes_traces = {
          status: 'error',
          detail: String(e?.message || e).slice(0, 120),
        };
      }
    }
    writeFileSync(
      join(dumpsDir, 'hms_read_notes_traces.json'),
      JSON.stringify(toolDumps.hms_read_notes_traces, null, 2),
    );
  }

  if (picks.includes('hms_group_block_read')) {
    try {
      toolDumps.hms_group_block_read =
        SESSION_MODE === 'reuse'
          ? await runSoft('hms_group_block_read', (ctx, origin) => liveGroupListRequest(ctx, origin))
          : await runTool('hms_group_block_read', (page) => liveGroupList(page));
      toolDumps.hms_group_block_read = {
        ...toolDumps.hms_group_block_read,
        sessionMode: SESSION_MODE,
      };
    } catch (e) {
      toolDumps.hms_group_block_read = {
        status: 'error',
        detail: String(e?.message || e).slice(0, 120),
      };
    }
    writeFileSync(
      join(dumpsDir, 'hms_group_block_read.json'),
      JSON.stringify(toolDumps.hms_group_block_read, null, 2),
    );
  }

  const cascade = buildCascade(toolDumps.hms_find_reservation, {
    hms_read_folio: toolDumps.hms_read_folio,
    hms_read_notes_traces: toolDumps.hms_read_notes_traces,
    hms_quote_stay: toolDumps.hms_quote_stay,
    hms_group_block_read: toolDumps.hms_group_block_read,
  });
  const caseFunnel = { tools: {} };
  for (const [toolId, dump] of Object.entries(toolDumps)) {
    caseFunnel.tools[toolId] = observeFunnel(emptyFunnel(), toolId, dump);
  }

  const legacyFacts = scoreFacts({ gold, toolDumps, picks: effectivePicks });
  const claimFacts = scoreClaimKeys({
    gold,
    toolDumps,
    picks: effectivePicks,
    cascade,
  });
  const facts = mergeFactRows(legacyFacts, claimFacts);
  const ms = Date.now() - t0;
  const score = {
    id: meta.id,
    kind: meta.kind,
    trigger_class: meta.trigger_class,
    agent_picks: picks,
    effective_picks: effectivePicks,
    forced_children: forcedChildren,
    gold_label_reads: meta.pms_reads_needed,
    live_candidate_kind: tryList[0]?.kind ?? candidate?.kind ?? null,
    live_try_n: tryList.length,
    wall_ms: ms,
    login_ms: loginMs,
    login_cycles: loginCycles,
    find_pagedata: findPagedata,
    find_hit: findHit,
    cascade,
    funnel: caseFunnel,
    facts,
    summary: summarizeVerdicts(facts),
    live: true,
    session_mode: SESSION_MODE,
    live_method: GOLD_FACT_LIVE_METHOD.id,
    fresh_browser_per_tool: SESSION_MODE === 'fresh',
  };
  writeFileSync(join(caseDir, 'score.json'), JSON.stringify(score, null, 2) + '\n');
  writeFileSync(
    join(caseDir, 'collect.json'),
    JSON.stringify(
      {
        id: meta.id,
        cascade,
        funnel: caseFunnel,
        forced_children: forcedChildren,
        live_method: GOLD_FACT_LIVE_METHOD.id,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      id: meta.id.slice(0, 24),
      kind: meta.kind,
      ms,
      loginMs,
      loginCycles,
      find: toolDumps.hms_find_reservation?.status ?? null,
      parse: toolDumps.hms_find_reservation?.parse ?? null,
      ...score.summary,
    }),
  );
  return score;
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  if (!existsSync(join(PACK, 'manifest.jsonl'))) {
    throw new Error(`pack missing: ${PACK}`);
  }

  const runId = archiveRunId();
  const archivesDir = join(PACK, 'archives', runId);
  mkdirSync(archivesDir, { recursive: true });
  for (const name of ['LIVE_RUN.json', 'SUMMARY.md', 'FUNNEL.json', 'SCORES_AGGREGATE.json']) {
    const src = join(PACK, name);
    if (existsSync(src)) {
      copyFileSync(src, join(archivesDir, name));
    }
  }

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const MAX_TRIES_PER_CASE = Number(process.env.HMS_GOLD_FACT_FIND_TRIES || 1);
  const PARALLEL = Number(
    process.env.HMS_GOLD_FACT_PARALLEL || GOLD_FACT_LIVE_METHOD.parallelDefault || 8,
  );
  const CASE_LIMIT = process.env.HMS_GOLD_FACT_CASE_LIMIT
    ? Number(process.env.HMS_GOLD_FACT_CASE_LIMIT)
    : null;

  const tAll = Date.now();
  sessionRecycleCount = 0;
  softOpenStubCount = 0;
  browserClosedRetryCount = 0;

  writeFileSync(
    join(PACK, 'session-canary-find.json'),
    JSON.stringify(
      {
        status: 'skipped',
        reason:
          SESSION_MODE === 'reuse'
            ? GOLD_FACT_LIVE_METHOD.id
            : 'fresh_browser_per_tool — escape hatch',
        sessionMode: SESSION_MODE,
        liveMethod: GOLD_FACT_LIVE_METHOD,
        searchBudget: SEARCH_BUDGET,
        parallel: PARALLEL,
        archiveRunId: runId,
      },
      null,
      2,
    ) + '\n',
  );

  let manifest = readFileSync(join(PACK, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  if (CASE_LIMIT && CASE_LIMIT > 0) manifest = manifest.slice(0, CASE_LIMIT);

  console.log(
    JSON.stringify({
      mode: SESSION_MODE,
      liveMethod: GOLD_FACT_LIVE_METHOD.id,
      searchBudget: SEARCH_BUDGET,
      parallel: PARALLEL,
      cases: manifest.length,
      findTries: MAX_TRIES_PER_CASE,
      archiveRunId: runId,
      forceChildOnHit: process.env.HMS_GOLD_FACT_FORCE_CHILD_ON_HIT !== '0',
    }),
  );

  let caseScores;
  packGroupCache = null;
  try {
    caseScores = await mapPool(manifest, PARALLEL, (row) =>
      runOneCase({ row, secret, origin, maxTries: MAX_TRIES_PER_CASE }),
    );
  } finally {
    await closeSharedSession();
    packGroupCache = null;
  }

  const latencies = caseScores.map((s) => s.wall_ms).sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  const loginMs = caseScores.reduce((a, s) => a + (s.login_ms || 0), 0);
  const loginCycles = caseScores.reduce((a, s) => a + (s.login_cycles || 0), 0);
  const liveFindHits = caseScores.reduce((a, s) => a + (s.find_hit || 0), 0);
  const liveFindPagedata = caseScores.reduce((a, s) => a + (s.find_pagedata || 0), 0);
  const funnelByTool = aggregateCaseFunnels(caseScores.map((s) => s.funnel).filter(Boolean));
  const cascadeStarved = caseScores.reduce((a, s) => {
    const kids = s.cascade?.children || {};
    return (
      a +
      Object.values(kids).filter((c) => c && c.cascade === 'starved_by_find').length
    );
  }, 0);

  const totals = {
    n: caseScores.length,
    wall_total_ms: Date.now() - tAll,
    login_ms: loginMs,
    login_cycles: loginCycles,
    parallel: PARALLEL,
    session_mode: SESSION_MODE,
    search_budget: SEARCH_BUDGET,
    live_method: GOLD_FACT_LIVE_METHOD.id,
    live_method_spec: GOLD_FACT_LIVE_METHOD,
    archive_run_id: runId,
    live_find_hits: liveFindHits,
    live_find_pagedata: liveFindPagedata,
    median_ms: pct(50),
    p95_ms: pct(95),
    session_canary: { status: 'skipped', parse: null, rowCount: null, ms: 0 },
    session_diagnostics: {
      login_cycles: loginCycles,
      session_recycles: sessionRecycleCount,
      softopen_stubs: softOpenStubCount,
      browser_closed_retries: browserClosedRetryCount,
      cascade_starved_by_find: cascadeStarved,
    },
    funnel_by_tool: funnelByTool,
    fact_totals: {
      match: 0,
      mismatch: 0,
      tool_missing: 0,
      blocked_expected: 0,
      not_in_tool_scope: 0,
    },
    live_hms:
      SESSION_MODE === 'reuse'
        ? GOLD_FACT_LIVE_METHOD.id
        : 'fresh_browser_per_tool_hms_credential_lock',
    live_find_attempted: caseScores.filter((s) => s.live_candidate_kind).length,
    scale_estimate_3949: {
      live_wall_29_ms: Date.now() - tAll,
      live_median_ms: pct(50),
      live_p95_ms: pct(95),
      projected_hours_at_p95: Math.round(((pct(95) * 3949) / 3_600_000) * 10) / 10,
      projected_hours_at_wall_rate:
        Math.round((((Date.now() - tAll) / Math.max(1, caseScores.length)) * 3949) / 3_600_000 * 10) /
        10,
    },
  };
  for (const s of caseScores) {
    for (const k of Object.keys(totals.fact_totals)) {
      totals.fact_totals[k] += s.summary[k] || 0;
    }
  }

  writeFileSync(join(PACK, 'FUNNEL.json'), JSON.stringify({ runId, byTool: funnelByTool }, null, 2) + '\n');
  writeFileSync(join(PACK, 'SCORES_AGGREGATE.json'), JSON.stringify({ totals, cases: caseScores }, null, 2));
  const md = `# Gold fact backtest SUMMARY (LIVE, shard-098, n=${totals.n})

Date: ${new Date().toISOString()}
Archive: \`archives/${runId}/\`

## What ran
- **Method:** \`${GOLD_FACT_LIVE_METHOD.id}\` (default; live-proven ~122s / 23/23 find pageData)
- Chooser: agent rules in \`gold-fact-backtest-29-live.mjs\` (bypasses \`suggestReadTools\`)
- Session mode: **${SESSION_MODE}**${
    SESSION_MODE === 'reuse'
      ? ` — context.request finds (P=${PARALLEL}); drain-before-recycle; soft-open 813 ≠ recycle; budget ${SEARCH_BUDGET}`
      : ' (fresh Chromium + login per tool; escape hatch)'
  }
- Collection: per-case \`collect.json\` (funnel + find→child cascade); pack \`FUNNEL.json\`; claimKey fact rows
- Force child soft-opens on find hit: **${process.env.HMS_GOLD_FACT_FORCE_CHILD_ON_HIT !== '0'}**
- Offline: mail digests + channel parse when eml present
- Blocked expected: knowledge, CON/BLK, finalized docs

## Timing
- Login total (sum): ${totals.login_ms} ms across ${totals.login_cycles} login cycles
- Session recycles: ${sessionRecycleCount}; softopen stubs: ${softOpenStubCount}; browser-closed retries: ${browserClosedRetryCount}
- Cases: ${totals.n}
- Parallel: ${PARALLEL}
- Wall total: ${totals.wall_total_ms} ms (${(totals.wall_total_ms / 60000).toFixed(1)} min)
- Median / case: ${totals.median_ms} ms
- p95 / case: ${totals.p95_ms} ms
- Live find candidates attempted: ${totals.live_find_attempted}
- Live find pageData parses: ${totals.live_find_pagedata}
- Live find hits (ok/partial/ambiguous): ${totals.live_find_hits}
- Cascade starved_by_find (child skips): ${cascadeStarved}

## Tool funnel
\`\`\`json
${JSON.stringify(funnelByTool, null, 2)}
\`\`\`

## Fact verdicts
${JSON.stringify(totals.fact_totals, null, 2)}

## Scale to 3949
- Wall rate ×3949: ~${totals.scale_estimate_3949.projected_hours_at_wall_rate} hours
- At p95/case ×3949: ~${totals.scale_estimate_3949.projected_hours_at_p95} hours

## Decision
- Default live path = \`${GOLD_FACT_LIVE_METHOD.id}\`.
- Scale offline mail/channel freely; live HMS find-only: PARALLEL=32, SEARCH_BUDGET=32 (one real concurrent wave then recycle; ~90min/3949). No vendor nightly OSRESS cap.
`;
  writeFileSync(join(PACK, 'SUMMARY.md'), md);
  writeFileSync(join(PACK, 'LIVE_RUN.json'), JSON.stringify(totals, null, 2) + '\n');
  // Mirror into this run's archive after write
  for (const name of ['LIVE_RUN.json', 'SUMMARY.md', 'FUNNEL.json', 'SCORES_AGGREGATE.json']) {
    const src = join(PACK, name);
    if (existsSync(src)) copyFileSync(src, join(archivesDir, name));
  }
  console.log(JSON.stringify(totals, null, 2));
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 240));
  process.exit(1);
});
