import { createHash } from 'node:crypto';

/**
 * Parse OSRESV.FOL / FOL DATA_ONLY transport for folio balance + currency.
 * Fail-closed on card-shaped digit strings. Distinct from OSRESS grid parse.
 */
const SIGNED_MONEY = /^-?(?:0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

const MONEY_KEYS = [
  'foliobalance',
  'balance',
  'totalbalance',
  'guestledgerbalance',
  'ledgerbalance',
] as const;
const CURRENCY_KEYS = ['propertycurrency', 'balancecurr', 'currency'] as const;

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/^ff_/, '')
    .replace(/^filter_/, '');
}

function normalizeMoney(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().replace(/,/g, '');
  if (!SIGNED_MONEY.test(trimmed)) return null;
  // Reject card-shaped digit runs masquerading as money (no decimal).
  if (/^\d{12,19}$/.test(trimmed.replace(/\./g, ''))) return null;
  return trimmed;
}

function normalizeCurrency(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toUpperCase();
  return CURRENCY.test(trimmed) ? trimmed : null;
}

function extractPageDataObject(text: string): Record<string, unknown> | null {
  const markers = ['pageData:', '"pageData":', "'pageData':"] as const;
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx < 0) continue;
    let i = text.indexOf('{', idx + marker.length - 1);
    if (i < 0) continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
          } catch {
            break;
          }
        }
      }
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && /pageData/i.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as { pageData?: unknown };
      if (parsed.pageData && typeof parsed.pageData === 'object') {
        return parsed.pageData as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function gridRows(pageData: Record<string, unknown>): Record<string, unknown>[] {
  const grid = pageData.grid;
  if (!grid || typeof grid !== 'object') return [];
  const gridResult = (grid as Record<string, unknown>).GRIDRESULT;
  if (!gridResult || typeof gridResult !== 'object') return [];
  const inner = (gridResult as Record<string, unknown>).GRID;
  if (!inner || typeof inner !== 'object') return [];
  const data = (inner as Record<string, unknown>).DATA;
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function pickMoney(rec: Record<string, unknown>): string | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) lower[normalizeKey(k)] = v;
  for (const key of MONEY_KEYS) {
    const m = normalizeMoney(lower[key]);
    if (m != null) return m;
  }
  return null;
}

function pickCurrency(rec: Record<string, unknown>): string | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) lower[normalizeKey(k)] = v;
  for (const key of CURRENCY_KEYS) {
    const c = normalizeCurrency(lower[key]);
    if (c != null) return c;
  }
  return null;
}

