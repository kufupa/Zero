/**
 * Live Folio + Deposit Ledger observers (Task 16).
 * Folio: OSRESS foliobalance / propertycurrency (display only).
 * Deposit: OSLEDG.LST — reservation confirmation column required for scope.
 * Observations never emit recipientClass/inquiryClass, card PAN, or guest names.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import type { ReadCandidateChild } from './candidate-graph.js';
import {
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
  FOLIO_READ_MAX_ROWS,
  folioClaimEligibility,
  folioReadDataSchema,
  type FolioReadData,
} from './folio-read-contract.js';
import { extractOsressPageData } from './live-guest-stay-driver.js';
import { createFolioReadFacade } from './folio-read-facade.js';
import type { ExactReservationCandidate } from './live-read-manifest.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HmsRuntimeError, type HmsRuntime } from './runtime.js';

export const DEPOSIT_LEDGER_RESERVATION_SCOPE_BLOCKER =
  'BLOCKED_DEPOSIT_LEDGER_RESERVATION_SCOPE_UNPROVEN';

export const LIVE_FOLIO_BALANCE_ALIAS_KEYS = [
  'foliobalance',
  'propertycurrency',
] as const;

export const LIVE_DEPOSIT_LEDGER_ALIAS_KEYS = [
  'currency',
  'newdeposits',
  'refunds',
  'forfeits',
  'toguestledger',
  'fromdeposit',
  'confirmationnumber',
] as const;

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
};

export type TrustedFolioDisclosure = {
  recipientClass: FolioReadData['disclosure']['recipientClass'];
  inquiryClass: FolioReadData['disclosure']['inquiryClass'];
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
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

export function normalizeMoney(
  raw: unknown,
  opts?: { unsigned?: boolean },
): string | null {
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

function gridDataRows(
  pageData: Record<string, unknown>,
): Record<string, unknown>[] {
  const gridWrap = pageData.grid;
  if (gridWrap == null || typeof gridWrap !== 'object') return [];
  const gridResult = (gridWrap as Record<string, unknown>).GRIDRESULT;
  if (gridResult == null || typeof gridResult !== 'object') return [];
  const inner = (gridResult as Record<string, unknown>).GRID;
  if (inner == null || typeof inner !== 'object') return [];
  const data = (inner as Record<string, unknown>).DATA;
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r && typeof r === 'object') as Record<
    string,
    unknown
  >[];
}

export function buildDepositSummary(raw: {
  due: string;
  paid: string;
  refunded: string;
  forfeited: string;
  transferred: string;
}): FolioReadData['depositSummary'] {
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
export function parseFolioBalanceTransport(text: string): {
  envelopeRecognized: boolean;
  currency: string | null;
  totalBalance: string | null;
  rowsScanned: number;
  bytesObserved: number;
  hasCardLeak: boolean;
} {
  const bytesObserved = Math.min(Buffer.byteLength(text), FOLIO_READ_MAX_BYTES);
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
      currency: null,
      totalBalance: null,
      rowsScanned: 0,
      bytesObserved,
      hasCardLeak,
    };
  }

  const rows = gridDataRows(pageData);
  let currency: string | null = null;
  let totalBalance: string | null = null;
  let rowsScanned = 0;

  for (const row of rows.slice(0, FOLIO_READ_MAX_ROWS)) {
    rowsScanned += 1;
    const bal =
      normalizeMoney(row.foliobalance) ??
      normalizeMoney(row.balance) ??
      normalizeMoney(row.totalbalance);
    const cur =
      normalizeCurrency(row.propertycurrency) ??
      normalizeCurrency(row.currency);
    if (bal != null) totalBalance = bal;
    if (cur != null) currency = cur;
  }

  if (totalBalance == null) {
    totalBalance = normalizeMoney(pageData.foliobalance);
  }
  if (currency == null) {
    currency =
      normalizeCurrency(pageData.propertycurrency) ??
      normalizeCurrency(pageData.currency);
  }
  const fields = pageData.fields;
  if (fields && typeof fields === 'object') {
    const f = fields as Record<string, unknown>;
    if (totalBalance == null) totalBalance = normalizeMoney(f.foliobalance);
    if (currency == null) currency = normalizeCurrency(f.propertycurrency);
  }

  return {
    envelopeRecognized: true,
    currency,
    totalBalance,
    rowsScanned: Math.max(rowsScanned, totalBalance != null ? 1 : 0),
    bytesObserved,
    hasCardLeak,
  };
}

/**
 * Parse OSLEDG.LST. Reservation correlation requires confirmationnumber on row.
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
} {
  const bytesObserved = Math.min(Buffer.byteLength(text), FOLIO_READ_MAX_BYTES);
  if (/data-testid\s*=\s*["']deposit-/i.test(text)) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'fixture HTML deposit fallback rejected in live observer',
    );
  }
  const hasCardLeak = /"cardnumber"\s*:\s*"[0-9]{12,}"/i.test(text);
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
    };
  }

  const rows = gridDataRows(pageData);
  const token = expectedConfirmationToken.trim();
  let matched: Record<string, unknown> | null = null;
  let hasConfirmationColumn = false;

  for (const row of rows.slice(0, FOLIO_READ_MAX_ROWS)) {
    if ('confirmationnumber' in row || 'confirmation' in row) {
      hasConfirmationColumn = true;
    }
    const conf =
      strOrEmpty(row.confirmationnumber) || strOrEmpty(row.confirmation);
    if (token && conf && conf === token) {
      matched = row;
      break;
    }
  }

  if (!hasConfirmationColumn || !matched) {
    return {
      envelopeRecognized: true,
      reservationScopeProven: false,
      currency: null,
      depositSummary: null,
      rowsScanned: rows.length,
      bytesObserved,
      hasCardLeak,
    };
  }

  const currency = normalizeCurrency(matched.currency);
  const paid =
    normalizeMoney(matched.newdeposits, { unsigned: true }) ?? '0.00';
  const refunded =
    normalizeMoney(matched.refunds, { unsigned: true }) ?? '0.00';
  const forfeited =
    normalizeMoney(matched.forfeits, { unsigned: true }) ?? '0.00';
  const transferred =
    normalizeMoney(matched.toguestledger, { unsigned: true }) ??
    normalizeMoney(matched.fromdeposit, { unsigned: true }) ??
    '0.00';
  const due = normalizeMoney(matched.due, { unsigned: true }) ?? '0.00';

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
  };
}

function assertFolioAuth(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  allowedBranches: ReadonlySet<string>,
  discoveryOperationId: string,
): void {
  if (authorization.toolId !== 'hms_read_folio') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for folio observer',
    );
  }
  if (authorization.discoveryOperationId !== discoveryOperationId) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId mismatch',
    );
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
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child toolId does not match authorization',
    );
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
  if (child.propertyCode !== 'HRCEN') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child propertyCode denied',
    );
  }
}

function emptyEvidence(
  observedAt: string,
  sourceSeed: string,
): ToolResult<FolioReadData>['evidence'] {
  return {
    kind: 'hms',
    id: randomUUID(),
    toolId: 'hms_read_folio',
    toolVersion: '1.0.0',
    propertyCode: 'HRCEN',
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
    claimKeys: [],
    sourceHash: sha256Hex(sourceSeed),
  };
}

/**
 * Merge Folio + Deposit kernel results. Disclosure must come from trusted
 * requester authorization — never from HMS observations.
 */
