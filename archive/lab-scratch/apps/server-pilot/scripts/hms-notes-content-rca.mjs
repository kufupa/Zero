/**
 * Notes 3/15 RCA: for each unique confirmation in the soft-15 cand set,
 * find → soft-open note/trace tabs → also dump HDR/detail note fields.
 * Reports empty note text vs tab-open failure vs find miss.
 *
 * Env: CAND, OUT, HMS_READ_SECRET_ARN, HMS_CHROMIUM_EXECUTABLE_PATH, AWS_REGION
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';

const UNUSED = '___NOMATCH___';
const cands = JSON.parse(readFileSync(process.env.CAND, 'utf8')).slice(0, 15);

function searchBodyFor(confVal) {
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
    MADDON_FILTER_VALUE_5: UNUSED,
    MADDON_LPAREN_5: 'false',
    MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
    MADDON_FILTER_OPERATOR_6: 'BEGINS',
    MADDON_FILTER_JOINER_6: 'OR',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: UNUSED,
    MADDON_RPAREN_6: 'false',
    MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
    MADDON_FILTER_OPERATOR_7: 'BEGINS',
    MADDON_FILTER_JOINER_7: 'OR',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: UNUSED,
    MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
    MADDON_FILTER_OPERATOR_8: 'BEGINS',
    MADDON_FILTER_JOINER_8: 'OR',
    MADDON_FILTER_SEQNUM_8: '8',
    MADDON_FILTER_VALUE_8: UNUSED,
    MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
    MADDON_FILTER_OPERATOR_9: 'BEGINS',
    MADDON_FILTER_JOINER_9: 'OR',
    MADDON_FILTER_SEQNUM_9: '9',
    MADDON_FILTER_VALUE_9: UNUSED,
    MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
    MADDON_FILTER_OPERATOR_10: 'BEGINS',
    MADDON_FILTER_JOINER_10: 'OR',
    MADDON_FILTER_SEQNUM_10: '10',
    MADDON_FILTER_VALUE_10: UNUSED,
    MADDON_RPAREN_10: 'true',
    externalconfirmation: UNUSED,
  };
}

function parse(text) {
  let idx = text.indexOf('pageData:');
  let ml = 9;
  if (idx < 0) {
    const m = /"pageData"\s*:/.exec(text);
    if (!m) return { rows: [], parse: 'no' };
    idx = m.index;
    ml = m[0].length;
  }
  let i = idx + ml;
  while (i < text.length && /\s/.test(text[i])) i++;
  let d = 0;
  let e = i;
  for (; e < text.length; e++) {
    if (text[e] === '{') d++;
    else if (text[e] === '}') {
      d--;
      if (d === 0) {
        e++;
        break;
      }
    }
  }
  try {
    const pd = JSON.parse(text.slice(i, e));
    const data = pd?.grid?.GRIDRESULT?.GRID?.DATA ?? [];
    return {
      parse: 'ok',
      rows: data.map((r) => ({
        confirmation:
          r.confirmationnumber != null ? String(r.confirmationnumber) : null,
        stayId: r.id != null ? String(r.id) : null,
      })),
    };
  } catch {
    return { rows: [], parse: 'fail' };
  }
}

/** Extract note-ish field values from Ext pageData / form payloads (no full body). */
function extractNoteFields(text) {
  const out = {
    reservationnote: null,
    cancellationnote: null,
    keysHit: [],
    valueLens: {},
  };
  const keyRe =
    /"(ff_)?(filter_)?(reservationnote|cancellationnote|guestnote|specialrequest|comment|remarks|tracenote|alertnote)"\s*:\s*("([^"\\]|\\.)*"|null)/gi;
  let m;
  while ((m = keyRe.exec(text))) {
    const key = (m[3] || '').toLowerCase();
    out.keysHit.push(key);
    let raw = m[4];
    if (raw === 'null') {
      out.valueLens[key] = 0;
      continue;
    }
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = String(raw).replace(/^"|"$/g, '');
    }
    const trimmed = String(raw ?? '').trim();
    out.valueLens[key] = trimmed.length;
    if (key === 'reservationnote' && trimmed) out.reservationnote = trimmed.slice(0, 120);
    if (key === 'cancellationnote' && trimmed) out.cancellationnote = trimmed.slice(0, 120);
  }
  // also scan unquoted Ext form field names
  for (const key of ['reservationnote', 'cancellationnote']) {
    const re = new RegExp(`${key}["'\\s:=]+([^"'\\\\<\\n]{0,200})`, 'i');
    const mm = re.exec(text);
    if (mm && !out.valueLens[key]) {
      const t = mm[1].trim();
      if (t && t !== 'null' && t !== ':' && t.length > 0) {
        out.valueLens[key] = t.length;
        out[key] = t.slice(0, 120);
        out.keysHit.push(key);
      }
    }
  }
  return out;
}

