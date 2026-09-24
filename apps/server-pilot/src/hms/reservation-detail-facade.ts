/**
 * Guest Stay detail open (inert). Wave A1 surface — allowed here; denied on find.
 * Prefer Playwright dblclick on the matched ExtJS result row; when the grid is not
 * painted, replay the reviewed OSRESV → OSRESV.LST → OSRESV.HDR read chain. Never save.
 */
import type { ReservationDetailDumpV1 } from './reservation-detail-projection.js';
import type { HmsPage, HmsReadSession } from './runtime.js';
import { HmsRuntimeError } from './runtime.js';

export interface ReservationDetailFacade {
  /** Open matched search-grid row into detail; return key inventory (+ optional values). */
  openMatchedRowAndDump(options?: {
    captureValues?: boolean;
    /** Confirmation / external ref token expected in the result row text. */
    matchToken?: string;
    /** OSRESS GRID DATA.id opaque row binding, when present. */
    reservationStayId?: string | null;
  }): Promise<ReservationDetailDumpV1>;
}

type FormDump = {
  keys: string[];
  values: Record<string, string>;
  searchChrome: boolean;
  filledNonSearch: number;
};

const SEARCH_CHROME_KEYS = new Set([
  'search',
  'dataspylist',
  'showfilter',
  'filterfields',
  'selfiltervaluectrl',
  'appmenusearch',
]);

async function collectFormKeys(page: HmsPage): Promise<FormDump> {
  return page.evaluateStableDom(() => {
    const doc = (
      globalThis as unknown as {
        document?: {
          querySelectorAll(sel: string): ArrayLike<{
            getAttribute(name: string): string | null;
            value?: string;
          }>;
        };
      }
    ).document;
    const keys = new Set<string>();
    const values: Record<string, string> = {};
    if (!doc) {
      return { keys: [], values: {}, searchChrome: false, filledNonSearch: 0 };
    }
    const nodes = doc.querySelectorAll('input[name], select[name], textarea[name]');
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const name = (node.getAttribute('name') || '').trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      const normalized = lower.replace(/^ff_/, '').replace(/^filter_/, '');
      keys.add(normalized);
      keys.add(lower);
      const raw = typeof node.value === 'string' ? node.value : '';
      const valueLimit = /note|remark|comment|trace|message|instruction|request/i.test(lower)
        ? 2_000
        : 256;
      if (raw && raw.length <= valueLimit && !/password|secret|token|cookie/i.test(lower)) {
        values[normalized] = raw;
      }
    }
    const keyList = Array.from(keys);
    const searchChrome = keyList.some((k) =>
      ['search', 'dataspylist', 'showfilter', 'filterfields', 'selfiltervaluectrl'].includes(k),
    );
    let filledNonSearch = 0;
    for (const [k, v] of Object.entries(values)) {
      if (!v) continue;
      if (
        [
          'search',
          'dataspylist',
          'showfilter',
          'filterfields',
          'selfiltervaluectrl',
          'appmenusearch',
        ].includes(k)
      ) {
        continue;
      }
      filledNonSearch += 1;
    }
    return { keys: keyList.sort(), values, searchChrome, filledNonSearch };
  });
}

function dumpFromForm(collected: FormDump, captureValues: boolean): ReservationDetailDumpV1 {
  const dump: ReservationDetailDumpV1 = {
    schemaVersion: 1,
    surface: 'guest_stay_detail',
    keys: collected.keys.filter((k) => !SEARCH_CHROME_KEYS.has(k)),
  };
  if (captureValues) {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(collected.values)) {
      if (SEARCH_CHROME_KEYS.has(k)) continue;
      values[k] = v;
    }
    dump.values = values;
  }
  return dump;
}

