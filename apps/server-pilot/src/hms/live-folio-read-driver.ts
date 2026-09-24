/**
 * Live Folio + Deposit Ledger observers (Task 16).
 * Folio: OSRESS foliobalance / propertycurrency (display only).
 * Deposit: OSLEDG.LST date list → OSLEDG.DLD detail (confirmationnumber bind).
 * Observations never emit recipientClass/inquiryClass, card PAN, or guest names.
 * paymentcardnumber on DLD is detected for leak flag only — never parsed into claims.
 */
import {
  parseBoundFolioAllDataTransport,
  parseBoundFolioFolTransport,
  parseFolioFolTransport,
  type BoundFolioAllDataParseResult,
  type BoundFolioTransaction,
  type BoundFolioBalancesSection,
  type FolioFolParentProof,
} from './folio-fol-parse.js';
import {
  FOLIO_BOUND_READ_MAX_DURATION_MS,
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
  FOLIO_READ_MAX_ROWS,
  FOLIO_READ_MAX_TOTAL_ROWS,
  FOLIO_READ_MAX_SOURCE_AGE_MS,
  folioClaimEligibility,
  folioReadDataSchema,
  type FolioReadData,
} from './folio-read-contract.js';
import {
  knownFact,
  readIssue,
  readResultSchema,
  unknownFact,
  type ReadReasonCode,
  type ReadResult,
} from './read-service-contracts.js';
import { projectFolioBalanceFromDetailDump } from './folio-detail-projection.js';
import type { HmsBrowserArtifactReceiptV1 } from './browser-artifacts.js';
import type { ExactReservationCandidate } from './live-read-manifest.js';
import { extractOsressPageData } from './live-guest-stay-driver.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import type { HmsBrowserAuditSpec } from './browser-artifacts.js';
import {
  HmsRuntimeError,
  type HmsPostFormResponseBounds,
  type HmsRuntime,
} from './runtime.js';
import { createFolioReadFacade } from './folio-read-facade.js';
import type { ReadCandidateChild } from './candidate-graph.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import { createHash, randomUUID } from 'node:crypto';

export const DEPOSIT_LEDGER_RESERVATION_SCOPE_BLOCKER =
  'BLOCKED_DEPOSIT_LEDGER_RESERVATION_SCOPE_UNPROVEN';
export const DEPOSIT_LEDGER_PROPERTY_SCOPE_UNRESOLVED = 'DEPOSIT_LEDGER_PROPERTY_SCOPE_UNRESOLVED';
export const FOLIO_RESERVATION_SCOPE_BLOCKER = 'BLOCKED_FOLIO_RESERVATION_SCOPE_UNPROVEN';

export const LIVE_FOLIO_BALANCE_ALIAS_KEYS = ['foliobalance', 'propertycurrency'] as const;

export const LIVE_DEPOSIT_LEDGER_ALIAS_KEYS = [
  'currency',
  'newdeposits',
  'refunds',
  'forfeits',
  'toguestledger',
  'fromdeposit',
  'confirmationnumber',
  'amount',
  'activitytype_display',
  'toaccount',
] as const;

const DEPOSIT_LEDGER_SCOPE_FIELDS = new Set([
  'closingdate',
  'hoteldate',
  'closing_date',
  'property',
  'confirmationnumber',
  'currency',
  'newdeposits',
  'refunds',
  'forfeits',
  'toguestledger',
  'fromdeposit',
  'amount',
  'activitytype_display',
]);

/** Max LST date rows to open as DLD detail (abort-first budget). */
export const DEPOSIT_LEDGER_MAX_DETAIL_DATES = 7;

export type FolioBalanceKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  currency: string | null;
  totalBalance: string | null;
  evidenceId: string | null;
  blocker: string | null;
  rowsScanned?: number;
  bytesObserved?: number;
  durationMs?: number;
  observedAt?: string;
  reservationScopeProven?: boolean;
  scopeVerified?: boolean;
  manifestSha256?: string;
  scopeHash?: string;
  artifactRef?: string;
  finalizedReceipt?: FinalizedFolioReceipt;
};

export type DepositSummaryKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  currency: string | null;
  depositSummary: FolioReadData['depositSummary'] | null;
  evidenceId: string | null;
  blocker: string | null;
  rowsScanned?: number;
  bytesObserved?: number;
  durationMs?: number;
  observedAt?: string;
  completeness?: 'complete' | 'partial' | 'unknown';
  unmappedActivities?: readonly string[];
  reservationScopeProven?: boolean;
  scopeVerified?: boolean;
  manifestSha256?: string;
  scopeHash?: string;
  artifactRef?: string;
  finalizedReceipt?: FinalizedFolioReceipt;
};

export type FinalizedFolioReceipt = Pick<
  HmsBrowserArtifactReceiptV1,
  | 'artifactId'
  | 'operationId'
  | 'toolId'
  | 'toolVersion'
  | 'executionClass'
  | 'inputClass'
  | 'requestBranchId'
  | 'operationOutcome'
  | 'expiresAt'
> & { requestBranchId: string };

export type TrustedFolioDisclosure = {
  recipientClass: FolioReadData['disclosure']['recipientClass'];
  inquiryClass: FolioReadData['disclosure']['inquiryClass'];
};