function summarizeProbe(path, text) {
  const fields = extractNoteFields(text);
  return {
    path,
    bytes: text.length,
    hasPageData: /pageData/i.test(text) || /classPath/i.test(text),
    stub813: text.length === 813,
    httpHint: text.startsWith('<') ? 'html' : text.slice(0, 12),
    keyHits: [...text.matchAll(/"(note|trace|comment|remark|special)[^"]*"/gi)].length,
    noteFields: {
      reservationnoteLen: fields.valueLens.reservationnote ?? null,
      cancellationnoteLen: fields.valueLens.cancellationnote ?? null,
      keysHit: [...new Set(fields.keysHit)],
      // redact: only lengths + first 40 chars presence flag
      reservationnotePreview: fields.reservationnote
        ? `[len=${fields.reservationnote.length}] ${fields.reservationnote.slice(0, 40)}…`
        : null,
      cancellationnotePreview: fields.cancellationnote
        ? `[len=${fields.cancellationnote.length}] ${fields.cancellationnote.slice(0, 40)}…`
        : null,
    },
  };
}

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'af-south-1',
});
const res = await client.send(
  new GetSecretValueCommand({ SecretId: process.env.HMS_READ_SECRET_ARN }),
);
const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
const origin = new URL(secret.loginUrl).origin;

// unique confs preserving first email
const seen = new Set();
const unique = [];
for (const c of cands) {
  if (seen.has(c.value)) continue;
  seen.add(c.value);
  unique.push(c);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH,
});

async function withLogin(fn) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname))
      return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page
    .locator('input[name=userid], input[name=username], input[name=j_username]')
    .first()
    .fill(secret.username);
  await page.locator('input[name=password]').fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60000 }).catch(() => null),
    page
      .getByRole('button', { name: 'Sign in' })
      .click()
      .catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
  ]);
  await page.waitForTimeout(3500);
  try {
    return await fn(ctx, page);
  } finally {
    await ctx.close();
  }
}