function dumpWithoutRateDetailsClick(
  collected: FormDump,
  captureValues: boolean,
): ReservationDetailDumpV1 {
  const dump = dumpFromForm(collected, captureValues);
  if (!captureValues) return dump;
  return {
    ...dump,
    values: { ...(dump.values ?? {}), rateDetailsClicked: 'false' },
  };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findJsonObjectEnd(text: string, start: number): number {
  if (start < 0 || text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = '';
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function extractJsonObjectAt(text: string, start: number): UnknownRecord | null {
  const end = findJsonObjectEnd(text, start);
  if (end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractPageDataValues(body: string): UnknownRecord | null | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.pageData) && 'values' in parsed.pageData) {
      return isRecord(parsed.pageData.values) ? parsed.pageData.values : null;
    }
  } catch {
    // Infor may quote pageData while leaving values as an object-literal key.
  }

  const pageDataMarkers = ['pageData:', '"pageData":', "'pageData':"];
  const valuesMarkers = ['values:', '"values":', "'values':"];
  for (const pageDataMarker of pageDataMarkers) {
    const pageDataIndex = body.indexOf(pageDataMarker);
    if (pageDataIndex < 0) continue;
    const pageDataBrace = body.indexOf('{', pageDataIndex + pageDataMarker.length - 1);
    const pageDataEnd = findJsonObjectEnd(body, pageDataBrace);
    const valuesStart = pageDataIndex + pageDataMarker.length;
    for (const valuesMarker of valuesMarkers) {
      const valuesIndex = body.indexOf(valuesMarker, valuesStart);
      if (valuesIndex < 0 || (pageDataEnd >= 0 && valuesIndex >= pageDataEnd)) continue;
      let brace = valuesIndex + valuesMarker.length;
      while (brace < body.length && /\s/.test(body[brace]!)) brace += 1;
      if (body[brace] !== '{') return null;
      if (pageDataEnd >= 0 && brace >= pageDataEnd) return null;
      return extractJsonObjectAt(body, brace);
    }
  }
  return undefined;
}

function collectFields(
  value: unknown,
  addField: (name: string, value: unknown) => void,
  depth = 0,
): void {
  if (depth > 8 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectFields(item, addField, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as UnknownRecord)) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      addField(key, item);
    } else {
      addField(key, undefined);
      collectFields(item, addField, depth + 1);
    }
  }
}

function finishFieldDump(keys: Set<string>, values: Record<string, string>): FormDump {
  const keyList = Array.from(keys).sort();
  const searchChrome = keyList.some((k) =>
    ['search', 'dataspylist', 'showfilter', 'filterfields', 'selfiltervaluectrl'].includes(k),
  );
  // HDR body is not the search filter surface when it carries stay identity keys.
  const stayHints = [
    'confirmationnumber',
    'arrivaldate',
    'departuredate',
    'roomtype',
    'status',
    'guestname',
    'primaryguest',
    'lastname',
    'firstname',
  ];
  const filledNonSearch = Object.entries(values).filter(([key, value]) => {
    if (!value || SEARCH_CHROME_KEYS.has(key)) return false;
    return (
      stayHints.includes(key) || /arrival|departure|guest|room|rate|status|confirmation/i.test(key)
    );
  }).length;
  return { keys: keyList, values, searchChrome, filledNonSearch };
}

const DETAIL_REFERENCE_KEYS = new Set([
  'confirmationnumber',
  'externalconfirmation',
  'externalreference',
  'externalreference1',
]);
const DETAIL_STAY_ID_KEYS = new Set(['reservationstayid', 'id']);
const HOTEL_MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const OSRESV_ROW_OPEN_FIELDS = {
  SYSTEM_FUNCTION_NAME: 'OSRESV',
  USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'HDR',
  MENU_MODULE_KEY: '0',
  removescreenflows: 'yes',
  DEFAULT_VIEW: 'HDR',
  SAVE_FOR_HEADER: 'true',
  startUpView: 'right',
  GRIDPARAM_ADDON_SORT_ELEMENT_ALIAS_NAME: 'primaryguest',
  GRIDPARAM_ADDON_SORT_ELEMENT_TYPE: 'DESC',
} as const;

const OSRESV_LST_FIXED_FIELDS = {
  SYSTEM_FUNCTION_NAME: 'OSRESV',
  USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'LST',
  MENU_MODULE_KEY: '0',
  removescreenflows: 'yes',
  ADDONS_REQUIRED: 'true',
  RUN_DS: 'false',
  filterfields: 'confirmationnumber',
  filteroperator: '=',
  ADDON_SORT_ELEMENT_ALIAS_NAME: 'primaryguest',
  ADDON_SORT_ELEMENT_TYPE: 'DESC',
} as const;

const OSRESV_HDR_ROW_FIELDS = [
  'confirmationnumber',
  'reservationstayid',
  'propertycode',
  'guestfullname',
  'account',
  'guestid',
  'hoteldate',
  'lastname',
  'firstname',
  'twitterid',
  'facebookid',
  'tripadvisorid',
  'bookingdotcomid',
  'room',
] as const;

export type OsresvLstBinding = {
  opaqueRowId: string;
  reservationStayId: string;
  hdrFields: Record<string, string>;
};

function normalizedFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^ff_/, '')
    .replace(/^filter_/, '');
}