export type FolioEvidenceBinding = {
  runId: string;
  readResultRef: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  candidateId: string;
  reservationRef: string;
  inputDigest: string;
  requesterAuthorizationId: string;
  releaseId: string;
  requestBranchIds: readonly ('folio_summary' | 'deposit_ledger_summary')[];
  captureBindingRef: string;
  propertyCode: string;
  confirmationToken: string;
  manifestSha256ByBranch: Partial<Record<'folio_summary' | 'deposit_ledger_summary', string>>;
  scopeHash: string;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('folio observe aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function strOrEmpty(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

export function normalizeMoney(raw: unknown, opts?: { unsigned?: boolean }): string | null {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim().replace(/,/g, '');
  if (!s) return null;
  if (/\d{13,19}/.test(s.replace(/\s/g, ''))) return null;
  const neg = s.startsWith('-') || s.startsWith('(');
  s = s.replace(/[()]/g, '').replace(/^\+/, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const frac = (f + '00').slice(0, 2);
  const out = `${w}.${frac}`;
  if (opts?.unsigned) {
    if (neg) return null;
    return out;
  }
  return neg ? `-${out}` : out;
}

export function normalizeCurrency(raw: unknown): string | null {
  if (raw == null) return null;
  const t = String(raw).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

function cents(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fractional] = unsigned.split('.');
  const parsed = BigInt(whole!) * 100n + BigInt(fractional!);
  return negative ? -parsed : parsed;
}

function statusAmt<TPresent extends string, TAbsent extends string>(
  amount: string,
  present: TPresent,
  absent: TAbsent,
): { amount: string; status: TPresent | TAbsent } {
  return {
    amount,
    status: cents(amount) === 0n ? absent : present,
  };
}

function parsePageData(text: string): Record<string, unknown> | null {
  const fromOsress = extractOsressPageData(text);
  if (fromOsress) return fromOsress;
  try {
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    if (parsed.pageData && typeof parsed.pageData === 'object') {
      return parsed.pageData as Record<string, unknown>;
    }
    return parsed;
  } catch {
    return null;
  }
}

function gridDataRows(pageData: Record<string, unknown>): Record<string, unknown>[] {
  const gridWrap = pageData.grid;
  if (gridWrap == null || typeof gridWrap !== 'object') return [];
  const gridResult = (gridWrap as Record<string, unknown>).GRIDRESULT;
  if (gridResult == null || typeof gridResult !== 'object') return [];
  const inner = (gridResult as Record<string, unknown>).GRID;
  if (inner == null || typeof inner !== 'object') return [];
  const data = (inner as Record<string, unknown>).DATA;
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r && typeof r === 'object') as Record<string, unknown>[];
}

export function buildDepositSummary(raw: {
  due: string;
  paid: string;
  refunded: string;
  forfeited: string;
  transferred: string;
}): NonNullable<FolioReadData['depositSummary']> {
  const totalCents =
    cents(raw.due) +
    cents(raw.paid) +
    cents(raw.refunded) +
    cents(raw.forfeited) +
    cents(raw.transferred);
  const abs = totalCents < 0n ? -totalCents : totalCents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const total = `${totalCents < 0n ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
  if (total.startsWith('-')) {
    throw new Error('deposit total cannot be negative');
  }
  return {
    total,
    due: statusAmt(raw.due, 'due', 'none_due'),
    paid: statusAmt(raw.paid, 'paid', 'none_paid'),
    refunded: statusAmt(raw.refunded, 'refunded', 'none_refunded'),
    forfeited: statusAmt(raw.forfeited, 'forfeited', 'none_forfeited'),
    transferred: statusAmt(raw.transferred, 'transferred', 'none_transferred'),
  };
}

/** Pull foliobalance / propertycurrency from grid rows or flat pageData. */
export function parseFolioBalanceTransport(
  text: string,
  expectedConfirmationToken: string,
): {
  envelopeRecognized: boolean;
  reservationScopeProven: boolean;
  currency: string | null;
  totalBalance: string | null;
  rowsScanned: number;
  bytesObserved: number;
  hasCardLeak: boolean;
} {
  const bytesObserved = Buffer.byteLength(text);
  if (/data-testid\s*=\s*["']folio-/i.test(text)) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'fixture HTML folio fallback rejected in live observer',
    );
  }
  const hasCardLeak =
    /"cardnumber"\s*:\s*"[0-9]{12,}"/i.test(text) ||
    /"virtualcardnumber"\s*:\s*"[0-9]{12,}"/i.test(text);
  const pageData = parsePageData(text);
  if (!pageData) {
    return {
      envelopeRecognized: false,
      reservationScopeProven: false,
      currency: null,
      totalBalance: null,
      rowsScanned: 0,
      bytesObserved,
      hasCardLeak,
    };
  }

  const rows = gridDataRows(pageData);
  const confirmationToken = expectedConfirmationToken.trim();
  const pageConfirmation =
    strOrEmpty(pageData.confirmationnumber) || strOrEmpty(pageData.confirmation);
  const flatScopeProven = confirmationToken.length > 0 && pageConfirmation === confirmationToken;
  const scopedRows = rows.filter((row) => {
    const confirmation = strOrEmpty(row.confirmationnumber) || strOrEmpty(row.confirmation);
    return confirmationToken.length > 0 && confirmation === confirmationToken;
  });
  if (scopedRows.length === 0 && !flatScopeProven) {
    return {
      envelopeRecognized: true,
      reservationScopeProven: false,
      currency: null,
      totalBalance: null,
      rowsScanned: Math.min(rows.length, FOLIO_READ_MAX_ROWS),
      bytesObserved,
      hasCardLeak,
    };
  }

  let currency: string | null = null;
  let totalBalance: string | null = null;
  let rowsScanned = 0;
  const currencies = new Set<string>();

  for (const row of scopedRows) {
    rowsScanned += 1;
    if (rowsScanned > FOLIO_READ_MAX_ROWS) break;
    const bal =
      normalizeMoney(row.foliobalance) ??
      normalizeMoney(row.balance) ??
      normalizeMoney(row.totalbalance);
    const cur = normalizeCurrency(row.propertycurrency) ?? normalizeCurrency(row.currency);
    if (bal != null) totalBalance = bal;
    if (cur != null) {
      currencies.add(cur);
      currency = cur;
    }
  }

  if (totalBalance == null && flatScopeProven) {
    totalBalance = normalizeMoney(pageData.foliobalance);
  }
  if (currency == null && flatScopeProven) {
    currency = normalizeCurrency(pageData.propertycurrency) ?? normalizeCurrency(pageData.currency);
  }
  const fields = flatScopeProven ? pageData.fields : null;
  if (fields && typeof fields === 'object') {
    const f = fields as Record<string, unknown>;
    if (totalBalance == null) totalBalance = normalizeMoney(f.foliobalance);
    if (currency == null) currency = normalizeCurrency(f.propertycurrency);
  }

  if (currencies.size > 1) {
    return {
      envelopeRecognized: true,
      reservationScopeProven: true,
      currency: null,
      totalBalance: null,
      rowsScanned: Math.max(rowsScanned, totalBalance != null ? 1 : 0),
      bytesObserved,
      hasCardLeak,
    };
  }

  return {
    envelopeRecognized: true,
    reservationScopeProven: true,
    currency,
    totalBalance,
    rowsScanned: Math.max(rowsScanned, totalBalance != null ? 1 : 0),
    bytesObserved,
    hasCardLeak,
  };
}

function addMoney(a: string, b: string): string {
  const sum = cents(a) + cents(b);
  const neg = sum < 0n;
  const abs = neg ? -sum : sum;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Classify only reviewed source activity labels; unknown never becomes paid. */
export function classifyDepositActivity(
  activityRaw: unknown,
): 'paid' | 'refunded' | 'forfeited' | 'transferred' | 'due' | 'unknown' {
  const a = String(activityRaw ?? '')
    .trim()
    .toLowerCase();
  if (/deposit\s*(payment|received|posted)|payment\s*received/.test(a)) {
    return 'paid';
  }
  if (/refund/.test(a)) return 'refunded';
  if (/forfeit/.test(a)) return 'forfeited';
  if (/transfer|guest\s*ledger|to\s*guest|to\s*a\/?r/.test(a)) {
    return 'transferred';
  }
  if (/due|outstanding|balance/.test(a) && !/deposit/.test(a)) return 'due';
  return 'unknown';
}

export type DepositLedgerDateScope = {
  closingdate: string;
  property: string;
};

export type DepositLedgerDateScopeExtraction = {
  scopes: DepositLedgerDateScope[];
  truncated: boolean;
  rowsObserved: number;
  propertyMismatch?: boolean;
  propertyUnknown?: boolean;
  matchingConfirmationObserved?: boolean;
};

/**
 * Extract closingdate + property from OSLEDG.LST date rows (keys for DLD only).
 * Values stay in-memory for the read session — not logged by this helper.
 */
export function extractDepositLedgerDateScopes(
  text: string,
  maxDates = DEPOSIT_LEDGER_MAX_DETAIL_DATES,
  expectedPropertyCode?: string,
  expectedConfirmationToken?: string,
): DepositLedgerDateScopeExtraction {
  const pageData = parsePageData(text);
  if (!pageData) return { scopes: [], truncated: false, rowsObserved: 0 };
  const rows = gridDataRows(pageData);
  const boundedRows = rows.slice(0, FOLIO_READ_MAX_ROWS);
  const dateLimit = Math.max(0, Math.floor(maxDates));
  const out: DepositLedgerDateScope[] = [];
  const seen = new Set<string>();
  let truncated = rows.length > boundedRows.length;
  let propertyMismatch = false;
  let propertyUnknown = false;
  let matchingConfirmationObserved = false;
  for (const row of boundedRows) {
    const closingdate =
      strOrEmpty(row.closingdate) || strOrEmpty(row.hoteldate) || strOrEmpty(row.closing_date);
    const property = strOrEmpty(row.property);
    const hasScopeSignals = Object.keys(row).some((key) =>
      DEPOSIT_LEDGER_SCOPE_FIELDS.has(key.toLowerCase()),
    );
    if (
      expectedConfirmationToken &&
      strOrEmpty(row.confirmationnumber) === expectedConfirmationToken
    ) {
      matchingConfirmationObserved = true;
    }
    if (!property) {
      if (hasScopeSignals) propertyUnknown = true;
      continue;
    }
    if (!/^[A-Z0-9]{2,16}$/i.test(property)) {
      propertyUnknown = true;
      continue;
    }
    if (!closingdate) continue;
    const normalizedProperty = property.toUpperCase();
    if (expectedPropertyCode && normalizedProperty !== expectedPropertyCode.toUpperCase()) {
      propertyMismatch = true;
      continue;
    }
    const key = `${normalizedProperty}|${closingdate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length < dateLimit) {
      out.push({
        closingdate,
        property: normalizedProperty,
      });
    } else {
      truncated = true;
    }
  }
  return {
    scopes: out,
    truncated,
    rowsObserved: rows.length,
    propertyMismatch,
    propertyUnknown,
    matchingConfirmationObserved,
  };
}

function depositCardLeak(text: string): boolean {
  return (
    /"cardnumber"\s*:\s*"[0-9]{12,}"/i.test(text) ||
    /"paymentcardnumber"\s*:\s*"[0-9]{12,}"/i.test(text) ||
    /"virtualcardnumber"\s*:\s*"[0-9]{12,}"/i.test(text)
  );
}

/**
 * Parse OSLEDG.DLD (preferred) or LST. Reservation correlation requires
 * confirmationnumber on a detail row matching expectedConfirmationToken.
 * Never reads name / paymentcardnumber into claims.
 */
export function parseDepositLedgerTransport(
  text: string,
  expectedConfirmationToken: string,
): {
  envelopeRecognized: boolean;
  reservationScopeProven: boolean;
  currency: string | null;
  depositSummary: FolioReadData['depositSummary'] | null;
  rowsScanned: number;
  bytesObserved: number;
  hasCardLeak: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  unmappedActivities: string[];
} {
  const bytesObserved = Buffer.byteLength(text);
  if (/data-testid\s*=\s*["']deposit-/i.test(text)) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'fixture HTML deposit fallback rejected in live observer',
    );
  }
  const hasCardLeak = depositCardLeak(text);
  const pageData = parsePageData(text);
  if (!pageData) {
    return {
      envelopeRecognized: false,
      reservationScopeProven: false,
      currency: null,
      depositSummary: null,
      rowsScanned: 0,
      bytesObserved,
      hasCardLeak,
      completeness: 'unknown',
      unmappedActivities: [],
    };
  }

  const rows = gridDataRows(pageData);
  const token = expectedConfirmationToken.trim();
  let hasConfirmationColumn = false;
  const matched: Record<string, unknown>[] = [];

  for (const row of rows) {
    if ('confirmationnumber' in row || 'confirmation' in row) {
      hasConfirmationColumn = true;
    }
    const conf = strOrEmpty(row.confirmationnumber) || strOrEmpty(row.confirmation);
    if (token && conf && conf === token) {
      matched.push(row);
    }
  }

  if (!hasConfirmationColumn || matched.length === 0) {
    return {
      envelopeRecognized: true,
      reservationScopeProven: false,
      currency: null,
      depositSummary: null,
      rowsScanned: rows.length,
      bytesObserved,
      hasCardLeak,
      completeness: 'unknown',
      unmappedActivities: [],
    };
  }

  // Prefer single-row LST-style aggregates when present on the matched row.
  const first = matched[0]!;
  const lstStyle =
    'newdeposits' in first ||
    'refunds' in first ||
    'forfeits' in first ||
    'toguestledger' in first ||
    'fromdeposit' in first ||
    'due' in first;

  let currency: string | null = null;
  let paid = '0.00';
  let refunded = '0.00';
  let forfeited = '0.00';
  let transferred = '0.00';
  let due = '0.00';
  const unmappedActivities: string[] = [];
  const currencies = new Set<string>();

  if (lstStyle && matched.length === 1) {
    const rowCurrency = normalizeCurrency(first.currency);
    if (rowCurrency) {
      currencies.add(rowCurrency);
      currency = rowCurrency;
    }
    const unsignedAmount = (raw: unknown, field: string): string => {
      if (raw == null || raw === '') return '0.00';
      const normalized = normalizeMoney(raw);
      if (normalized == null || normalized.startsWith('-')) {
        unmappedActivities.push(field);
        return '0.00';
      }
      return normalized;
    };
    paid = unsignedAmount(first.newdeposits, 'newdeposits');
    refunded = unsignedAmount(first.refunds, 'refunds');
    forfeited = unsignedAmount(first.forfeits, 'forfeits');
    const toGuest = unsignedAmount(first.toguestledger, 'toguestledger');
    const fromDeposit = unsignedAmount(first.fromdeposit, 'fromdeposit');
    transferred = toGuest !== '0.00' ? toGuest : fromDeposit;
    due = unsignedAmount(first.due, 'due');
  } else {
    // DLD transaction rows: sum amount by activitytype_display.
    const seenPostingRefs = new Set<string>();
    for (const row of matched) {
      const postingRef =
        strOrEmpty(row.postingref) ||
        strOrEmpty(row.posting_ref) ||
        strOrEmpty(row.postingreference) ||
        strOrEmpty(row.transactionid) ||
        strOrEmpty(row.transactionnumber);
      if (postingRef) {
        if (seenPostingRefs.has(postingRef)) continue;
        seenPostingRefs.add(postingRef);
      }
      const rowCurrency = normalizeCurrency(row.currency);
      if (rowCurrency) {
        currencies.add(rowCurrency);
        currency = currency ?? rowCurrency;
      }
      const normalizedAmount = normalizeMoney(row.amount);
      if (normalizedAmount == null || normalizedAmount.startsWith('-')) {
        unmappedActivities.push(strOrEmpty(row.activitytype_display) || 'unknown');
        continue;
      }
      const amt = normalizedAmount;
      const bucket = classifyDepositActivity(row.activitytype_display);
      if (bucket === 'paid') paid = addMoney(paid, amt);
      else if (bucket === 'refunded') refunded = addMoney(refunded, amt);
      else if (bucket === 'forfeited') forfeited = addMoney(forfeited, amt);
      else if (bucket === 'transferred') transferred = addMoney(transferred, amt);
      else if (bucket === 'due') due = addMoney(due, amt);
      else unmappedActivities.push(strOrEmpty(row.activitytype_display) || 'unknown');
    }
  }

  if (currencies.size > 1) {
    return {
      envelopeRecognized: true,
      reservationScopeProven: true,
      currency: null,
      depositSummary: null,
      rowsScanned: rows.length,
      bytesObserved,
      hasCardLeak,
      completeness: 'partial',
      unmappedActivities: ['MIXED_CURRENCY', ...unmappedActivities],
    };
  }

  return {
    envelopeRecognized: true,
    reservationScopeProven: true,
    currency,
    depositSummary: buildDepositSummary({
      due,
      paid,
      refunded,
      forfeited,
      transferred,
    }),
    rowsScanned: rows.length,
    bytesObserved,
    hasCardLeak,
    completeness: unmappedActivities.length > 0 ? 'partial' : 'complete',
    unmappedActivities,
  };
}

function parseDepositLedgerPages(
  texts: readonly string[],
  expectedConfirmationToken: string,
): ReturnType<typeof parseDepositLedgerTransport> {
  const rows: Record<string, unknown>[] = [];
  let unavailablePageCount = 0;
  let validPageCount = 0;
  for (const text of texts) {
    const pageData = parsePageData(text);
    const grid = pageData?.grid;
    const gridResult =
      grid && typeof grid === 'object' ? (grid as Record<string, unknown>).GRIDRESULT : null;
    const inner =
      gridResult && typeof gridResult === 'object'
        ? (gridResult as Record<string, unknown>).GRID
        : null;
    const data =
      inner && typeof inner === 'object' ? (inner as Record<string, unknown>).DATA : null;
    if (!pageData || !Array.isArray(data)) {
      unavailablePageCount += 1;
      continue;
    }
    validPageCount += 1;
    rows.push(...gridDataRows(pageData));
  }

  if (validPageCount === 0) {
    const empty = parseDepositLedgerTransport('', expectedConfirmationToken);
    return {
      ...empty,
      bytesObserved: texts.reduce((total, text) => total + Buffer.byteLength(text), 0),
      hasCardLeak: texts.some(depositCardLeak),
      unmappedActivities:
        unavailablePageCount > 0 ? ['DEPOSIT_LEDGER_PAGE_UNAVAILABLE'] : empty.unmappedActivities,
    };
  }

  const combined = JSON.stringify({
    pageData: {
      success: true,
      grid: {
        GRIDRESULT: {
          type: 'LIST.DATA_ONLY.STORED',
          GRID: { DATA: rows },
        },
      },
    },
  });
  const parsed = parseDepositLedgerTransport(combined, expectedConfirmationToken);
  if (unavailablePageCount === 0) return parsed;
  return {
    ...parsed,
    bytesObserved: texts.reduce((total, text) => total + Buffer.byteLength(text), 0),
    hasCardLeak: texts.some(depositCardLeak),
    completeness: 'partial',
    unmappedActivities: [...parsed.unmappedActivities, 'DEPOSIT_LEDGER_PAGE_UNAVAILABLE'],
  };
}

function assertFolioAuth(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  allowedBranches: ReadonlySet<string>,
  discoveryOperationId: string,
  expectedPropertyCode: string,
): void {
  if (authorization.toolId !== 'hms_read_folio') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for folio observer',
    );
  }
  if (authorization.discoveryOperationId !== discoveryOperationId) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization discoveryOperationId mismatch');
  }
  if (!allowedBranches.has(authorization.requestBranchId)) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for folio observer',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (child.toolId !== authorization.toolId) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'child toolId does not match authorization');
  }
  if (child.requestBranchId !== authorization.requestBranchId) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child requestBranchId does not match authorization',
    );
  }
  if (Date.parse(child.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'candidate child expired');
  }
  if (child.propertyCode !== expectedPropertyCode) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'child propertyCode denied');
  }
}