export function mergeFolioEvidence(
  steps: readonly (FolioBalanceKernelResult | DepositSummaryKernelResult)[],
  trustedDisclosure?: TrustedFolioDisclosure,
): ToolResult<FolioReadData> {
  const observedAt =
    steps.find((s) => s.observedAt)?.observedAt ?? new Date().toISOString();
  const evidence = emptyEvidence(
    observedAt,
    JSON.stringify(steps.map((s) => s.evidenceId)),
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

  const balance = steps.find(
    (s): s is FolioBalanceKernelResult =>
      Object.prototype.hasOwnProperty.call(s, 'totalBalance'),
  );
  const deposit = steps.find(
    (s): s is DepositSummaryKernelResult =>
      Object.prototype.hasOwnProperty.call(s, 'depositSummary'),
  );

  const unresolved: string[] = [];

  const balanceOk =
    balance?.status === 'ok' &&
    balance.totalBalance != null &&
    balance.currency != null;
  const depositOk =
    deposit?.status === 'ok' &&
    deposit.depositSummary != null &&
    deposit.currency != null;

  if (!balanceOk) {
    unresolved.push(balance?.blocker ?? 'FOLIO_BALANCE_UNAVAILABLE');
  }
  if (!depositOk) {
    unresolved.push(deposit?.blocker ?? 'DEPOSIT_SUMMARY_UNAVAILABLE');
  }

  if (!balanceOk && !depositOk) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: unresolved.length ? unresolved : ['FOLIO_MERGE_EMPTY'],
      evidence,
    };
  }

  if (balanceOk && depositOk && balance!.currency !== deposit!.currency) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {} as FolioReadData,
      unresolvedFields: ['FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT'],
      evidence,
    };
  }

  const currency = (balanceOk ? balance!.currency : deposit!.currency)!;
  const totalBalance = balanceOk ? balance!.totalBalance! : '0.00';
  const depositSummary = depositOk
    ? deposit!.depositSummary!
    : buildDepositSummary({
        due: '0.00',
        paid: '0.00',
        refunded: '0.00',
        forfeited: '0.00',
        transferred: '0.00',
      });

  const rowsScanned = Math.min(
    FOLIO_READ_MAX_ROWS,
    (balance?.rowsScanned ?? 0) + (deposit?.rowsScanned ?? 0),
  );
  const bytesObserved = Math.min(
    FOLIO_READ_MAX_BYTES,
    (balance?.bytesObserved ?? 0) + (deposit?.bytesObserved ?? 0),
  );
  const durationMs = Math.min(
    FOLIO_READ_MAX_DURATION_MS,
    Math.max(balance?.durationMs ?? 0, deposit?.durationMs ?? 0),
  );

  try {
    const data = folioReadDataSchema.parse({
      reservationBinding: 'exact_parent_redacted',
      guestPrivacy: 'identity_redacted',
      currency,
      totalBalance,
      depositSummary,
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

    const partial = !(balanceOk && depositOk);
    return {
      status: partial ? 'partial' : 'ok',
      draftReady: !partial,
      data,
      unresolvedFields: partial ? unresolved : [],
      evidence: {
        ...evidence,
        claimKeys: ['folio_deposit_summary'],
        sourceHash: sha256Hex(JSON.stringify(data)),
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
};

export type LiveFolioReadDriverInput = {
  runtime: HmsRuntime;
  transportId: string;
  expectedConfirmationToken: string;
};

export function createLiveFolioReadDriver(
  input: LiveFolioReadDriverInput,
): LiveFolioReadDriver {
  const { runtime, transportId, expectedConfirmationToken } = input;

  return {
    async observeFolioBalance(authorization, child, signal) {
      assertNotAborted(signal);
      assertFolioAuth(
        authorization,
        child,
        new Set(['folio_summary']),
        'folio_summary',
      );

      const observedAt = new Date();
      const started = observedAt.getTime();
      const session = await runtime.openReadSession({
        transportId,
        signal,
        allowUnstarted: true,
        sessionAuthorization: authorization,
      });

      try {
        assertNotAborted(signal);
        const facade = createFolioReadFacade(session);
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
        const parsed = parseFolioBalanceTransport(text);
        const durationMs = Math.min(
          Date.now() - started,
          FOLIO_READ_MAX_DURATION_MS,
        );
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
        if (
          !parsed.envelopeRecognized ||
          parsed.totalBalance == null ||
          parsed.currency == null
        ) {
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
        };
      } finally {
        await session.close();
      }
    },

    async observeDepositSummary(authorization, child, signal) {
      assertNotAborted(signal);
      assertFolioAuth(
        authorization,
        child,
        new Set(['deposit_ledger_summary']),
        'deposit_ledger_summary',
      );

      const observedAt = new Date();
      const started = observedAt.getTime();
      const session = await runtime.openReadSession({
        transportId,
        signal,
        allowUnstarted: true,
        sessionAuthorization: authorization,
      });

      try {
        assertNotAborted(signal);
        const facade = createFolioReadFacade(session);
        const text = await facade.openDepositLedgerList();
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
        const parsed = parseDepositLedgerTransport(
          text,
          expectedConfirmationToken,
        );
        const durationMs = Math.min(
          Date.now() - started,
          FOLIO_READ_MAX_DURATION_MS,
        );

        if (!parsed.reservationScopeProven) {
          return {
            status: 'manual_required',
            currency: null,
            depositSummary: null,
            evidenceId: null,
            blocker: DEPOSIT_LEDGER_RESERVATION_SCOPE_BLOCKER,
            observedAt: observedAt.toISOString(),
            durationMs,
            bytesObserved: parsed.bytesObserved,
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
            bytesObserved: parsed.bytesObserved,
            rowsScanned: parsed.rowsScanned,
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
          bytesObserved: parsed.bytesObserved,
          rowsScanned: parsed.rowsScanned,
        };
      } finally {
        await session.close();
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