function detailIdentityMatches(collected: FormDump, matchToken: string, stayId: string): boolean {
  const expectedReference = matchToken.trim().toLowerCase();
  const expectedStayId = stayId.trim().toLowerCase();
  if (!expectedReference && !expectedStayId) return true;

  const referenceValues = Object.entries(collected.values)
    .filter(([key, value]) => DETAIL_REFERENCE_KEYS.has(normalizedFieldName(key)) && value.trim())
    .map(([, value]) => value.trim().toLowerCase());
  if (expectedReference && !referenceValues.includes(expectedReference)) return false;

  const stayIdValues = Object.entries(collected.values)
    .filter(([key, value]) => DETAIL_STAY_ID_KEYS.has(normalizedFieldName(key)) && value.trim())
    .map(([, value]) => value.trim().toLowerCase());
  if (expectedStayId && !stayIdValues.includes(expectedStayId)) return false;

  return true;
}

export function parseReservationDetailBody(body: string): FormDump {
  const keys = new Set<string>();
  const values: Record<string, string> = {};
  const addField = (rawName: string, rawValue: unknown): void => {
    const name = rawName.trim().toLowerCase();
    if (!name) return;
    const normalized = name.replace(/^ff_/, '').replace(/^filter_/, '');
    keys.add(normalized);
    keys.add(name);
    // Preserve the UI's explicit unassigned-room wire value for child reads.
    // Missing fields, identities and financial nulls remain unknown.
    if (normalized === 'room' && (rawValue === null || rawValue === '')) {
      values[normalized] = '';
    }
    if (rawValue == null) return;
    const value = String(rawValue).trim();
    const valueLimit = /note|remark|comment|trace|message|instruction|request/i.test(normalized)
      ? 2_000
      : 256;
    if (value && value.length <= valueLimit && !/password|secret|token|cookie/i.test(normalized)) {
      values[normalized] = value;
    }
  };

  const pageDataValues = extractPageDataValues(body);
  if (pageDataValues !== undefined) {
    if (pageDataValues) collectFields(pageDataValues, addField);
    return finishFieldDump(keys, values);
  }

  // Some tenants return a normal HTML detail form rather than a flat JSON
  // envelope. Preserve only field names/values; never log or retain raw body.
  for (const tag of body.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
    const html = tag[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
    if (!name) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? '';
    addField(name, value);
  }

  try {
    collectFields(JSON.parse(body), addField);
  } catch {
    // HTML / JavaScript wrappers are handled by the bounded regexes below.
  }

  for (const m of body.matchAll(/\bname=["']([^"']+)["']/gi)) {
    addField(m[1] || '', undefined);
  }
  for (const m of body.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    addField(m[1]!, m[2]!);
  }
  for (const m of body.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    addField(m[1]!, undefined);
  }
  return finishFieldDump(keys, values);
}

function parseJsonRecord(body: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function primitiveFields(value: UnknownRecord): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    // An unassigned room is null in LST, but the captured UI sends room=""
    // in HDR (including Reserved/Cancelled stays). This is a wire default,
    // not a reservation edit or a default for missing identity fields.
    if (rawKey.trim().toLowerCase() === 'room' && rawValue === null) {
      fields.room = '';
      continue;
    }
    if (
      rawValue === null ||
      (typeof rawValue !== 'string' &&
        typeof rawValue !== 'number' &&
        typeof rawValue !== 'boolean')
    ) {
      continue;
    }
    fields[rawKey.trim().toLowerCase()] = String(rawValue).trim();
  }
  return fields;
}

/** Parse only the reviewed OSRESV.LST GRID.DATA envelope; malformed shapes yield no rows. */
export function parseOsresvLstRows(body: string): Array<Record<string, string>> {
  const root = parseJsonRecord(body);
  const pageData = root && isRecord(root.pageData) ? root.pageData : null;
  const grid = pageData && isRecord(pageData.grid) ? pageData.grid : null;
  const result = grid && isRecord(grid.GRIDRESULT) ? grid.GRIDRESULT : null;
  const gridData = result && isRecord(result.GRID) ? result.GRID : null;
  const data = gridData?.DATA;
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map(primitiveFields);
}

function normalizedReferenceValue(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function normalizeHotelDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '';
  let year = 0;
  let month = 0;
  let day = 0;
  let match = /^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{4})$/.exec(value);
  if (match) {
    day = Number(match[1]);
    month = HOTEL_MONTHS[match[2]!.toUpperCase()] ?? 0;
    year = Number(match[3]);
  } else if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value))) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    return null;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
  if (!daysInMonth || day < 1 || day > daysInMonth) return null;
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