function finalizedFolioReceipt(
  session: { lastReceipt?: () => HmsBrowserArtifactReceiptV1 | null },
  auditSpec: HmsBrowserAuditSpec | undefined,
  requestBranchId: string,
): FinalizedFolioReceipt | null {
  if (!auditSpec || typeof session.lastReceipt !== 'function') return null;
  let receipt: HmsBrowserArtifactReceiptV1 | null;
  try {
    receipt = session.lastReceipt();
  } catch {
    return null;
  }
  if (
    !receipt ||
    receipt.artifactState !== 'complete' ||
    typeof receipt.artifactId !== 'string' ||
    receipt.artifactId.length === 0 ||
    receipt.operationId !== auditSpec.operationId ||
    receipt.toolId !== auditSpec.toolId ||
    receipt.toolVersion !== auditSpec.toolVersion ||
    receipt.executionClass !== auditSpec.executionClass ||
    receipt.inputClass !== auditSpec.inputClass ||
    receipt.requestBranchId !== requestBranchId ||
    receipt.operationOutcome !== 'succeeded' ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.expiresAt) <= Date.now()
  ) {
    return null;
  }
  return {
    artifactId: receipt.artifactId,
    operationId: receipt.operationId,
    toolId: receipt.toolId,
    toolVersion: receipt.toolVersion,
    executionClass: receipt.executionClass,
    inputClass: receipt.inputClass,
    requestBranchId,
    operationOutcome: receipt.operationOutcome,
    expiresAt: receipt.expiresAt,
  };
}

function emptyEvidence(
  observedAt: string,
  sourceSeed: string,
  extras?: { artifactRefs?: readonly string[]; scopeVerified?: boolean },
): Extract<ToolResult<FolioReadData>['evidence'], { kind: 'hms' }> {
  const artifactRefs = extras?.artifactRefs ? [...new Set(extras.artifactRefs)] : [];
  return {
    kind: 'hms',
    id: randomUUID(),
    toolId: 'hms_read_folio',
    toolVersion: '1.0.0',
    propertyCode: 'HRCEN',
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + FOLIO_READ_MAX_SOURCE_AGE_MS).toISOString(),
    claimKeys: [],
    sourceHash: sha256Hex(sourceSeed),
    ...(artifactRefs.length > 0 ? { artifactRef: artifactRefs[0], artifactRefs } : {}),
    ...(extras?.scopeVerified === undefined ? {} : { scopeVerified: extras.scopeVerified }),
  };
}

function moneyFact(
  amount: string,
  currency: string,
  evidenceRef: string,
  observedAt: string,
  expiresAt: string,
  basis: 'ledger_balance' | 'ledger_movement',
) {
  return knownFact({
    value: {
      amount,
      currency,
      basis,
      taxTreatment: 'unknown' as const,
    },
    evidenceRef,
    observedAt,
    expiresAt,
  });
}

function unknownSection(reasonCode: 'SOURCE_UNAVAILABLE' | 'NOT_REQUESTED') {
  return {
    state: 'unavailable' as const,
    data: null,
    reasonCode,
    issues: [readIssue(reasonCode)],
  };
}

function richBalanceSection(
  balance: FolioBalanceKernelResult | undefined,
  currency: string,
  evidenceRef: string,
  observedAt: string,
  expiresAt: string,
  complete: boolean,
) {
  if (!balance || balance.status !== 'ok' || balance.totalBalance == null) {
    return unknownSection('SOURCE_UNAVAILABLE');
  }
  return {
    state: complete ? ('available' as const) : ('partial' as const),
    data: {
      items: [
        {
          folioRef: unknownFact({ reasonCode: 'NOT_REQUESTED' }),
          folioType: unknownFact({ reasonCode: 'NOT_REQUESTED' }),
          balance: moneyFact(
            balance.totalBalance,
            currency,
            evidenceRef,
            observedAt,
            expiresAt,
            'ledger_balance',
          ),
        },
      ],
    },
    completeness: complete ? ('complete' as const) : ('partial' as const),
    issues: complete ? [] : [readIssue('PARTIAL_WINDOW')],
  };
}

function richDepositSection(
  deposit: DepositSummaryKernelResult | undefined,
  currency: string,
  evidenceRef: string,
  observedAt: string,
  expiresAt: string,
  complete: boolean,
) {
  if (!deposit || deposit.status !== 'ok' || deposit.depositSummary == null) {
    return unknownSection('SOURCE_UNAVAILABLE');
  }
  const summary = deposit.depositSummary;
  const paidCents = cents(summary.paid.amount);
  const transferredCents = cents(summary.transferred.amount);
  const untransferred =
    paidCents >= transferredCents
      ? addMoney(summary.paid.amount, `-${summary.transferred.amount}`)
      : null;
  const fact = (amount: string) =>
    moneyFact(amount, currency, evidenceRef, observedAt, expiresAt, 'ledger_movement');
  return {
    state: complete ? ('available' as const) : ('partial' as const),
    data: {
      items: [
        {
          due: fact(summary.due.amount),
          paid: fact(summary.paid.amount),
          refunded: fact(summary.refunded.amount),
          forfeited: fact(summary.forfeited.amount),
          transferred: fact(summary.transferred.amount),
          untransferred:
            untransferred == null
              ? unknownFact({ reasonCode: 'SOURCE_UNAVAILABLE' })
              : fact(untransferred),
        },
      ],
    },
    completeness: complete ? ('complete' as const) : ('partial' as const),
    issues: complete ? [] : [readIssue('PARTIAL_WINDOW')],
  };
}

/**
 * Merge Folio + Deposit kernel results. Disclosure must come from trusted
 * requester authorization — never from HMS observations.
 */