const rows = [];
for (const c of unique) {
  const row = await withLogin(async (ctx) => {
    const fr = await ctx.request.post(`${origin}/web/base/OSRESS.search`, {
      form: searchBodyFor(c.value),
      timeout: 60000,
    });
    const ft = await fr.text();
    const parsed = parse(ft);
    const top = parsed.rows[0];
    const hit = parsed.parse === 'ok' && top && (top.confirmation || top.stayId);
    const out = {
      emailId: c.email_id,
      conf: c.value,
      find: hit ? 'hit' : 'not_found',
      findBytes: ft.length,
      findStub813: ft.length === 813,
      stayId: top?.stayId ?? null,
      confirmation: top?.confirmation ?? null,
    };
    if (!hit) {
      out.notesGate = 'skipped_need_find';
      out.detailNote = null;
      out.probes = [];
      return out;
    }
    const base = {
      confirmationnumber: top.confirmation || c.value,
      propertycode: 'HRCEN',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    };
    if (top.stayId) {
      base.reservationstayid = top.stayId;
      base.id = top.stayId;
    }
    const probes = [];
    for (const path of [
      'OSRESV.HDR',
      'OSRESV.TRC',
      'OSRESV.NTE',
      'OSRESV.NOTE',
      'OSRESS.TRC',
      'OSRESS.NTE',
    ]) {
      const [sys, tab] = path.split('.');
      const r = await ctx.request.post(`${origin}/web/base/${path}`, {
        form: {
          ...base,
          CURRENT_TAB_NAME: tab,
          SYSTEM_FUNCTION_NAME: sys,
          USER_FUNCTION_NAME: sys === 'OSRESS' ? 'OSRESV' : sys,
        },
        timeout: 60000,
      });
      const t = await r.text();
      probes.push(summarizeProbe(path, t));
    }
    const hdr = probes.find((p) => p.path === 'OSRESV.HDR');
    const softOk = probes.some(
      (p) =>
        p.path !== 'OSRESV.HDR' &&
        p.hasPageData &&
        !p.stub813 &&
        (p.keyHits > 0 || p.bytes > 500),
    );
    const anyNoteText =
      probes.some(
        (p) =>
          (p.noteFields.reservationnoteLen ?? 0) > 0 ||
          (p.noteFields.cancellationnoteLen ?? 0) > 0,
      ) || false;
    out.notesGate = softOk ? 'ok' : 'mismatch';
    out.anyNoteText = anyNoteText;
    out.detailNote = hdr
      ? {
          bytes: hdr.bytes,
          stub813: hdr.stub813,
          reservationnoteLen: hdr.noteFields.reservationnoteLen,
          cancellationnoteLen: hdr.noteFields.cancellationnoteLen,
          reservationnotePreview: hdr.noteFields.reservationnotePreview,
          cancellationnotePreview: hdr.noteFields.cancellationnotePreview,
          keysHit: hdr.noteFields.keysHit,
        }
      : null;
    out.probes = probes.map((p) => ({
      path: p.path,
      bytes: p.bytes,
      hasPageData: p.hasPageData,
      stub813: p.stub813,
      keyHits: p.keyHits,
      reservationnoteLen: p.noteFields.reservationnoteLen,
      cancellationnoteLen: p.noteFields.cancellationnoteLen,
      reservationnotePreview: p.noteFields.reservationnotePreview,
      cancellationnotePreview: p.noteFields.cancellationnotePreview,
    }));
    return out;
  });
  rows.push(row);
  console.log(
    JSON.stringify({
      confTail: String(c.value).slice(-8),
      find: row.find,
      notesGate: row.notesGate,
      anyNoteText: row.anyNoteText ?? false,
      resNoteLen: row.detailNote?.reservationnoteLen ?? null,
      canNoteLen: row.detailNote?.cancellationnoteLen ?? null,
    }),
  );
}

await browser.close();

const hitRows = rows.filter((r) => r.find === 'hit');
const digest = {
  when: new Date().toISOString(),
  nCands: cands.length,
  nUniqueConfs: unique.length,
  findHits: hitRows.length,
  notesGateOk: rows.filter((r) => r.notesGate === 'ok').length,
  anyNoteTextN: rows.filter((r) => r.anyNoteText).length,
  emptyNoteTextAmongHits: hitRows.filter((r) => r.anyNoteText === false).length,
  verdict: null,
  rows,
};
if (hitRows.length === 0) {
  digest.verdict = 'find_broken_or_poisoned_census';
} else if (digest.anyNoteTextN === 0 && digest.notesGateOk > 0) {
  digest.verdict = 'tabs_open_but_note_fields_empty';
} else if (digest.anyNoteTextN === 0 && digest.notesGateOk === 0) {
  digest.verdict = 'notes_surface_broken_or_empty';
} else if (digest.anyNoteTextN > 0) {
  digest.verdict = 'note_content_present_on_some_hits';
} else {
  digest.verdict = 'inconclusive';
}

writeFileSync(process.env.OUT, JSON.stringify(digest, null, 2));
console.log(
  JSON.stringify({
    phase: 'done',
    findHits: digest.findHits,
    notesGateOk: digest.notesGateOk,
    anyNoteTextN: digest.anyNoteTextN,
    emptyAmongHits: digest.emptyNoteTextAmongHits,
    verdict: digest.verdict,
  }),
);