/** Bind one LST row to the exact token + opaque OSRESS row id before constructing HDR. */
export function extractBoundOsresvLstRow(
  body: string,
  matchToken: string,
  opaqueRowId: string,
): OsresvLstBinding | null {
  const expectedToken = normalizedReferenceValue(matchToken);
  const expectedOpaqueId = opaqueRowId.trim();
  if (!expectedToken) return null;
  const rows = parseOsresvLstRows(body);
  const matches = rows.filter((row) => {
    if (expectedOpaqueId && (row.id || '').trim() !== expectedOpaqueId) return false;
    const references = Array.from(DETAIL_REFERENCE_KEYS, (key) =>
      normalizedReferenceValue(row[key]),
    );
    return references.includes(expectedToken);
  });
  if (matches.length !== 1) return null;

  const row = matches[0]!;
  const actualOpaqueId = row.id?.trim() || '';
  const reservationStayId = row.reservationstayid?.trim() || '';
  const confirmationNumber = row.confirmationnumber?.trim() || '';
  const propertyCode = row.propertycode?.trim() || '';
  if (!actualOpaqueId || !reservationStayId || !confirmationNumber || propertyCode !== 'HRCEN') {
    return null;
  }

  const hdrFields: Record<string, string> = {
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'HDR',
  };
  for (const key of OSRESV_HDR_ROW_FIELDS) {
    const value = row[key];
    if (value === undefined) continue;
    if (key === 'hoteldate') {
      const normalized = normalizeHotelDate(value);
      if (normalized === null) return null;
      hdrFields[key] = normalized;
    } else {
      hdrFields[key] = value;
    }
  }
  if (
    hdrFields.confirmationnumber !== confirmationNumber ||
    hdrFields.reservationstayid !== reservationStayId ||
    hdrFields.propertycode !== propertyCode
  ) {
    return null;
  }
  return { opaqueRowId: actualOpaqueId, reservationStayId, hdrFields };
}

function keysFromHdrBody(body: string): FormDump {
  return parseReservationDetailBody(body);
}

async function waitDetailForm(page: HmsPage, budgetMs: number): Promise<FormDump | null> {
  let collected: FormDump | null = null;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    collected = await collectFormKeys(page);
    if (
      collected.filledNonSearch >= 3 &&
      !(collected.searchChrome && collected.filledNonSearch < 3)
    ) {
      return collected;
    }
    if (collected.filledNonSearch >= 3) return collected;
  }
  return collected;
}

async function enrichWithRateDetailsClick(
  page: HmsPage,
  baseDump: ReservationDetailDumpV1,
): Promise<ReservationDetailDumpV1> {
  try {
    const clicked = await page.evaluateStableDom(() => {
      const doc = (
        globalThis as unknown as {
          document?: {
            querySelectorAll(selector: string): ArrayLike<{
              getAttribute(name: string): string | null;
              dispatchEvent(event: unknown): void;
              closest(selector: string): { dispatchEvent(event: unknown): void } | null;
            }>;
          };
          MouseEvent?: new (type: string, init?: unknown) => unknown;
        }
      ).document;
      if (!doc) return false;
      const imgs = Array.from(doc.querySelectorAll('img'));
      const MouseEventCtor = (
        globalThis as unknown as {
          MouseEvent?: new (type: string, init?: unknown) => unknown;
        }
      ).MouseEvent;
      if (!MouseEventCtor) return false;
      for (const img of imgs) {
        const srcAttr = img.getAttribute('src') || '';
        const title = img.getAttribute('title') || img.getAttribute('data-qtip') || '';
        if (/rate-details/i.test(srcAttr) || /rate\s*detail/i.test(title)) {
          img.dispatchEvent(new MouseEventCtor('click', { bubbles: true }));
          const parent = img.closest('a,button,div,span');
          if (parent) {
            parent.dispatchEvent(new MouseEventCtor('click', { bubbles: true }));
          }
          return true;
        }
      }
      return false;
    });
    if (!clicked) {
      return {
        ...baseDump,
        values: { ...baseDump.values, rateDetailsClicked: 'false' },
      };
    }
    await new Promise((r) => setTimeout(r, 4_000));
    const after = await collectFormKeys(page);
    const rateKeys = after.keys.filter((k) => !SEARCH_CHROME_KEYS.has(k));
    return {
      ...baseDump,
      keys: Array.from(
        new Set([...(baseDump.keys || []), ...rateKeys.map((k) => `ratedetails.${k}`)]),
      ).sort(),
      values: {
        ...baseDump.values,
        rateDetailsClicked: 'true',
        rateDetailsKeyCount: String(rateKeys.length),
      },
    };
  } catch {
    return {
      ...baseDump,
      values: { ...baseDump.values, rateDetailsClicked: 'error' },
    };
  }
}