export function mergeFolioEvidence(
  steps: readonly (FolioBalanceKernelResult | DepositSummaryKernelResult)[],
  trustedDisclosure?: TrustedFolioDisclosure,
  requestedSections: readonly ('balance' | 'deposits' | 'transactions' | 'authorization')[] = [
    'balance',
    'deposits',
  ],
  binding?: FolioEvidenceBinding,
): ToolResult<FolioReadData> {
  const observedAt = steps.find((s) => s.observedAt)?.observedAt ?? new Date().toISOString();
  const evidence = emptyEvidence(
    observedAt,
    JSON.stringify(steps.map((s) => s.evidenceId)),
    binding ? { scopeVerified: false } : undefined,
  );

  if (!trustedDisclosure) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: ['FOLIO_TRUSTED_DISCLOSURE_REQUIRED'],
      evidence,
    };
  }

  const successfulSteps = steps.filter((step) => step.status === 'ok');
  const artifactRefs = [
    ...new Set(
      successfulSteps.flatMap((step) =>
        [step.artifactRef, step.finalizedReceipt?.artifactId].filter(
          (ref): ref is string => typeof ref === 'string' && ref.length > 0,
        ),
      ),
    ),
  ];
  const bindingFields = binding
    ? [
        binding.runId,
        binding.readResultRef,
        binding.transportId,
        binding.threadId,
        binding.triggerMessageId,
        binding.candidateId,
        binding.reservationRef,
        binding.inputDigest,
        binding.requesterAuthorizationId,
        binding.releaseId,
        binding.captureBindingRef,
        binding.propertyCode,
        binding.confirmationToken,
        binding.scopeHash,
      ]
    : [];
  const bindingValid = (() => {
    if (!binding) return true;
    if (
      !bindingFields.every((field) => typeof field === 'string' && field.trim().length > 0) ||
      binding.requestBranchIds.length === 0 ||
      binding.captureBindingRef !== binding.readResultRef
    ) {
      return false;
    }
    return binding.requestBranchIds.every((branchId) => {
      const digest = binding.manifestSha256ByBranch[branchId];
      return typeof digest === 'string' && /^[a-f0-9]{64}$/i.test(digest);
    });
  })();
  const receiptBound = (step: FolioBalanceKernelResult | DepositSummaryKernelResult): boolean => {
    if (!binding || step.status !== 'ok') return true;
    const receipt = step.finalizedReceipt;
    const expectedBranch = Object.prototype.hasOwnProperty.call(step, 'totalBalance')
      ? 'folio_summary'
      : 'deposit_ledger_summary';
    return (
      step.scopeVerified === true &&
      typeof step.artifactRef === 'string' &&
      receipt?.artifactId === step.artifactRef &&
      receipt.operationId === binding.runId &&
      receipt.toolId === 'hms_read_folio' &&
      receipt.toolVersion === '1.0.0' &&
      receipt.executionClass === 'normal' &&
      receipt.inputClass === 'authorized_exact' &&
      receipt.requestBranchId === expectedBranch &&
      binding.requestBranchIds.includes(expectedBranch) &&
      receipt.operationOutcome === 'succeeded' &&
      Number.isFinite(Date.parse(receipt.expiresAt)) &&
      Date.parse(receipt.expiresAt) > Date.now() &&
      step.manifestSha256 === binding.manifestSha256ByBranch[expectedBranch] &&
      step.scopeHash === binding.scopeHash
    );
  };
  if (binding && (!bindingValid || successfulSteps.some((step) => !receiptBound(step)))) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: [
        ...(bindingValid ? [] : ['FOLIO_EVIDENCE_BINDING_INVALID']),
        ...(bindingValid ? ['FOLIO_FINALIZED_RECEIPT_REQUIRED'] : []),
      ],
      evidence,
    };
  }

  const balance = steps.find((s): s is FolioBalanceKernelResult =>
    Object.prototype.hasOwnProperty.call(s, 'totalBalance'),
  );
  const deposit = steps.find((s): s is DepositSummaryKernelResult =>
    Object.prototype.hasOwnProperty.call(s, 'depositSummary'),
  );

  const requested = requestedSections.length > 0 ? requestedSections : ['balance', 'deposits'];
  const manifestSha256ByBranch = binding
    ? Object.fromEntries(
        binding.requestBranchIds.flatMap((branchId) => {
          const digest = binding.manifestSha256ByBranch[branchId];
          return digest ? [[branchId, digest] as const] : [];
        }),
      )
    : undefined;
  const wantsBalance = requested.includes('balance');
  const wantsDeposits = requested.includes('deposits');
  const wantsTransactions = requested.includes('transactions');
  const wantsAuthorization = requested.includes('authorization');

  const unresolved: string[] = [];

  const balanceOk =
    balance?.status === 'ok' && balance.totalBalance != null && balance.currency != null;
  const depositOk =
    deposit?.status === 'ok' && deposit.depositSummary != null && deposit.currency != null;
  const depositComplete =
    depositOk &&
    (deposit?.completeness ?? 'complete') === 'complete' &&
    (deposit?.unmappedActivities?.length ?? 0) === 0;

  if (wantsBalance && !balanceOk) {
    unresolved.push(balance?.blocker ?? 'FOLIO_BALANCE_UNAVAILABLE');
  }
  if (wantsDeposits && !depositComplete) {
    unresolved.push(
      depositOk
        ? 'DEPOSIT_SUMMARY_INCOMPLETE'
        : (deposit?.blocker ?? 'DEPOSIT_SUMMARY_UNAVAILABLE'),
    );
  }
  if (wantsTransactions) unresolved.push('TRANSACTIONS_UNAVAILABLE');
  if (wantsAuthorization) unresolved.push('AUTHORIZATION_UNAVAILABLE');

  const anyRequestedFact = (wantsBalance && balanceOk) || (wantsDeposits && depositOk);
  const requestedComplete =
    (!wantsBalance || balanceOk) &&
    (!wantsDeposits || depositComplete) &&
    !wantsTransactions &&
    !wantsAuthorization;

  if (!anyRequestedFact) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: unresolved.length ? unresolved : ['FOLIO_MERGE_EMPTY'],
      evidence,
    };
  }

  if (
    wantsBalance &&
    wantsDeposits &&
    balanceOk &&
    depositOk &&
    balance!.currency !== deposit!.currency
  ) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: ['FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT'],
      evidence,
    };
  }

  const currency = (balanceOk ? balance!.currency : deposit!.currency)!;
  const partial = !requestedComplete;
  const rowsScanned = (balance?.rowsScanned ?? 0) + (deposit?.rowsScanned ?? 0);
  const bytesObserved = (balance?.bytesObserved ?? 0) + (deposit?.bytesObserved ?? 0);
  const durationMs = Math.max(balance?.durationMs ?? 0, deposit?.durationMs ?? 0);
  if (
    rowsScanned > FOLIO_READ_MAX_ROWS ||
    bytesObserved > FOLIO_READ_MAX_BYTES ||
    durationMs > FOLIO_READ_MAX_DURATION_MS
  ) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: ['FOLIO_BOUNDS_EXCEEDED'],
      evidence,
    };
  }

  const evidenceRef = balance?.evidenceId ?? deposit?.evidenceId ?? evidence.id;
  const finalizedCaptureExpiries = successfulSteps
    .map((step) => Date.parse(step.finalizedReceipt?.expiresAt ?? ''))
    .filter((expiry): expiry is number => Number.isFinite(expiry));
  const policyExpiry = Date.parse(evidence.expiresAt);
  const expiresAt = new Date(Math.min(policyExpiry, ...finalizedCaptureExpiries)).toISOString();
  const richBalance = richBalanceSection(
    balance,
    currency,
    evidenceRef,
    observedAt,
    expiresAt,
    balanceOk && requestedComplete,
  );
  const richDeposits = richDepositSection(
    deposit,
    currency,
    evidenceRef,
    observedAt,
    expiresAt,
    depositComplete,
  );
  const balanceSection = wantsBalance ? richBalance : unknownSection('NOT_REQUESTED');
  const depositSection = wantsDeposits ? richDeposits : unknownSection('NOT_REQUESTED');
  const transactionsSection = wantsTransactions
    ? unknownSection('SOURCE_UNAVAILABLE')
    : unknownSection('NOT_REQUESTED');

  try {
    const data = folioReadDataSchema.parse({
      reservationBinding: 'exact_parent_redacted',
      guestPrivacy: 'identity_redacted',
      currency,
      ...(wantsBalance && balanceOk ? { totalBalance: balance!.totalBalance } : {}),
      ...(wantsDeposits && depositComplete ? { depositSummary: deposit!.depositSummary } : {}),
      balance: balanceSection,
      deposits: depositSection,
      transactions: transactionsSection,
      liabilityLocation: unknownFact({ reasonCode: 'NOT_REQUESTED' }),
      authorization: unknownFact({
        reasonCode: wantsAuthorization ? 'SOURCE_UNAVAILABLE' : 'NOT_REQUESTED',
      }),
      disclosure: {
        recipientClass: trustedDisclosure.recipientClass,
        inquiryClass: trustedDisclosure.inquiryClass,
        claimEligibility: folioClaimEligibility(
          trustedDisclosure.recipientClass,
          trustedDisclosure.inquiryClass,
        ),
      },
      rowsScanned: Math.max(rowsScanned, 1),
      bytesObserved: Math.max(bytesObserved, 1),
      durationMs: Math.max(durationMs, 0),
      observedAt,
    });

    return {
      status: partial ? 'partial' : 'ok',
      draftReady: !partial,
      data,
      unresolvedFields: partial ? unresolved : [],
      evidence: {
        ...evidence,
        expiresAt,
        claimKeys: ['folio_deposit_summary'],
        sourceHash: sha256Hex(
          canonicalJson({
            binding: binding ?? null,
            requestedSections: [...requested],
            steps: steps.map((step) => ({
              status: step.status,
              currency: step.currency,
              totalBalance: 'totalBalance' in step ? step.totalBalance : null,
              depositSummary: 'depositSummary' in step ? step.depositSummary : null,
              evidenceId: step.evidenceId,
              blocker: step.blocker,
              scopeVerified: step.scopeVerified ?? false,
              manifestSha256: step.manifestSha256 ?? null,
              scopeHash: step.scopeHash ?? null,
              artifactRef: step.artifactRef ?? null,
              finalizedReceipt: step.finalizedReceipt ?? null,
              completeness: 'completeness' in step ? (step.completeness ?? null) : null,
              unmappedActivities:
                'unmappedActivities' in step ? (step.unmappedActivities ?? []) : [],
              observedAt: step.observedAt ?? null,
            })),
            data,
          }),
        ),
        ...(artifactRefs.length > 0 ? { artifactRef: artifactRefs[0], artifactRefs } : {}),
        ...(binding && successfulSteps.length > 0
          ? { scopeVerified: successfulSteps.every((step) => step.scopeVerified === true) }
          : {}),
        ...(binding && successfulSteps.length === 1 && successfulSteps[0]?.manifestSha256
          ? { manifestSha256: successfulSteps[0].manifestSha256 }
          : {}),
        ...(manifestSha256ByBranch ? { manifestSha256ByBranch } : {}),
        ...(binding ? { scopeHash: binding.scopeHash } : {}),
      },
    };
  } catch {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: ['FOLIO_CONTRACT_OR_SCHEMA_DRIFT'],
      evidence,
    };
  }
}

const BOUND_FOLIO_SECTION_IDS = ['balance', 'deposits', 'transactions', 'authorization'] as const;
type BoundFolioSectionId = (typeof BOUND_FOLIO_SECTION_IDS)[number];

function detailDumpValue(values: Record<string, unknown>, key: string): string | null {
  const match = Object.entries(values).find(([name]) => name.toLowerCase() === key.toLowerCase());
  if (!match || match[1] == null) return null;
  const value = String(match[1]).trim();
  return value.length > 0 ? value : null;
}

function boundFolioReason(blocker: string | null | undefined): ReadReasonCode {
  if (!blocker) return 'SOURCE_UNAVAILABLE';
  if (blocker === 'FOLIO_BOUNDS_EXCEEDED' || blocker === 'FOLIO_ALL_DATA_BOUNDS_EXCEEDED')
    return 'SIZE_LIMIT';
  if (
    blocker === 'FOLIO_PAGING_UNSUPPORTED' ||
    blocker === 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED' ||
    blocker === 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT'
  )
    return 'UNSUPPORTED_FORMAT';
  if (blocker === 'FOLIO_ALL_DATA_TIMEOUT') return 'TIMEOUT';
  if (
    blocker === 'FOLIO_PARENT_BINDING_UNPROVEN' ||
    blocker === 'FOLIO_PARENT_BINDING_MISMATCH' ||
    blocker === 'FOLIO_ACCOUNT_BINDING_MISMATCH' ||
    blocker === 'FOLIO_CURRENCY_MISMATCH' ||
    blocker === 'FOLIO_ALL_DATA_PARENT_BINDING_MISMATCH' ||
    blocker === 'FOLIO_ALL_DATA_ACCOUNT_BINDING_MISMATCH' ||
    blocker === 'FOLIO_ALL_DATA_CURRENCY_MISMATCH'
  ) {
    return 'SCOPE_DENIED';
  }
  if (
    blocker === 'FOLIO_UNSUPPORTED_FORMAT' ||
    blocker === 'FOLIO_EVIDENCE_INVALID' ||
    blocker === 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT'
  ) {
    return 'UNSUPPORTED_FORMAT';
  }
  return 'SOURCE_UNAVAILABLE';
}

