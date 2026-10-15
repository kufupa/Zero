import { findFirstStayMatch } from './find-first-stay.js';
import {
  buildPaymentProofPop,
  extractVoucherNumber,
  matchPaymentProof,
  type PaymentProofSelection,
} from './payment-proof-match.js';

export type StayPickAsk = {
  lastName: string;
  arrival: string;
  departure?: string;
  confirmationNumber?: string | null;
  voucher?: string;
};
export type StayPickPop = {
  amount: number | null;
  reference: string | null;
  payerName: string | null;
  paidOn: string | null;
};
export type StayPickSelection = PaymentProofSelection;
export type StayPick = {
  status: 'pick' | 'check_conf' | 'none';
  confirmationNumber: string | null;
  why: string[];
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const confOf = (row: Record<string, unknown>) => text(row.confirmationNumber) || text(row.confirmation);

export function lookupRowsFromResult(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') return [];
  const rec = result as Record<string, unknown>;
  if (Array.isArray(rec.rows)) {
    return rec.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  }
  return rec.stay && typeof rec.stay === 'object' ? [rec.stay as Record<string, unknown>] : [];
}

function money(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function toC1(row: Record<string, unknown>) {
  return {
    confirmationNumber: confOf(row),
    lastName: text(row.lastName),
    arrival: text(row.arrival),
    departure: text(row.departure),
    status: text(row.status),
    ...(typeof row.rooms === 'number' ? { rooms: row.rooms } : {}),
    ...(typeof row.notes === 'string' ? { notes: row.notes } : {}),
  };
}

function toC3(row: Record<string, unknown>) {
  const company = text(row.company) || text(row.organization) || null;
  return {
    confirmationNumber: confOf(row),
    lastName: text(row.lastName),
    arrival: text(row.arrival),
    departure: text(row.departure),
    balanceDue: row.balanceDue !== undefined ? money(row.balanceDue) : money(row.balance),
    ...(company ? { company } : {}),
  };
}

function asPick(conf: string | null, why: string[], rows: Record<string, unknown>[]): StayPick {
  const live = rows.filter((row) => confOf(row) === conf && !/\bcancel/i.test(text(row.status))).length;
  if (!conf || live !== 1) {
    return { status: 'check_conf', confirmationNumber: null, why: why.length ? why : ['not a unique live stay'] };
  }
  return { status: 'pick', confirmationNumber: conf, why };
}

export function pickStayFromFindRows(input: {
  ask: StayPickAsk;
  rows: unknown[];
  workflow: string;
  pop?: StayPickPop;
  selection?: StayPickSelection;
}): StayPick {
  const rows = input.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  if (rows.length === 0) return { status: 'none', confirmationNumber: null, why: ['no overlap'] };
  const voucher = input.ask.voucher?.trim() || extractVoucherNumber(input.selection ?? {}) || undefined;
  const c1 = findFirstStayMatch({
    ask: {
      lastName: input.ask.lastName,
      arrival: input.ask.arrival,
      ...(input.ask.departure ? { departure: input.ask.departure } : {}),
      ...(voucher ? { voucherNumber: voucher } : {}),
      ...(input.ask.confirmationNumber !== undefined
        ? { confirmationNumber: input.ask.confirmationNumber }
        : {}),
    },
    candidates: rows.map(toC1),
  });
  const check = (why: string[]): StayPick => ({ status: 'check_conf', confirmationNumber: null, why });
  if (input.workflow === 'post_payment') {
    const c3 = matchPaymentProof({
      pop: input.pop ?? buildPaymentProofPop(input.selection ?? {}),
      candidates: rows.map(toC3),
    });
    const fromC1 = c1.status === 'match' ? asPick(c1.confirmationNumber, c1.why, rows) : null;
    const fromC3 = c3.status === 'exact' ? asPick(c3.confirmationNumber, c3.why, rows) : null;
    if (fromC1?.status === 'pick' && fromC3?.status === 'pick') {
      return fromC1.confirmationNumber === fromC3.confirmationNumber ? fromC1 : check(['C1 and C3 disagree']);
    }
    if (fromC3?.status === 'pick') return fromC3;
    return check(c1.why.length ? c1.why : c3.why);
  }
  return c1.status === 'match' ? asPick(c1.confirmationNumber, c1.why, rows) : check(c1.why);
}