async function openBoundDetailFromLst(input: {
  page: HmsPage;
  origin: string;
  matchToken: string;
  opaqueRowId: string;
  captureValues: boolean;
}): Promise<ReservationDetailDumpV1> {
  await input.page.postForm(`${input.origin}/web/base/OSRESV?USER_FUNCTION_NAME=OSRESV`, {
    ...OSRESV_ROW_OPEN_FIELDS,
    confirmationnumber: input.matchToken,
  });
  const lstBody = await input.page.postForm(`${input.origin}/web/base/OSRESV.LST`, {
    ...OSRESV_LST_FIXED_FIELDS,
    filtervalue: input.matchToken,
  });
  const binding = extractBoundOsresvLstRow(lstBody || '', input.matchToken, input.opaqueRowId);
  if (!binding) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail row binding failed');
  }

  const hdrBody = await input.page.postForm(
    `${input.origin}/web/base/OSRESV.HDR`,
    binding.hdrFields,
  );
  const fromBody = keysFromHdrBody(hdrBody || '');
  if (
    fromBody.filledNonSearch >= 3 &&
    detailIdentityMatches(fromBody, input.matchToken, binding.reservationStayId)
  ) {
    // The response is already bound to the validated LST row. Do not inspect
    // or click a possibly stale DOM from another record after this success.
    return dumpWithoutRateDetailsClick(fromBody, input.captureValues);
  }

  const collected = await waitDetailForm(input.page, 8_000);
  if (collected && collected.filledNonSearch >= 3) {
    if (detailIdentityMatches(collected, input.matchToken, binding.reservationStayId)) {
      return enrichWithRateDetailsClick(input.page, dumpFromForm(collected, input.captureValues));
    }
  }
  throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail identity mismatch');
}

export function createReservationDetailFacade(input: {
  session: HmsReadSession;
}): ReservationDetailFacade {
  return {
    async openMatchedRowAndDump(options) {
      const page = input.session.page;
      const matchToken = (options?.matchToken || '').trim();
      const stayId = (options?.reservationStayId || '').trim();
      let opened = false;
      let lastOpenError: unknown;

      // A matched OSRESS row carries an opaque id, not the final
      // reservationstayid used by HDR.  When that id is available, skip the
      // DOM double-click and use the reviewed row-open → LST → HDR chain.
      // The DOM path remains for older search responses that have no opaque id.
      if (!stayId && matchToken && typeof page.dblclickRowContaining === 'function') {
        try {
          await page.dblclickRowContaining(matchToken);
          opened = true;
        } catch (err) {
          lastOpenError = err;
        }
      }

      if (!stayId && !opened) {
        const selectors = ['.x-grid3-row', '.x-grid-row', 'tr.x-grid3-row'];
        for (const selector of selectors) {
          try {
            await page.dblclick(selector);
            opened = true;
            break;
          } catch (err) {
            lastOpenError = err;
            try {
              await page.click(selector);
              await new Promise((resolve) => setTimeout(resolve, 250));
              await page.dblclick(selector);
              opened = true;
              break;
            } catch (err2) {
              lastOpenError = err2;
            }
          }
        }
      }

      let collected = opened ? await waitDetailForm(page, 12_000) : null;
      if (collected && collected.filledNonSearch >= 3) {
        if (detailIdentityMatches(collected, matchToken, stayId)) {
          return enrichWithRateDetailsClick(
            page,
            dumpFromForm(collected, Boolean(options?.captureValues)),
          );
        }
        lastOpenError = new Error('detail identity mismatch');
      }

      if (matchToken) {
        try {
          return await openBoundDetailFromLst({
            page,
            origin: input.session.origin,
            matchToken,
            opaqueRowId: stayId,
            captureValues: Boolean(options?.captureValues),
          });
        } catch (err) {
          lastOpenError = err;
        }
      }

      if (matchToken || stayId) {
        const msg = lastOpenError instanceof Error ? lastOpenError.message : 'row binding failed';
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          msg.startsWith('guest stay detail ') ? msg : `guest stay detail ${msg}`,
        );
      }
      if (!opened) {
        const msg = lastOpenError instanceof Error ? lastOpenError.message.slice(0, 120) : '';
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          msg
            ? `guest stay detail open: no grid row (${msg})`
            : 'guest stay detail open: no grid row',
        );
      }
      if (!collected || collected.keys.length === 0) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail dump produced zero form keys');
      }
      if (collected.searchChrome && collected.filledNonSearch < 3) {
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          'guest stay detail open still on search chrome (no stay fields filled)',
        );
      }
      return enrichWithRateDetailsClick(
        page,
        dumpFromForm(collected, Boolean(options?.captureValues)),
      );
    },
  };
}