function requestedBoundFolioSections(
  requested: readonly BoundFolioSectionId[] | undefined,
): BoundFolioSectionId[] {
  const sections: readonly BoundFolioSectionId[] =
    requested && requested.length > 0 ? requested : ['balance', 'deposits'];
  return [...new Set(sections)].filter((section): section is BoundFolioSectionId =>
    BOUND_FOLIO_SECTION_IDS.includes(section),
  );
}

function boundFolioManualResult(
  child: ReadCandidateChild,
  requested: readonly BoundFolioSectionId[],
  reasonCode: ReadReasonCode,
  status: ReadResult<FolioReadData>['status'] = 'manual_required',
): ReadResult<FolioReadData> {
  return {
    toolId: 'hms_read_folio',
    schemaVersion: '1.0.0',
    status,
    data: null,
    completeness: 'unknown',
    unavailableSections: requested.map((section) => ({ section, reasonCode })),
    scopeRef: child.scopeHash,
    evidence: [],
    page: null,
    issues: [readIssue(reasonCode)],
  };
}

function boundFolioDisclosure(input?: TrustedFolioDisclosure): TrustedFolioDisclosure {
  return (
    input ?? {
      recipientClass: 'unknown',
      inquiryClass: 'other',
    }
  );
}

function boundFolioEvidence(input: {
  evidenceRef: string;
  body: string;
  sourceBodies?: readonly { surface: string; body: string }[];
  authorization: HmsSessionAuthorization;
  child: ReadCandidateChild;
  observedAt: string;
  expiresAt: string;
  artifactRef?: string | null;
}) {
  const sources = [{ surface: 'OSRESV.FOL', body: input.body }, ...(input.sourceBodies ?? [])];
  return {
    evidenceRef: input.evidenceRef,
    sourceSystem: 'hms' as const,
    sourceSurface: [...new Set(sources.map((source) => source.surface))].join('+'),
    requestBranchId: input.authorization.requestBranchId,
    observedAt: input.observedAt,
    sourceUpdatedAt: null,
    expiresAt: input.expiresAt,
    scopeVerified: true,
    artifactRef: input.artifactRef ?? null,
    sourceHash: sha256Hex(
      sources.map((source) => `${source.surface}\u0000${source.body}`).join('\u0000'),
    ),
    manifestSha256: input.authorization.manifestSha256,
    scopeHash: input.child.scopeHash,
  };
}

function boundFolioBalanceSection(
  source: BoundFolioBalancesSection | null,
  amount: string | null,
  currency: string,
  evidenceRef: string,
  observedAt: string,
  expiresAt: string,
  requested: boolean,
) {
  if (!requested) return unknownSection('NOT_REQUESTED');
  if (source) return source;
  if (amount == null) return unknownSection('SOURCE_UNAVAILABLE');
  return {
    state: 'available' as const,
    data: {
      items: [
        {
          folioRef: unknownFact({ reasonCode: 'NOT_REQUESTED' }),
          folioType: unknownFact({ reasonCode: 'NOT_REQUESTED' }),
          balance: moneyFact(
            amount,
            currency,
            evidenceRef,
            observedAt,
            expiresAt,
            'ledger_balance',
          ),
        },
      ],
    },
    completeness: 'complete' as const,
    issues: [],
  };
}

function boundFolioSectionIssue(
  section: BoundFolioSectionId,
  value: FolioReadData['balance'] | FolioReadData['deposits'] | FolioReadData['transactions'],
): { section: string; reasonCode: ReadReasonCode } | null {
  if (value?.state !== 'unavailable') return null;
  return { section, reasonCode: value.reasonCode };
}

export type BoundFolioPaging = {
  limit?: number;
  cursor?: string;
};

type BoundFolioCursor = {
  digest: string;
  offset: number;
};

type BoundFolioAllDataRead = {
  items: BoundFolioTransaction[];
  totalRecords: number;
  rowsScanned: number;
  bytesObserved: number;
  sourceHash: string;
  sourceBodies?: Array<{ surface: string; body: string }>;
  unavailable: boolean;
  blocker: string | null;
};

const MAX_BOUND_FOLIO_SOURCE_PAGES = 4;
const MAX_BOUND_FOLIO_SOURCE_ROWS = 200;
const BOUND_FOLIO_CACHE_POSITIONS = new Set([51, 101, 151]);

function nextBoundFolioResponseBounds(
  started: number,
  bytesObserved: number,
): HmsPostFormResponseBounds {
  const totalRemainingMs = FOLIO_BOUND_READ_MAX_DURATION_MS - (Date.now() - started);
  if (totalRemainingMs <= 0) {
    throw new HmsRuntimeError('TIMEOUT', 'folio financial source budget exhausted');
  }
  const maxBytes = FOLIO_READ_MAX_BYTES - bytesObserved;
  if (maxBytes <= 0) {
    throw new HmsRuntimeError('SIZE_LIMIT', 'folio financial source byte budget exhausted');
  }
  return { maxBytes, timeoutMs: Math.min(FOLIO_READ_MAX_DURATION_MS, totalRemainingMs) };
}

function assertBoundFolioRequestDuration(requestStarted: number): void {
  if (Date.now() - requestStarted > FOLIO_READ_MAX_DURATION_MS) {
    throw new HmsRuntimeError('TIMEOUT', 'folio financial request exceeded its time budget');
  }
}

function boundedFolioTransportReason(error: unknown): ReadReasonCode | null {
  if (!(error instanceof HmsRuntimeError)) return null;
  if (error.code === 'TIMEOUT') return 'TIMEOUT';
  if (error.code === 'SIZE_LIMIT') return 'SIZE_LIMIT';
  if (error.code === 'SOURCE_UNAVAILABLE') return 'SOURCE_UNAVAILABLE';
  return null;
}

function boundFolioPageLimit(paging: BoundFolioPaging | undefined): number | null {
  const limit = paging?.limit ?? FOLIO_READ_MAX_ROWS;
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= FOLIO_READ_MAX_ROWS ? limit : null;
}

function parseBoundFolioCursor(cursor: string | undefined): BoundFolioCursor | null {
  if (cursor === undefined) return { digest: '', offset: 0 };
  const match = /^fol1:([a-f0-9]{64}):(\d+)$/.exec(cursor);
  if (!match) return null;
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset >= MAX_BOUND_FOLIO_SOURCE_ROWS) {
    return null;
  }
  return { digest: match[1]!, offset };
}

function boundFolioCursorDigest(
  parentProof: FolioFolParentProof,
  sourceHash: string,
  requested: readonly BoundFolioSectionId[],
  offset: number,
): string {
  return sha256Hex(
    canonicalJson({
      parent: parentProof,
      sourceHash,
      requestedSections: [...requested].sort(),
      offset,
    }),
  );
}

function makeBoundFolioCursor(
  parentProof: FolioFolParentProof,
  sourceHash: string,
  requested: readonly BoundFolioSectionId[],
  offset: number,
): string {
  return `fol1:${boundFolioCursorDigest(parentProof, sourceHash, requested, offset)}:${offset}`;
}

function mergeBoundFolioPageHash(
  pages: readonly BoundFolioAllDataParseResult[],
  totalRecords: number,
): string {
  return sha256Hex(
    canonicalJson({
      totalRecords,
      pages: pages.map((page) => page.sourceHash),
    }),
  );
}

function allDataReadUnavailable(
  bytesObserved: number,
  rowsScanned: number,
  sourceHash = '',
): BoundFolioAllDataRead {
  return {
    items: [],
    totalRecords: 0,
    rowsScanned,
    bytesObserved,
    sourceHash,
    unavailable: true,
    blocker: null,
  };
}