/** Scan quoted "key":"value" pairs when pageData envelope is missing. */
function scanQuotedPairs(text: string): { totalBalance: string | null; currency: string | null } {
  let totalBalance: string | null = null;
  let currency: string | null = null;
  for (const m of text.matchAll(
    /"(foliobalance|balance|totalbalance|balancecurr|propertycurrency|currency)"\s*:\s*"([^"]*)"/gi,
  )) {
    const key = m[1]!.toLowerCase();
    const val = m[2]!;
    if (MONEY_KEYS.includes(key as (typeof MONEY_KEYS)[number])) {
      totalBalance = normalizeMoney(val) ?? totalBalance;
    }
    if (CURRENCY_KEYS.includes(key as (typeof CURRENCY_KEYS)[number])) {
      currency = normalizeCurrency(val) ?? currency;
    }
  }
  // name="balance" value="12.00" style
  for (const m of text.matchAll(
    /name=["'](ff_)?(foliobalance|balance|totalbalance|balancecurr|propertycurrency|currency)["'][^>]*value=["']([^"']*)["']/gi,
  )) {
    const key = m[2]!.toLowerCase();
    const val = m[3]!;
    if (MONEY_KEYS.includes(key as (typeof MONEY_KEYS)[number])) {
      totalBalance = normalizeMoney(val) ?? totalBalance;
    }
    if (CURRENCY_KEYS.includes(key as (typeof CURRENCY_KEYS)[number])) {
      currency = normalizeCurrency(val) ?? currency;
    }
  }
  return { totalBalance, currency };
}

export type FolioFolParseResult = {
  envelopeRecognized: boolean;
  totalBalance: string | null;
  currency: string | null;
  hasCardLeak: boolean;
};

export function parseFolioFolTransport(text: string): FolioFolParseResult {
  const hasCardLeak =
    /"cardnumber"\s*:\s*"[0-9]{12,}"/i.test(text) ||
    /"paymentcardnumber"\s*:\s*"[0-9]{12,}"/i.test(text) ||
    /"virtualcardnumber"\s*:\s*"[0-9]{12,}"/i.test(text);

  if (text.length === 813 || (/loadLocalizedPage/i.test(text) && text.length < 2000)) {
    return {
      envelopeRecognized: false,
      totalBalance: null,
      currency: null,
      hasCardLeak,
    };
  }

  const pageData = extractPageDataObject(text);
  if (pageData) {
    let totalBalance = pickMoney(pageData);
    let currency = pickCurrency(pageData);
    const fields = pageData.fields;
    if (fields && typeof fields === 'object') {
      totalBalance = totalBalance ?? pickMoney(fields as Record<string, unknown>);
      currency = currency ?? pickCurrency(fields as Record<string, unknown>);
    }
    for (const row of gridRows(pageData)) {
      totalBalance = totalBalance ?? pickMoney(row);
      currency = currency ?? pickCurrency(row);
    }
    return {
      envelopeRecognized: true,
      totalBalance,
      currency,
      hasCardLeak,
    };
  }

  // FOL form HTML without pageData — key scan only.
  if (/osresv/i.test(text) || /CURRENT_TAB_NAME/i.test(text) || /folio/i.test(text)) {
    const scanned = scanQuotedPairs(text);
    return {
      envelopeRecognized: true,
      totalBalance: scanned.totalBalance,
      currency: scanned.currency,
      hasCardLeak,
    };
  }

  return {
    envelopeRecognized: false,
    totalBalance: null,
    currency: null,
    hasCardLeak,
  };
}

/**
 * Identity proven by the already-correlated HDR/LST response.  The FOL
 * transport repeats all of these values except the stay id is named
 * `accountid` in the reviewed OSFOLO grid.
 */
export type FolioFolParentProof = {
  confirmationNumber: string;
  reservationStayId: string;
  propertyCode: string;
  account: string;
  currency: string;
};

export type FolioFolParseContext = {
  evidenceRef: string;
  observedAt: string;
  expiresAt: string;
  sourceUpdatedAt?: string | null;
};

type FolioFact<T> = {
  state: 'known';
  value: T;
  data: T;
  evidenceRef: string;
  observedAt: string;
  sourceUpdatedAt: string | null;
  expiresAt: string;
};

type FolioUnknownFact = {
  state: 'unknown';
  value: null;
  data: null;
  reasonCode: 'SOURCE_UNAVAILABLE';
  evidenceRef: string;
  observedAt: string;
  sourceUpdatedAt: string | null;
  expiresAt: string;
};

type BoundFolioFact<T> = FolioFact<T> | FolioUnknownFact;

export type BoundFolioTransaction = {
  transactionRef: FolioFact<string>;
  folioRef: BoundFolioFact<string>;
  postingDate: FolioFact<string>;
  transactionCode: FolioFact<string>;
  amount: FolioFact<{
    amount: string;
    currency: string;
    basis: 'ledger_movement';
    taxTreatment: 'unknown';
  }>;
};

export type BoundFolioTransactionsSection = {
  state: 'available' | 'partial';
  data: {
    items: BoundFolioTransaction[];
    page: {
      returnedCount: number;
      hasMore: boolean | null;
      nextCursor: string | null;
    };
  };
  completeness: 'complete' | 'partial' | 'unknown';
  issues: Array<{
    code: 'PARTIAL_WINDOW';
    retryable: false;
    safeNextAction: 'manual_review';
  }>;
};

export type BoundFolioBalanceItem = {
  folioRef: FolioFact<string>;
  folioType: FolioFact<
    | 'guest'
    | 'incidentals'
    | 'accounts_receivable'
    | 'ta_co'
    | 'adjustment'
    | 'accounting'
    | 'currency_exchange'
    | 'other'
  >;
  balance: BoundFolioFact<{
    amount: string;
    currency: string;
    basis: 'ledger_balance';
    taxTreatment: 'unknown';
  }>;
};

export type BoundFolioBalancesSection = {
  state: 'available';
  data: { items: BoundFolioBalanceItem[] };
  completeness: 'complete';
  issues: [];
};

export type BoundFolioFolParseResult = {
  envelopeRecognized: boolean;
  scopeVerified: boolean;
  totalBalance: string | null;
  currency: string | null;
  balanceSection: BoundFolioBalancesSection | null;
  section: BoundFolioTransactionsSection | null;
  rowsScanned: number;
  bytesObserved: number;
  hasCardLeak: boolean;
  blocker: string | null;
};

const MAX_BOUND_FOLIO_ROWS = 50;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/;
const CURRENCY_SENTINELS = new Set(['', '-', '--', 'hidden', 'optional', 'protected', 'required']);

const FOLIO_BALANCE_FIELDS = [
  { code: 'GUEST', amountKey: 'guesttotal', currencyKey: 'guesttotalcurr', type: 'guest' },
  {
    code: 'INCID',
    amountKey: 'incidentaltotal',
    currencyKey: 'incidentaltotalcurr',
    type: 'incidentals',
  },
  { code: 'AR', amountKey: 'artotal', currencyKey: 'artotalcurr', type: 'accounts_receivable' },
  { code: 'FOLIO4', amountKey: 'folio4total', currencyKey: 'folio4totalcurr', type: 'ta_co' },
  { code: 'FOLIO5', amountKey: 'folio5total', currencyKey: 'folio5totalcurr', type: 'adjustment' },
  { code: 'FOLIO6', amountKey: 'folio6total', currencyKey: 'folio6totalcurr', type: 'accounting' },
  {
    code: 'FOLIO7',
    amountKey: 'folio7total',
    currencyKey: 'folio7totalcurr',
    type: 'currency_exchange',
  },
  { code: 'FOLIO8', amountKey: 'folio8total', currencyKey: 'folio8totalcurr', type: 'other' },
  { code: 'FOLIO9', amountKey: 'folio9total', currencyKey: 'folio9totalcurr', type: 'other' },
  { code: 'FOLIO10', amountKey: 'folio10total', currencyKey: 'folio10totalcurr', type: 'other' },
  { code: 'FOLIO11', amountKey: 'folio11total', currencyKey: 'folio11totalcurr', type: 'other' },
] as const;

type FolioBalanceCode = (typeof FOLIO_BALANCE_FIELDS)[number]['code'];
const FOLIO_BALANCE_CODES: ReadonlySet<string> = new Set(
  FOLIO_BALANCE_FIELDS.map((field) => field.code),
);

/** Find a balanced JSON-ish object/array while respecting quoted strings. */
function balancedEnd(source: string, start: number, opening: '{' | '['): number {
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The reviewed HMS responses are JSON-ish: a pageData key may be unquoted,
 * values may contain trailing commas, and the shell emits a few invalid
 * `\\-` escapes. Keep extraction narrowly scoped to balanced pageData objects;
 * never scan arbitrary quoted pairs from the whole response.
 */
function extractHmsPageDataRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const markers = /(?:["']pageData["']|pageData)\s*:/gi;
  for (const match of text.matchAll(markers)) {
    const start = text.indexOf('{', match.index! + match[0].length);
    if (start < 0) continue;
    const end = balancedEnd(text, start, '{');
    if (end < 0) continue;
    const raw = text
      .slice(start, end + 1)
      .replace(/\\-/g, '-')
      .replace(/([,{]\s*)([A-Za-z_$][\w$]*):/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      records.push(parsed as Record<string, unknown>);
    } catch {
      // A shell or malformed response is handled as unsupported below.
    }
  }
  return records;
}

/** Extract the first bounded HMS pageData record from a known response shape. */
export function extractHmsPageDataRecord(text: string): Record<string, unknown> | null {
  return extractHmsPageDataRecords(text)[0] ?? null;
}

function extractBoundFolioPageData(
  text: string,
  requireValues = true,
): Record<string, unknown> | null {
  for (const pageData of extractHmsPageDataRecords(text)) {
    if (pageData.grid && (!requireValues || pageData.values)) return pageData;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fieldValue(record: Record<string, unknown>, key: string): unknown {
  const target = key.toLowerCase();
  return Object.entries(record).find(([name]) => name.toLowerCase() === target)?.[1];
}

function fieldText(record: Record<string, unknown>, key: string): string | null {
  return textValue(fieldValue(record, key));
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function validProof(proof: FolioFolParentProof): boolean {
  return [
    proof.confirmationNumber,
    proof.reservationStayId,
    proof.propertyCode,
    proof.account,
  ].every(
    (value) => typeof value === 'string' && value.trim().length > 0 && !CONTROL_TEXT.test(value),
  );
}

function normalizedProof(proof: FolioFolParentProof): FolioFolParentProof | null {
  if (!proof || typeof proof !== 'object') return null;
  if (
    typeof proof.confirmationNumber !== 'string' ||
    typeof proof.reservationStayId !== 'string' ||
    typeof proof.propertyCode !== 'string' ||
    typeof proof.account !== 'string' ||
    typeof proof.currency !== 'string'
  ) {
    return null;
  }
  const normalized = {
    confirmationNumber: proof.confirmationNumber.trim(),
    reservationStayId: proof.reservationStayId.trim(),
    propertyCode: proof.propertyCode.trim(),
    account: proof.account.trim(),
    currency: proof.currency.trim().toUpperCase(),
  };
  if (!validProof(normalized) || !CURRENCY.test(normalized.currency)) return null;
  return normalized;
}

function normalizeBoundMoney(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim().replace(/,/g, '');
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (/\d{12,}/.test(whole!)) return null;
  return `${negative ? '-' : ''}${whole}.${(fraction + '00').slice(0, 2)}`;
}

function normalizePostingDate(raw: unknown): string | null {
  const value = textValue(raw)?.toUpperCase();
  if (!value) return null;
  const match = /^(\d{2})-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-(\d{4})$/.exec(value);
  if (!match) return null;
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  const iso = `${match[3]}-${String(months.indexOf(match[2]!) + 1).padStart(2, '0')}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

function transactionCode(raw: unknown): string | null {
  const value = textValue(raw);
  if (!value || CONTROL_TEXT.test(value) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/.test(value))
    return null;
  return /\d{12,}/.test(value) ? null : value;
}

function pageCurrencyMismatch(values: Record<string, unknown>, expected: string): boolean {
  for (const key of [
    'propertycurrency',
    'balancecurr',
    'currency',
    'hotelcurrency',
    'foliototalcurr',
    'guesttotalcurr',
    'incidentaltotalcurr',
    'artotalcurr',
    'folio4totalcurr',
    'folio5totalcurr',
    'folio6totalcurr',
    'folio7totalcurr',
    'folio8totalcurr',
    'folio9totalcurr',
    'folio10totalcurr',
    'folio11totalcurr',
    'netamountcurrency',
    'foreigncurrency',
  ]) {
    const raw = textValue(fieldValue(values, key));
    if (raw == null || CURRENCY_SENTINELS.has(raw.toLowerCase())) continue;
    if (normalizeCurrency(raw) !== expected) return true;
  }
  return false;
}

function digestRef(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)}`;
}

function issuePartial(): BoundFolioTransactionsSection['issues'][number] {
  return { code: 'PARTIAL_WINDOW', retryable: false, safeNextAction: 'manual_review' };
}

function folioRefValue(proof: FolioFolParentProof, code: FolioBalanceCode): string {
  return digestRef(
    'folio',
    [
      proof.confirmationNumber,
      proof.reservationStayId,
      proof.propertyCode,
      proof.account,
      code,
    ].join('\u0000'),
  );
}

/**
 * Resolve the row's display-only subfolio label through the exact source
 * dropdown options.  Labels are never returned or used as identifiers.
 */
function subfolioCodeForRow(
  values: Record<string, unknown>,
  row: Record<string, unknown>,
): FolioBalanceCode | null {
  const display = fieldValue(row, 'subfolio_display');
  if (typeof display !== 'string' || display.length === 0 || CONTROL_TEXT.test(display)) {
    return null;
  }
  const subfolio = objectValue(fieldValue(values, 'subfolio'));
  const options = subfolio ? fieldValue(subfolio, 'option') : null;
  if (!Array.isArray(options)) return null;
  const matches = options.filter((option) => {
    const candidate = objectValue(option);
    return candidate != null && fieldValue(candidate, 'display') === display;
  });
  if (matches.length !== 1) return null;
  const code = fieldValue(objectValue(matches[0])!, 'value');
  return typeof code === 'string' && FOLIO_BALANCE_CODES.has(code)
    ? (code as FolioBalanceCode)
    : null;
}

function failBoundFolio(
  text: string,
  envelopeRecognized: boolean,
  rowsScanned: number,
  blocker: string,
  hasCardLeak = false,
  scopeVerified = false,
): BoundFolioFolParseResult {
  return {
    envelopeRecognized,
    scopeVerified,
    totalBalance: null,
    currency: null,
    balanceSection: null,
    section: null,
    rowsScanned,
    bytesObserved: Buffer.byteLength(text),
    hasCardLeak,
    blocker,
  };
}

/**
 * Parse the reviewed OSFOLO transport into the closed transaction section.
 * Only pageData proof and DATA row fields observed in network-9 are consumed;
 * descriptions, comments, labels and all other source fields stay discarded.
 */
export function parseBoundFolioFolTransport(
  text: string,
  parentProof: FolioFolParentProof,
  context: FolioFolParseContext,
): BoundFolioFolParseResult {
  const bytesObserved = Buffer.byteLength(text);
  const hasCardLeak =
    /(?:["']?)(?:cardnumber|paymentcardnumber|virtualcardnumber)(?:["']?)\s*:\s*["']\d{12,}/i.test(
      text,
    );
  if (hasCardLeak) return failBoundFolio(text, true, 0, 'FOLIO_PCI_FIELD_SUPPRESSED', true);

  const proof = normalizedProof(parentProof);
  if (!proof) return failBoundFolio(text, false, 0, 'FOLIO_PARENT_BINDING_UNPROVEN');
  if (
    !context ||
    typeof context !== 'object' ||
    typeof context.evidenceRef !== 'string' ||
    typeof context.observedAt !== 'string' ||
    typeof context.expiresAt !== 'string' ||
    !SAFE_REF.test(context.evidenceRef) ||
    CONTROL_TEXT.test(context.evidenceRef)
  ) {
    return failBoundFolio(text, false, 0, 'FOLIO_EVIDENCE_INVALID');
  }
  const pageData = extractBoundFolioPageData(text);
  if (!pageData) return failBoundFolio(text, false, 0, 'FOLIO_UNSUPPORTED_FORMAT');
  const values = objectValue(pageData.values);
  const grid = objectValue(pageData.grid);
  const gridResult = grid ? objectValue(fieldValue(grid, 'GRIDRESULT')) : null;
  const gridInner = gridResult ? objectValue(fieldValue(gridResult, 'GRID')) : null;
  const rowsValue = gridInner ? fieldValue(gridInner, 'DATA') : null;
  const metadata = gridInner ? objectValue(fieldValue(gridInner, 'METADATA')) : null;
  if (!values || !gridInner || !Array.isArray(rowsValue)) {
    return failBoundFolio(text, true, 0, 'FOLIO_UNSUPPORTED_FORMAT');
  }

  if (
    fieldText(values, 'confirmationnumber') !== proof.confirmationNumber ||
    fieldText(values, 'accountid') !== proof.reservationStayId ||
    fieldText(values, 'propertycode') !== proof.propertyCode
  ) {
    return failBoundFolio(text, true, 0, 'FOLIO_PARENT_BINDING_MISMATCH');
  }
  if (fieldText(values, 'account') !== proof.account) {
    return failBoundFolio(text, true, 0, 'FOLIO_ACCOUNT_BINDING_MISMATCH');
  }
  if (pageCurrencyMismatch(values, proof.currency)) {
    return failBoundFolio(text, true, 0, 'FOLIO_CURRENCY_MISMATCH');
  }
  const aggregateCurrency = [
    'foliototalcurr',
    'propertycurrency',
    'balancecurr',
    'hotelcurrency',
    'currency',
    'netamountcurrency',
  ]
    .map((key) => normalizeCurrency(fieldValue(values, key)))
    .find((value): value is string => value != null);
  const aggregateAmount = normalizeBoundMoney(fieldValue(values, 'foliototal'));
  // Proof currency remains available for row/per-folio checks, but an
  // aggregate amount needs an explicit source currency of its own.
  const totalBalance =
    aggregateAmount != null && aggregateCurrency === proof.currency ? aggregateAmount : null;
  const currency = aggregateCurrency ?? proof.currency;

  const fact = <T>(value: T): FolioFact<T> => ({
    state: 'known',
    value,
    data: value,
    evidenceRef: context.evidenceRef,
    observedAt: context.observedAt,
    sourceUpdatedAt: context.sourceUpdatedAt ?? null,
    expiresAt: context.expiresAt,
  });
  const unknownFact = (): FolioUnknownFact => ({
    state: 'unknown',
    value: null,
    data: null,
    reasonCode: 'SOURCE_UNAVAILABLE',
    evidenceRef: context.evidenceRef,
    observedAt: context.observedAt,
    sourceUpdatedAt: context.sourceUpdatedAt ?? null,
    expiresAt: context.expiresAt,
  });
  const balanceItems: BoundFolioBalanceItem[] = FOLIO_BALANCE_FIELDS.map((field) => {
    const amount = normalizeBoundMoney(fieldValue(values, field.amountKey));
    const fieldCurrency = normalizeCurrency(fieldValue(values, field.currencyKey));
    const balance =
      amount != null && fieldCurrency === proof.currency
        ? fact({
            amount,
            currency: proof.currency,
            basis: 'ledger_balance' as const,
            taxTreatment: 'unknown' as const,
          })
        : unknownFact();
    return {
      folioRef: fact(folioRefValue(proof, field.code)),
      folioType: fact(field.type),
      balance,
    };
  });
  const balanceSection: BoundFolioBalancesSection | null =
    totalBalance !== null || balanceItems.some((item) => item.balance.state === 'known')
      ? {
          state: 'available',
          data: { items: balanceItems },
          completeness: 'complete',
          issues: [],
        }
      : null;

  const rows = rowsValue.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && !Array.isArray(row),
  );
  const rowsScanned = rowsValue.length;
  if (rows.length !== rowsScanned)
    return failBoundFolio(text, true, rowsScanned, 'FOLIO_UNSUPPORTED_FORMAT');
  if (rowsScanned > MAX_BOUND_FOLIO_ROWS)
    return failBoundFolio(text, true, rowsScanned, 'FOLIO_BOUNDS_EXCEEDED');

  const items: BoundFolioTransaction[] = [];
  for (const row of rows) {
    if (
      fieldText(row, 'reference') !== proof.confirmationNumber ||
      fieldText(row, 'accountid') !== proof.reservationStayId ||
      fieldText(row, 'propertycode') !== proof.propertyCode
    ) {
      return failBoundFolio(text, true, rowsScanned, 'FOLIO_PARENT_BINDING_MISMATCH');
    }
    if (fieldText(row, 'account') !== proof.account) {
      return failBoundFolio(text, true, rowsScanned, 'FOLIO_ACCOUNT_BINDING_MISMATCH');
    }
    if (normalizeCurrency(fieldValue(row, 'currency')) !== proof.currency) {
      return failBoundFolio(text, true, rowsScanned, 'FOLIO_CURRENCY_MISMATCH');
    }
    const foreign = textValue(fieldValue(row, 'foreigncurrency'));
    if (foreign && normalizeCurrency(foreign) !== proof.currency) {
      return failBoundFolio(text, true, rowsScanned, 'FOLIO_CURRENCY_MISMATCH');
    }
    const amount = normalizeMoney(fieldValue(row, 'amount'));
    const postingDate = normalizePostingDate(fieldValue(row, 'fdate'));
    const code = transactionCode(fieldValue(row, 'transactioncode'));
    if (amount == null || postingDate == null || code == null) {
      return failBoundFolio(text, true, rowsScanned, 'FOLIO_UNSUPPORTED_FORMAT');
    }
    const transactionRef = digestRef(
      'posting',
      ['id', 'line', 'reference', 'accountid', 'fdate', 'transactioncode', 'amount']
        .map((key) => String(fieldValue(row, key) ?? ''))
        .join('\u0000'),
    );
    const folioCode = subfolioCodeForRow(values, row);
    items.push({
      transactionRef: fact(transactionRef),
      folioRef: folioCode ? fact(folioRefValue(proof, folioCode)) : unknownFact(),
      postingDate: fact(postingDate),
      transactionCode: fact(code),
      amount: fact({
        amount,
        currency: proof.currency,
        basis: 'ledger_movement',
        taxTreatment: 'unknown',
      }),
    });
  }

  const count = (key: string): number | null => {
    const value = fieldText(metadata ?? {}, key);
    if (value == null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const records = count('RECORDS');
  const cursor = count('CURRENTCURSORPOSITION');
  if (records == null || records !== rowsScanned || records > MAX_BOUND_FOLIO_ROWS) {
    return failBoundFolio(text, true, rowsScanned, 'FOLIO_PAGING_UNSUPPORTED');
  }
  const more = fieldText(metadata ?? {}, 'MORERECORDPRESENT');
  if (more === '+' || more === 'true') {
    return failBoundFolio(text, true, rowsScanned, 'FOLIO_PAGING_UNSUPPORTED', false, true);
  }
  const complete = more === '-' && cursor === rowsScanned;
  const section: BoundFolioTransactionsSection = {
    state: complete ? 'available' : 'partial',
    data: {
      items,
      page: { returnedCount: items.length, hasMore: complete ? false : null, nextCursor: null },
    },
    completeness: complete ? 'complete' : 'unknown',
    issues: complete ? [] : [issuePartial()],
  };
  return {
    envelopeRecognized: true,
    scopeVerified: true,
    totalBalance,
    currency,
    balanceSection,
    section,
    rowsScanned,
    bytesObserved,
    hasCardLeak: false,
    blocker: null,
  };
}

/**
 * The All Folios DATA_ONLY response is a separate, reviewed source from the
 * bound FOL balance response.  It has no pageData.values envelope, so the
 * already-correlated detail proof is supplied by the caller and every row is
 * checked against it before a posting is projected.
 */
export type FolioAllDataParseContext = FolioFolParseContext & {
  /** 0 for the initial DATA_ONLY page, otherwise the captured CACHE cursor. */
  expectedCursorPosition?: number;
};

export type BoundFolioAllDataParseResult = {
  envelopeRecognized: boolean;
  scopeVerified: boolean;
  items: BoundFolioTransaction[];
  totalRecords: number | null;
  currentCursorPosition: number | null;
  hasMore: boolean | null;
  rowsScanned: number;
  bytesObserved: number;
  sourceHash: string;
  blocker: string | null;
};

const MAX_ALL_DATA_PAGE_ROWS = 50;
const MAX_ALL_DATA_ROWS = 200;
const MAX_ALL_DATA_BYTES = 256 * 1024;
const ALL_DATA_DATASPY_ID = '836';
const ALL_DATA_GRID_ID = '780';
const ALL_DATA_GRID_NAME = 'OSFOLO';

function allDataSourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableAllDataSourceHash(
  items: readonly BoundFolioTransaction[],
  totalRecords: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        totalRecords,
        rows: items.map((item) => ({
          transactionRef: item.transactionRef.value,
          postingDate: item.postingDate.value,
          transactionCode: item.transactionCode.value,
          amount: item.amount.value,
        })),
      }),
      'utf8',
    )
    .digest('hex');
}

function failAllData(
  text: string,
  blocker: string,
  options: {
    envelopeRecognized?: boolean;
    rowsScanned?: number;
    sourceHash?: string;
    hasCardLeak?: boolean;
  } = {},
): BoundFolioAllDataParseResult {
  return {
    envelopeRecognized: options.envelopeRecognized ?? false,
    scopeVerified: false,
    items: [],
    totalRecords: null,
    currentCursorPosition: null,
    hasMore: null,
    rowsScanned: options.rowsScanned ?? 0,
    bytesObserved: Buffer.byteLength(text),
    sourceHash: options.sourceHash ?? allDataSourceHash(text),
    blocker,
  };
}

function parseBoundCount(record: Record<string, unknown>, key: string): number | null {
  const value = fieldText(record, key);
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function allDataContextValid(context: FolioAllDataParseContext): boolean {
  return (
    !!context &&
    typeof context === 'object' &&
    typeof context.evidenceRef === 'string' &&
    typeof context.observedAt === 'string' &&
    typeof context.expiresAt === 'string' &&
    SAFE_REF.test(context.evidenceRef) &&
    !CONTROL_TEXT.test(context.evidenceRef) &&
    (context.expectedCursorPosition === undefined ||
      (Number.isSafeInteger(context.expectedCursorPosition) && context.expectedCursorPosition >= 0))
  );
}

function allDataTokenPresent(rows: readonly Record<string, unknown>[]): boolean {
  return rows.some((row) => {
    const token = fieldValue(row, 'token');
    if (token == null) return false;
    return typeof token === 'string' ? token.trim().length > 0 : true;
  });
}

function allDataCardFieldPresent(rows: readonly Record<string, unknown>[]): boolean {
  return rows.some((row) =>
    ['cardnumber', 'paymentcardnumber', 'virtualcardnumber'].some((key) => {
      const value = fieldValue(row, key);
      if (value == null) return false;
      return typeof value === 'string' ? value.trim().length > 0 : true;
    }),
  );
}

/** Parse one bounded All Folios DATA_ONLY or GETCACHE page. */
export function parseBoundFolioAllDataTransport(
  text: string,
  parentProof: FolioFolParentProof,
  context: FolioAllDataParseContext,
): BoundFolioAllDataParseResult {
  const bytesObserved = Buffer.byteLength(text);
  const sourceHash = allDataSourceHash(text);
  if (bytesObserved > MAX_ALL_DATA_BYTES) {
    return failAllData(text, 'FOLIO_ALL_DATA_BOUNDS_EXCEEDED', { sourceHash });
  }
  const hasCardLeak =
    /(?:["']?)(?:cardnumber|paymentcardnumber|virtualcardnumber)(?:["']?)\s*:\s*["']\d{12,}/i.test(
      text,
    );
  if (hasCardLeak) {
    return failAllData(text, 'FOLIO_PCI_FIELD_SUPPRESSED', { sourceHash, hasCardLeak: true });
  }
  const proof = normalizedProof(parentProof);
  if (!proof) return failAllData(text, 'FOLIO_PARENT_BINDING_UNPROVEN', { sourceHash });
  if (!allDataContextValid(context)) {
    return failAllData(text, 'FOLIO_EVIDENCE_INVALID', { sourceHash });
  }

  const pageData = extractBoundFolioPageData(text, false);
  if (!pageData) return failAllData(text, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT', { sourceHash });
  const grid = objectValue(pageData.grid);
  const gridResult = grid ? objectValue(fieldValue(grid, 'GRIDRESULT')) : null;
  const gridInner = gridResult ? objectValue(fieldValue(gridResult, 'GRID')) : null;
  const rowsValue = gridInner ? fieldValue(gridInner, 'DATA') : null;
  const metadata = gridInner ? objectValue(fieldValue(gridInner, 'METADATA')) : null;
  const dataspy = gridResult ? objectValue(fieldValue(gridResult, 'DATASPY')) : null;
  if (!gridResult || !gridInner || !metadata || !dataspy || !Array.isArray(rowsValue)) {
    return failAllData(text, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT', {
      envelopeRecognized: true,
      sourceHash,
    });
  }
  if (
    fieldText(dataspy, 'id') !== ALL_DATA_DATASPY_ID ||
    fieldText(metadata, 'DATASPYID') !== ALL_DATA_DATASPY_ID ||
    fieldText(metadata, 'GRIDID') !== ALL_DATA_GRID_ID ||
    fieldText(metadata, 'GRIDNAME') !== ALL_DATA_GRID_NAME
  ) {
    return failAllData(text, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT', {
      envelopeRecognized: true,
      sourceHash,
    });
  }

  const rows = rowsValue.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && !Array.isArray(row),
  );
  const rowsScanned = rowsValue.length;
  if (rows.length !== rowsScanned) {
    return failAllData(text, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }
  if (rowsScanned > MAX_ALL_DATA_PAGE_ROWS) {
    return failAllData(text, 'FOLIO_ALL_DATA_BOUNDS_EXCEEDED', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }
  if (allDataTokenPresent(rows)) {
    return failAllData(text, 'FOLIO_PCI_FIELD_SUPPRESSED', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }
  if (allDataCardFieldPresent(rows)) {
    return failAllData(text, 'FOLIO_PCI_FIELD_SUPPRESSED', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }

  const totalRecords = parseBoundCount(metadata, 'RECORDS');
  const clientRows = parseBoundCount(metadata, 'CLIENTROWS');
  const currentCursorPosition = parseBoundCount(metadata, 'CURRENTCURSORPOSITION');
  const expectedCursorPosition = context.expectedCursorPosition ?? 0;
  const expectedEndCursorPosition =
    expectedCursorPosition === 0 ? rowsScanned : expectedCursorPosition + rowsScanned - 1;
  if (
    totalRecords == null ||
    totalRecords < rowsScanned ||
    totalRecords > MAX_ALL_DATA_ROWS ||
    clientRows == null ||
    clientRows < rowsScanned ||
    clientRows > MAX_ALL_DATA_PAGE_ROWS ||
    currentCursorPosition == null ||
    currentCursorPosition !== expectedEndCursorPosition ||
    currentCursorPosition > totalRecords ||
    (expectedCursorPosition > 0 && currentCursorPosition < expectedCursorPosition)
  ) {
    return failAllData(text, 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }
  const more = fieldText(metadata, 'MORERECORDPRESENT');
  if (more !== '+' && more !== '-') {
    return failAllData(text, 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }
  const hasMore = more === '+';
  if (
    (hasMore && currentCursorPosition >= totalRecords) ||
    (!hasMore && currentCursorPosition !== totalRecords)
  ) {
    return failAllData(text, 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED', {
      envelopeRecognized: true,
      rowsScanned,
      sourceHash,
    });
  }

  const fact = <T>(value: T): FolioFact<T> => ({
    state: 'known',
    value,
    data: value,
    evidenceRef: context.evidenceRef,
    observedAt: context.observedAt,
    sourceUpdatedAt: context.sourceUpdatedAt ?? null,
    expiresAt: context.expiresAt,
  });
  const unknownFact = (): FolioUnknownFact => ({
    state: 'unknown',
    value: null,
    data: null,
    reasonCode: 'SOURCE_UNAVAILABLE',
    evidenceRef: context.evidenceRef,
    observedAt: context.observedAt,
    sourceUpdatedAt: context.sourceUpdatedAt ?? null,
    expiresAt: context.expiresAt,
  });
  const items: BoundFolioTransaction[] = [];
  for (const row of rows) {
    if (
      fieldText(row, 'reference') !== proof.confirmationNumber ||
      fieldText(row, 'accountid') !== proof.reservationStayId ||
      fieldText(row, 'propertycode') !== proof.propertyCode
    ) {
      return failAllData(text, 'FOLIO_PARENT_BINDING_MISMATCH', {
        envelopeRecognized: true,
        rowsScanned,
        sourceHash,
      });
    }
    if (fieldText(row, 'account') !== proof.account) {
      return failAllData(text, 'FOLIO_ACCOUNT_BINDING_MISMATCH', {
        envelopeRecognized: true,
        rowsScanned,
        sourceHash,
      });
    }
    for (const currencyKey of ['currency', 'foreigncurrency', 'transactioncurrency']) {
      const raw = textValue(fieldValue(row, currencyKey));
      if (raw && normalizeCurrency(raw) !== proof.currency) {
        return failAllData(text, 'FOLIO_CURRENCY_MISMATCH', {
          envelopeRecognized: true,
          rowsScanned,
          sourceHash,
        });
      }
    }
    const amount = normalizeMoney(fieldValue(row, 'amount'));
    const postingDate = normalizePostingDate(fieldValue(row, 'fdate'));
    const code = transactionCode(fieldValue(row, 'transactioncode'));
    if (amount == null || postingDate == null || code == null) {
      return failAllData(text, 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT', {
        envelopeRecognized: true,
        rowsScanned,
        sourceHash,
      });
    }
    const transactionRef = digestRef(
      'posting',
      ['id', 'line', 'reference', 'accountid', 'fdate', 'transactioncode', 'amount']
        .map((key) => String(fieldValue(row, key) ?? ''))
        .join('\u0000'),
    );
    items.push({
      transactionRef: fact(transactionRef),
      // All Folios DATA_ONLY does not carry the reviewed subfolio option map.
      // Keep the posting, but do not invent a folio identity.
      folioRef: unknownFact(),
      postingDate: fact(postingDate),
      transactionCode: fact(code),
      amount: fact({
        amount,
        currency: proof.currency,
        basis: 'ledger_movement',
        taxTreatment: 'unknown',
      }),
    });
  }

  return {
    envelopeRecognized: true,
    scopeVerified: true,
    items,
    totalRecords,
    currentCursorPosition,
    hasMore,
    rowsScanned,
    bytesObserved,
    sourceHash: stableAllDataSourceHash(items, totalRecords),
    blocker: null,
  };
}