async function readBoundFolioAllDataPages(input: {
  facade: ReturnType<typeof createFolioReadFacade>;
  confirmationNumber: string;
  reservationStayId: string;
  detailValues: Record<string, string | number | null | undefined>;
  parentProof: FolioFolParentProof;
  context: import('./folio-fol-parse.js').FolioAllDataParseContext;
  signal: AbortSignal;
  started: number;
  initialBytesObserved: number;
}): Promise<BoundFolioAllDataRead> {
  const pages: BoundFolioAllDataParseResult[] = [];
  const sourceBodies: Array<{ surface: string; body: string }> = [];
  let bytesObserved = 0;
  let rowsScanned = 0;
  let body: string;
  assertNotAborted(input.signal);
  try {
    const requestStarted = Date.now();
    body = await input.facade.openBoundFolioAllData({
      confirmationNumber: input.confirmationNumber,
      reservationStayId: input.reservationStayId,
      detailValues: input.detailValues,
      responseBounds: nextBoundFolioResponseBounds(
        input.started,
        input.initialBytesObserved + bytesObserved,
      ),
    });
    assertNotAborted(input.signal);
    assertBoundFolioRequestDuration(requestStarted);
  } catch (error) {
    if (input.signal.aborted) assertNotAborted(input.signal);
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (boundedFolioTransportReason(error)) throw error;
    return allDataReadUnavailable(bytesObserved, rowsScanned);
  }
  if (typeof body !== 'string') return allDataReadUnavailable(bytesObserved, rowsScanned);
  sourceBodies.push({ surface: 'OSRESV.FOL.xmlhttp', body });

  for (let pageNumber = 0; ; pageNumber += 1) {
    assertNotAborted(input.signal);
    bytesObserved += Buffer.byteLength(body);
    if (input.initialBytesObserved + bytesObserved > FOLIO_READ_MAX_BYTES) {
      return {
        items: [],
        totalRecords: 0,
        rowsScanned,
        bytesObserved,
        sourceHash: '',
        unavailable: false,
        blocker: 'FOLIO_ALL_DATA_BOUNDS_EXCEEDED',
      };
    }
    if (Date.now() - input.started > FOLIO_BOUND_READ_MAX_DURATION_MS) {
      return {
        items: [],
        totalRecords: 0,
        rowsScanned,
        bytesObserved,
        sourceHash: '',
        unavailable: false,
        blocker: 'FOLIO_ALL_DATA_TIMEOUT',
      };
    }
    const parsed = parseBoundFolioAllDataTransport(body, input.parentProof, {
      ...input.context,
      expectedCursorPosition:
        pageNumber === 0 ? 0 : pages[pages.length - 1]!.currentCursorPosition! + 1,
    });
    if (parsed.blocker) {
      rowsScanned += parsed.rowsScanned;
      return {
        items: [],
        totalRecords: parsed.totalRecords ?? 0,
        rowsScanned,
        bytesObserved,
        sourceHash: parsed.sourceHash,
        unavailable: parsed.blocker === 'FOLIO_ALL_DATA_UNSUPPORTED_FORMAT',
        blocker: parsed.blocker,
      };
    }
    rowsScanned += parsed.rowsScanned;
    pages.push(parsed);
    if (pages.length > MAX_BOUND_FOLIO_SOURCE_PAGES) {
      return {
        items: [],
        totalRecords: parsed.totalRecords ?? 0,
        rowsScanned,
        bytesObserved,
        sourceHash: '',
        unavailable: false,
        blocker: 'FOLIO_ALL_DATA_BOUNDS_EXCEEDED',
      };
    }
    const totalRecords = pages[0]!.totalRecords!;
    if (parsed.totalRecords !== totalRecords) {
      return {
        items: [],
        totalRecords,
        rowsScanned,
        bytesObserved,
        sourceHash: parsed.sourceHash,
        unavailable: false,
        blocker: 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED',
      };
    }
    if (!parsed.hasMore) {
      const items = pages.flatMap((page) => page.items);
      const duplicateRefs = new Set<string>();
      for (const item of items) {
        const ref = item.transactionRef.value;
        if (duplicateRefs.has(ref)) {
          return {
            items: [],
            totalRecords,
            rowsScanned,
            bytesObserved,
            sourceHash: '',
            unavailable: false,
            blocker: 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED',
          };
        }
        duplicateRefs.add(ref);
      }
      if (items.length !== totalRecords || totalRecords > MAX_BOUND_FOLIO_SOURCE_ROWS) {
        return {
          items: [],
          totalRecords,
          rowsScanned,
          bytesObserved,
          sourceHash: '',
          unavailable: false,
          blocker: 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED',
        };
      }
      return {
        items,
        totalRecords,
        rowsScanned,
        bytesObserved,
        sourceHash: mergeBoundFolioPageHash(pages, totalRecords),
        sourceBodies,
        unavailable: false,
        blocker: null,
      };
    }
    const nextPosition = parsed.currentCursorPosition! + 1;
    if (!BOUND_FOLIO_CACHE_POSITIONS.has(nextPosition)) {
      return {
        items: [],
        totalRecords,
        rowsScanned,
        bytesObserved,
        sourceHash: parsed.sourceHash,
        unavailable: false,
        blocker: 'FOLIO_ALL_DATA_PAGING_UNSUPPORTED',
      };
    }
    assertNotAborted(input.signal);
    try {
      const requestStarted = Date.now();
      body = await input.facade.readBoundFolioCache(
        nextPosition,
        nextBoundFolioResponseBounds(input.started, input.initialBytesObserved + bytesObserved),
      );
      assertNotAborted(input.signal);
      assertBoundFolioRequestDuration(requestStarted);
    } catch (error) {
      if (input.signal.aborted) assertNotAborted(input.signal);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (boundedFolioTransportReason(error)) throw error;
      return allDataReadUnavailable(bytesObserved, rowsScanned, parsed.sourceHash);
    }
    if (typeof body !== 'string') return allDataReadUnavailable(bytesObserved, rowsScanned);
    sourceBodies.push({ surface: 'GETCACHE', body });
  }
}

function boundFolioTransactionsPage(
  items: readonly BoundFolioTransaction[],
  offset: number,
  limit: number,
  parentProof: FolioFolParentProof,
  sourceHash: string,
  requested: readonly BoundFolioSectionId[],
) {
  const selected = items.slice(offset, offset + limit);
  const hasMore = offset + selected.length < items.length;
  return {
    state: 'available' as const,
    data: {
      items: selected,
      page: {
        returnedCount: selected.length,
        hasMore,
        nextCursor: hasMore
          ? makeBoundFolioCursor(parentProof, sourceHash, requested, offset + selected.length)
          : null,
      },
    },
    completeness: 'complete' as const,
    issues: [],
  };
}

export type LiveFolioReadDriver = {
  observeFolioBalance(
    authorization: HmsSessionAuthorization,
    child: ReadCandidateChild,
    signal: AbortSignal,
  ): Promise<FolioBalanceKernelResult>;
  observeDepositSummary(
    authorization: HmsSessionAuthorization,
    child: ReadCandidateChild,
    signal: AbortSignal,
  ): Promise<DepositSummaryKernelResult>;
  /**
   * Read the exact parent-bound OSRESV.FOL transport once and return the
   * canonical receipt shape.  Deposits and authorization stay explicit
   * unavailable until their own reviewed source is proven.
   */
  observeBoundFolio(
    authorization: HmsSessionAuthorization,
    child: ReadCandidateChild,
    requestedSections: readonly BoundFolioSectionId[],
    signal: AbortSignal,
    trustedDisclosure?: TrustedFolioDisclosure,
    paging?: BoundFolioPaging,
  ): Promise<ReadResult<FolioReadData>>;
};

export type LiveFolioReadDriverInput = {
  runtime: HmsRuntime;
  transportId: string;
  expectedConfirmationToken: string;
  /** Validated OSRESV.HDR reservationstayid from the detail dump, when available. */
  reservationStayId?: string | null;
  expectedPropertyCode?: string;
  auditSpecFor?: (input: {
    branchId: 'folio_summary' | 'deposit_ledger_summary';
  }) => HmsBrowserAuditSpec | undefined;
  /**
   * Wave A2 soft path: Guest Stay detail dump with balance/balancecurr
   * (proved 2026-09-12). Used for balance-only when present; deposits still
   * require deposit ledger surface.
   */
  detailDumpFor?: () => Promise<
    import('./reservation-detail-projection.js').ReservationDetailDumpV1 | null
  >;
};

async function runBoundFolioRead(
  input: LiveFolioReadDriverInput,
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  requestedInput: readonly BoundFolioSectionId[],
  signal: AbortSignal,
  trustedDisclosure?: TrustedFolioDisclosure,
  paging?: BoundFolioPaging,
): Promise<ReadResult<FolioReadData>> {
  const requested = requestedBoundFolioSections(requestedInput);
  const pageLimit = boundFolioPageLimit(paging);
  const cursor = parseBoundFolioCursor(paging?.cursor);
  if (
    pageLimit == null ||
    cursor == null ||
    (paging?.cursor && !requested.includes('transactions'))
  ) {
    return boundFolioManualResult(child, requested, 'UNSUPPORTED_FORMAT');
  }
  try {
    assertNotAborted(signal);
    assertFolioAuth(
      authorization,
      child,
      new Set(['folio_summary']),
      'folio_summary',
      input.expectedPropertyCode ?? 'HRCEN',
    );
  } catch (error) {
    const reasonCode: ReadReasonCode =
      error instanceof HmsRuntimeError && error.code === 'ROLE_PROOF_EXPIRED'
        ? 'REF_EXPIRED'
        : error instanceof Error && error.name === 'AbortError'
          ? 'TIMEOUT'
          : 'SCOPE_DENIED';
    return boundFolioManualResult(child, requested, reasonCode);
  }

  let session: Awaited<ReturnType<HmsRuntime['openReadSession']>> | null = null;
  let sessionClosed = false;
  let closeSession: (() => Promise<void>) | null = null;
  try {
    const reservationStayId = input.reservationStayId?.trim() ?? '';
    if (!reservationStayId) {
      return boundFolioManualResult(child, requested, 'INPUT_MISSING');
    }
    if (!input.detailDumpFor) {
      return boundFolioManualResult(child, requested, 'INPUT_MISSING');
    }

    const detailDump = await input.detailDumpFor();
    assertNotAborted(signal);
    const detailValues = detailDump?.values as Record<string, unknown> | undefined;
    if (!detailValues) {
      return boundFolioManualResult(child, requested, 'SCOPE_DENIED');
    }
    const account = detailDumpValue(detailValues, 'account');
    const currency = ['balancecurr', 'propertycurrency', 'hotelcurrency', 'currency']
      .map((key) => detailDumpValue(detailValues, key))
      .find((value): value is string => value != null && /^[A-Z]{3}$/i.test(value))
      ?.toUpperCase();
    if (!account || !currency) {
      return boundFolioManualResult(child, requested, 'SCOPE_DENIED');
    }

    const auditSpec = input.auditSpecFor?.({ branchId: 'folio_summary' });
    session = await input.runtime.openReadSession({
      transportId: input.transportId,
      signal,
      allowUnstarted: true,
      auditSpec,
      sessionAuthorization: authorization,
    });
    closeSession = async () => {
      if (sessionClosed || !session) return;
      sessionClosed = true;
      await session.close();
    };

    assertNotAborted(signal);
    // Authentication/context preparation remains bounded by the caller's
    // signal. The five-second financial-source budget starts at the read,
    // not while an authenticated proof context is being prepared.
    const observedAtDate = new Date();
    const observedAt = observedAtDate.toISOString();
    const started = observedAtDate.getTime();
    const facade = createFolioReadFacade(session, {
      expectedPropertyCode: input.expectedPropertyCode ?? 'HRCEN',
    });
    const requestStarted = Date.now();
    const body = await facade.openBoundOsresvFol({
      confirmationNumber: input.expectedConfirmationToken,
      reservationStayId,
      detailValues: detailValues as Record<string, string | number | null | undefined>,
      responseBounds: nextBoundFolioResponseBounds(started, 0),
    });
    assertNotAborted(signal);
    assertBoundFolioRequestDuration(requestStarted);
    if (typeof body !== 'string') {
      return boundFolioManualResult(child, requested, 'SOURCE_UNAVAILABLE');
    }

    const bytesObserved = Buffer.byteLength(body);
    const durationBeforeParse = Date.now() - started;
    if (bytesObserved > FOLIO_READ_MAX_BYTES) {
      return boundFolioManualResult(child, requested, 'SIZE_LIMIT');
    }
    if (durationBeforeParse > FOLIO_BOUND_READ_MAX_DURATION_MS) {
      return boundFolioManualResult(child, requested, 'TIMEOUT');
    }
    if (session.terminal() || session.violation()) {
      return boundFolioManualResult(child, requested, 'SOURCE_UNAVAILABLE');
    }

    const evidenceRef = `ev:folio-fol:${randomUUID()}`;
    const sourceExpiresAt = new Date(
      observedAtDate.getTime() + FOLIO_READ_MAX_SOURCE_AGE_MS,
    ).toISOString();
    const parentProof: FolioFolParentProof = {
      confirmationNumber: input.expectedConfirmationToken,
      reservationStayId,
      propertyCode: input.expectedPropertyCode ?? 'HRCEN',
      account,
      currency,
    };
    const parsed = parseBoundFolioFolTransport(body, parentProof, {
      evidenceRef,
      observedAt,
      expiresAt: sourceExpiresAt,
    });
    assertNotAborted(signal);
    let durationMs = Date.now() - started;
    if (parsed.bytesObserved > FOLIO_READ_MAX_BYTES) {
      return boundFolioManualResult(child, requested, 'SIZE_LIMIT');
    }
    if (durationMs > FOLIO_BOUND_READ_MAX_DURATION_MS) {
      return boundFolioManualResult(child, requested, 'TIMEOUT');
    }
    if (
      parsed.blocker ||
      !parsed.envelopeRecognized ||
      !parsed.scopeVerified ||
      parsed.currency == null ||
      parsed.currency !== currency
    ) {
      return boundFolioManualResult(child, requested, boundFolioReason(parsed.blocker));
    }

    const wantsBalance = requested.includes('balance');
    const wantsDeposits = requested.includes('deposits');
    const wantsTransactions = requested.includes('transactions');
    const wantsAuthorization = requested.includes('authorization');
    let allData: BoundFolioAllDataRead | null = null;
    if (wantsTransactions) {
      allData = await readBoundFolioAllDataPages({
        facade,
        confirmationNumber: input.expectedConfirmationToken,
        reservationStayId,
        detailValues: detailValues as Record<string, string | number | null | undefined>,
        parentProof,
        context: {
          evidenceRef,
          observedAt,
          expiresAt: sourceExpiresAt,
        },
        signal,
        started,
        initialBytesObserved: bytesObserved,
      });
      assertNotAborted(signal);
      if (!allData.unavailable && allData.blocker) {
        return boundFolioManualResult(child, requested, boundFolioReason(allData.blocker));
      }
      if (allData.bytesObserved + bytesObserved > FOLIO_READ_MAX_BYTES) {
        return boundFolioManualResult(child, requested, 'SIZE_LIMIT');
      }
      if (Date.now() - started > FOLIO_BOUND_READ_MAX_DURATION_MS) {
        return boundFolioManualResult(child, requested, 'TIMEOUT');
      }
      if (session.terminal() || session.violation()) {
        return boundFolioManualResult(child, requested, 'SOURCE_UNAVAILABLE');
      }
      durationMs = Date.now() - started;
      if (!allData.unavailable && allData.sourceHash) {
        const expectedDigest = boundFolioCursorDigest(
          parentProof,
          allData.sourceHash,
          requested,
          cursor.offset,
        );
        if (
          paging?.cursor &&
          (cursor.digest !== expectedDigest || cursor.offset >= allData.items.length)
        ) {
          return boundFolioManualResult(child, requested, 'STALE_EVIDENCE');
        }
      } else if (paging?.cursor) {
        return boundFolioManualResult(child, requested, 'SOURCE_UNAVAILABLE');
      }
    }

    assertNotAborted(signal);
    await closeSession?.();
    assertNotAborted(signal);
    const finalizedReceipt = finalizedFolioReceipt(session, auditSpec, 'folio_summary');
    if (auditSpec && !finalizedReceipt) {
      return boundFolioManualResult(child, requested, 'SOURCE_UNAVAILABLE');
    }
    const finalizedExpiry = finalizedReceipt?.expiresAt;
    const expiresAt =
      finalizedExpiry && Date.parse(finalizedExpiry) < Date.parse(sourceExpiresAt)
        ? finalizedExpiry
        : sourceExpiresAt;
    const evidence = boundFolioEvidence({
      evidenceRef,
      body,
      sourceBodies: allData?.sourceBodies,
      authorization,
      child,
      observedAt,
      expiresAt,
      artifactRef: finalizedReceipt?.artifactId,
    });

    const balance = boundFolioBalanceSection(
      parsed.balanceSection,
      parsed.totalBalance,
      parsed.currency,
      evidenceRef,
      observedAt,
      expiresAt,
      wantsBalance,
    );
    const deposits = unknownSection(wantsDeposits ? 'SOURCE_UNAVAILABLE' : 'NOT_REQUESTED');
    const transactions = wantsTransactions
      ? allData && !allData.unavailable
        ? boundFolioTransactionsPage(
            allData.items,
            cursor.offset,
            pageLimit,
            parentProof,
            allData.sourceHash,
            requested,
          )
        : unknownSection('SOURCE_UNAVAILABLE')
      : unknownSection('NOT_REQUESTED');
    const authorizationFact = unknownFact({
      reasonCode: wantsAuthorization ? 'SOURCE_UNAVAILABLE' : 'NOT_REQUESTED',
    });
    const disclosure = boundFolioDisclosure(trustedDisclosure);

    const data = folioReadDataSchema.parse({
      reservationBinding: 'exact_parent_redacted',
      guestPrivacy: 'identity_redacted',
      currency: parsed.currency,
      ...(wantsBalance && parsed.totalBalance != null ? { totalBalance: parsed.totalBalance } : {}),
      balance,
      deposits,
      transactions,
      liabilityLocation: unknownFact({ reasonCode: 'NOT_REQUESTED' }),
      authorization: authorizationFact,
      disclosure: {
        ...disclosure,
        claimEligibility: folioClaimEligibility(disclosure.recipientClass, disclosure.inquiryClass),
      },
      rowsScanned: Math.min(
        FOLIO_READ_MAX_TOTAL_ROWS,
        parsed.rowsScanned + (allData?.rowsScanned ?? 0),
      ),
      bytesObserved: parsed.bytesObserved + (allData?.bytesObserved ?? 0),
      durationMs,
      observedAt,
    });

    const unavailableSections = [
      ...(wantsBalance ? [boundFolioSectionIssue('balance', balance)] : []),
      ...(wantsDeposits ? [boundFolioSectionIssue('deposits', deposits)] : []),
      ...(wantsTransactions ? [boundFolioSectionIssue('transactions', transactions)] : []),
      ...(wantsAuthorization
        ? [{ section: 'authorization', reasonCode: 'SOURCE_UNAVAILABLE' as const }]
        : []),
    ].filter((value): value is { section: string; reasonCode: ReadReasonCode } => value !== null);
    const transactionPartial = wantsTransactions && transactions?.state !== 'available';
    const complete = unavailableSections.length === 0 && !transactionPartial;
    const hasPerFolioBalance =
      wantsBalance &&
      parsed.balanceSection?.data.items.some((item) => item.balance.state === 'known') === true;
    const hasData =
      (wantsBalance && (parsed.totalBalance != null || hasPerFolioBalance)) ||
      (wantsTransactions && transactions?.state === 'available');
    const issues = [
      ...unavailableSections.map(({ reasonCode }) => readIssue(reasonCode)),
      ...(transactionPartial ? [readIssue('PARTIAL_WINDOW')] : []),
    ];
    const result: ReadResult<FolioReadData> = {
      toolId: 'hms_read_folio',
      schemaVersion: '1.0.0',
      status: complete ? 'ok' : hasData ? 'partial' : 'manual_required',
      data,
      completeness: complete ? 'complete' : hasData ? 'partial' : 'unknown',
      unavailableSections,
      scopeRef: child.scopeHash,
      evidence: [evidence],
      page:
        wantsTransactions && transactions?.state === 'available' ? transactions.data.page : null,
      issues,
    };
    if (!readResultSchema.safeParse(result).success) {
      return boundFolioManualResult(child, requested, 'UNSUPPORTED_FORMAT');
    }
    return result;
  } catch (error) {
    const boundedTransportReason = boundedFolioTransportReason(error);
    const reasonCode: ReadReasonCode =
      error instanceof Error && error.name === 'AbortError'
        ? 'TIMEOUT'
        : error instanceof HmsRuntimeError &&
            (error.code === 'PROPERTY_MISMATCH' || error.code === 'ROLE_SCOPE_INVALID')
          ? 'SCOPE_DENIED'
          : boundedTransportReason ?? 'SOURCE_UNAVAILABLE';
    return boundFolioManualResult(child, requested, reasonCode);
  } finally {
    if (session && !sessionClosed) {
      try {
        if (closeSession) await closeSession();
        else await session.close();
      } catch {
        // The canonical result already failed closed; never replace it with
        // a provider/native cleanup error.
      }
    }
  }
}

export function createLiveFolioReadDriver(input: LiveFolioReadDriverInput): LiveFolioReadDriver {
  const { runtime, transportId, expectedConfirmationToken, expectedPropertyCode = 'HRCEN' } = input;

  return {
    observeBoundFolio(authorization, child, requestedSections, signal, trustedDisclosure, paging) {
      return runBoundFolioRead(
        input,
        authorization,
        child,
        requestedSections,
        signal,
        trustedDisclosure,
        paging,
      );
    },
    async observeFolioBalance(authorization, child, signal) {
      assertNotAborted(signal);
      assertFolioAuth(
        authorization,
        child,
        new Set(['folio_summary']),
        'folio_summary',
        expectedPropertyCode,
      );

      const observedAt = new Date();
      const started = observedAt.getTime();

      if (input.detailDumpFor) {
        const dump = await input.detailDumpFor();
        if (dump) {
          const projected = projectFolioBalanceFromDetailDump(dump);
          const durationMs = Date.now() - started;
          if (projected.status === 'available' && projected.currency && projected.totalBalance) {
            return {
              status: 'ok' as const,
              currency: projected.currency,
              totalBalance: projected.totalBalance,
              evidenceId: `folio-detail-${randomUUID()}`,
              blocker: null,
              observedAt: observedAt.toISOString(),
              durationMs,
              bytesObserved: Buffer.byteLength(JSON.stringify(projected.claimKeys)),
              rowsScanned: 1,
              reservationScopeProven: true,
              sourceSurface: 'guest_stay_detail_balance',
            };
          }
        }
      }

      const auditSpec = input.auditSpecFor?.({ branchId: 'folio_summary' });
      const session = await runtime.openReadSession({
        transportId,
        signal,
        allowUnstarted: true,
        auditSpec,
        sessionAuthorization: authorization,
      });
      let sessionClosed = false;
      const closeSession = async () => {
        if (sessionClosed) return;
        sessionClosed = true;
        await session.close();
      };

      try {
        assertNotAborted(signal);
        const facade = createFolioReadFacade(session, { expectedPropertyCode });
        const candidate: ExactReservationCandidate = {
          id: child.id,
          kind: 'confirmation',
          value: expectedConfirmationToken,
        };
        const text = await facade.openOsressAndSearch(candidate);
        if (session.terminal() || session.violation()) {
          return {
            status: 'manual_required',
            currency: null,
            totalBalance: null,
            evidenceId: null,
            blocker: 'FOLIO_SESSION_VIOLATION',
            observedAt: observedAt.toISOString(),
            durationMs: 0,
            bytesObserved: 0,
            rowsScanned: 0,
          };
        }

        assertNotAborted(signal);
        let parsed = parseFolioBalanceTransport(text, expectedConfirmationToken);
        // Dataspy 1941 may omit foliobalance or the scoped row. Deepen via the
        // exact OSRESV.FOL tab bound to the same parent confirmation. The FOL
        // response may establish scope only when it yields both admissible
        // money and currency; otherwise remain fail-closed.
        if (
          !parsed.reservationScopeProven ||
          parsed.totalBalance == null ||
          parsed.currency == null
        ) {
          assertNotAborted(signal);
          const folText = await facade.openOsresvFol({
            confirmationNumber: expectedConfirmationToken,
            reservationStayId: input.reservationStayId,
          });
          const folParsed = parseFolioFolTransport(folText);
          if (parsed.hasCardLeak || folParsed.hasCardLeak) {
            return {
              status: 'manual_required',
              currency: null,
              totalBalance: null,
              evidenceId: null,
              blocker: 'FOLIO_PCI_FIELD_SUPPRESSED',
              observedAt: observedAt.toISOString(),
              durationMs: Date.now() - started,
              bytesObserved: parsed.bytesObserved + Buffer.byteLength(folText),
              rowsScanned: parsed.rowsScanned,
            };
          }
          // Legacy OSRESV.FOL has no response-side parent proof. Never promote
          // its money/currency into the identity-scoped balance result; the
          // bound reader owns the only path allowed to claim that scope.
          return {
            status: 'manual_required',
            currency: null,
            totalBalance: null,
            evidenceId: null,
            blocker: FOLIO_RESERVATION_SCOPE_BLOCKER,
            observedAt: observedAt.toISOString(),
            durationMs: Date.now() - started,
            bytesObserved: parsed.bytesObserved + Buffer.byteLength(folText),
            rowsScanned: parsed.rowsScanned,
            reservationScopeProven: false,
            scopeVerified: false,
          };
        }
        const durationMs = Date.now() - started;
        if (parsed.hasCardLeak) {
          return {
            status: 'manual_required',
            currency: null,
            totalBalance: null,
            evidenceId: null,
            blocker: 'FOLIO_PCI_FIELD_SUPPRESSED',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: parsed.bytesObserved,
            rowsScanned: parsed.rowsScanned,
          };
        }
        if (!parsed.reservationScopeProven) {
          return {
            status: 'manual_required',
            currency: null,
            totalBalance: null,
            evidenceId: null,
            blocker: FOLIO_RESERVATION_SCOPE_BLOCKER,
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: parsed.bytesObserved,
            rowsScanned: parsed.rowsScanned,
            reservationScopeProven: false,
          };
        }
        if (!parsed.envelopeRecognized || parsed.totalBalance == null || parsed.currency == null) {
          return {
            status: 'unverified_negative',
            currency: parsed.currency,
            totalBalance: parsed.totalBalance,
            evidenceId: null,
            blocker: 'UNVERIFIED_NEGATIVE',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: parsed.bytesObserved,
            rowsScanned: parsed.rowsScanned,
            reservationScopeProven: parsed.reservationScopeProven,
          };
        }
        if (
          parsed.bytesObserved > FOLIO_READ_MAX_BYTES ||
          durationMs > FOLIO_READ_MAX_DURATION_MS ||
          parsed.rowsScanned > FOLIO_READ_MAX_ROWS
        ) {
          return {
            status: 'manual_required',
            currency: null,
            totalBalance: null,
            evidenceId: null,
            blocker: 'FOLIO_BOUNDS_EXCEEDED',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: parsed.bytesObserved,
            rowsScanned: parsed.rowsScanned,
            reservationScopeProven: parsed.reservationScopeProven,
          };
        }

        await closeSession();
        const finalizedReceipt = finalizedFolioReceipt(session, auditSpec, 'folio_summary');
        if (auditSpec && !finalizedReceipt) {
          return {
            status: 'manual_required',
            currency: null,
            totalBalance: null,
            evidenceId: null,
            blocker: 'FOLIO_FINALIZED_RECEIPT_INVALID',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: parsed.bytesObserved,
            rowsScanned: parsed.rowsScanned,
            reservationScopeProven: true,
            scopeVerified: false,
          };
        }
        return {
          status: 'ok',
          currency: parsed.currency,
          totalBalance: parsed.totalBalance,
          evidenceId: randomUUID(),
          blocker: null,
          observedAt: observedAt.toISOString(),
          durationMs,
          bytesObserved: parsed.bytesObserved,
          rowsScanned: Math.max(parsed.rowsScanned, 1),
          reservationScopeProven: true,
          scopeVerified: true,
          manifestSha256: authorization.manifestSha256,
          scopeHash: child.scopeHash,
          ...(finalizedReceipt
            ? { artifactRef: finalizedReceipt.artifactId, finalizedReceipt }
            : {}),
        };
      } finally {
        await closeSession();
      }
    },

    async observeDepositSummary(authorization, child, signal) {
      assertNotAborted(signal);
      assertFolioAuth(
        authorization,
        child,
        new Set(['deposit_ledger_summary']),
        'deposit_ledger_summary',
        expectedPropertyCode,
      );

      const observedAt = new Date();
      const started = observedAt.getTime();
      const auditSpec = input.auditSpecFor?.({ branchId: 'deposit_ledger_summary' });
      const session = await runtime.openReadSession({
        transportId,
        signal,
        allowUnstarted: true,
        auditSpec,
        sessionAuthorization: authorization,
      });
      let sessionClosed = false;
      const closeSession = async () => {
        if (sessionClosed) return;
        sessionClosed = true;
        await session.close();
      };

      try {
        assertNotAborted(signal);
        const facade = createFolioReadFacade(session, { expectedPropertyCode });
        const lstText = await facade.openDepositLedgerList();
        if (session.terminal() || session.violation()) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: 'DEPOSIT_SESSION_VIOLATION',
            observedAt: observedAt.toISOString(),
            durationMs: 0,
            bytesObserved: 0,
            rowsScanned: 0,
          };
        }

        assertNotAborted(signal);
        const scopeExtraction = extractDepositLedgerDateScopes(
          lstText,
          DEPOSIT_LEDGER_MAX_DETAIL_DATES,
          expectedPropertyCode,
          expectedConfirmationToken,
        );
        if (scopeExtraction.propertyMismatch) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: 'DEPOSIT_LEDGER_PROPERTY_SCOPE_MISMATCH',
            observedAt: observedAt.toISOString(),
            durationMs: Date.now() - started,
            bytesObserved: Buffer.byteLength(lstText),
            rowsScanned: scopeExtraction.rowsObserved,
            reservationScopeProven: false,
            scopeVerified: false,
          };
        }
        if (
          scopeExtraction.propertyUnknown &&
          (scopeExtraction.matchingConfirmationObserved || scopeExtraction.scopes.length > 0)
        ) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: DEPOSIT_LEDGER_PROPERTY_SCOPE_UNRESOLVED,
            observedAt: observedAt.toISOString(),
            durationMs: Date.now() - started,
            bytesObserved: Buffer.byteLength(lstText),
            rowsScanned: scopeExtraction.rowsObserved,
            reservationScopeProven: false,
            scopeVerified: false,
          };
        }
        const scopes = scopeExtraction.scopes;
        const detailTexts: string[] = [];
        if (scopes.length > 0) {
          for (const scope of scopes) {
            assertNotAborted(signal);
            const detailText = await facade.openDepositLedgerDetail(scope);
            detailTexts.push(detailText);
            if (session.terminal() || session.violation()) {
              return {
                status: 'manual_required',
                currency: null,
                depositSummary: null,
                evidenceId: null,
                blocker: 'DEPOSIT_SESSION_VIOLATION',
                observedAt: observedAt.toISOString(),
                durationMs: 0,
                bytesObserved: 0,
                rowsScanned: 0,
              };
            }
          }
        }

        const parsed =
          detailTexts.length > 0
            ? parseDepositLedgerPages(detailTexts, expectedConfirmationToken)
            : parseDepositLedgerTransport(lstText, expectedConfirmationToken);
        const totalBytesObserved =
          Buffer.byteLength(lstText) +
          detailTexts.reduce((total, detailText) => total + Buffer.byteLength(detailText), 0);
        const durationMs = Date.now() - started;

        if (
          totalBytesObserved > FOLIO_READ_MAX_BYTES ||
          parsed.rowsScanned > FOLIO_READ_MAX_ROWS ||
          durationMs > FOLIO_READ_MAX_DURATION_MS
        ) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: 'FOLIO_BOUNDS_EXCEEDED',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: totalBytesObserved,
            rowsScanned: parsed.rowsScanned,
          };
        }

        if (!parsed.reservationScopeProven) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: DEPOSIT_LEDGER_RESERVATION_SCOPE_BLOCKER,
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: totalBytesObserved,
            rowsScanned: parsed.rowsScanned,
          };
        }
        if (parsed.hasCardLeak) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: 'DEPOSIT_CARD_FIELD_LEAK',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: totalBytesObserved,
            rowsScanned: parsed.rowsScanned,
          };
        }
        if (
          parsed.depositSummary == null ||
          parsed.currency == null ||
          !parsed.envelopeRecognized
        ) {
          return {
            status: 'unverified_negative',
            currency: parsed.currency,
            depositSummary: null,
            evidenceId: null,
            blocker: 'UNVERIFIED_NEGATIVE',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: totalBytesObserved,
            rowsScanned: parsed.rowsScanned,
          };
        }

        const completeness = scopeExtraction.truncated ? 'partial' : parsed.completeness;
        const unmappedActivities = scopeExtraction.truncated
          ? [...parsed.unmappedActivities, 'DEPOSIT_LEDGER_DATE_SCOPE_TRUNCATED']
          : parsed.unmappedActivities;

        await closeSession();
        const finalizedReceipt = finalizedFolioReceipt(
          session,
          auditSpec,
          'deposit_ledger_summary',
        );
        if (auditSpec && !finalizedReceipt) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: 'FOLIO_FINALIZED_RECEIPT_INVALID',
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: totalBytesObserved,
            rowsScanned: parsed.rowsScanned,
            reservationScopeProven: true,
            scopeVerified: false,
            completeness,
            unmappedActivities,
          };
        }
        return {
          status: 'ok',
          currency: parsed.currency,
          depositSummary: parsed.depositSummary,
          evidenceId: randomUUID(),
          blocker: null,
          observedAt: observedAt.toISOString(),
          durationMs,
          bytesObserved: totalBytesObserved,
          rowsScanned: parsed.rowsScanned,
          completeness,
          unmappedActivities,
          reservationScopeProven: true,
          scopeVerified: true,
          manifestSha256: authorization.manifestSha256,
          scopeHash: child.scopeHash,
          ...(finalizedReceipt
            ? { artifactRef: finalizedReceipt.artifactId, finalizedReceipt }
            : {}),
        };
      } finally {
        await closeSession();
      }
    },
  };
}

export function observeFolioBalance(
  this: LiveFolioReadDriver | void,
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  signal: AbortSignal,
): Promise<FolioBalanceKernelResult> {
  if (!this || typeof this.observeFolioBalance !== 'function') {
    throw new Error(
      'observeFolioBalance requires createLiveFolioReadDriver(...).observeFolioBalance binding',
    );
  }
  return this.observeFolioBalance(authorization, child, signal);
}

export function observeDepositSummary(
  this: LiveFolioReadDriver | void,
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  signal: AbortSignal,
): Promise<DepositSummaryKernelResult> {
  if (!this || typeof this.observeDepositSummary !== 'function') {
    throw new Error(
      'observeDepositSummary requires createLiveFolioReadDriver(...).observeDepositSummary binding',
    );
  }
  return this.observeDepositSummary(authorization, child, signal);
}
