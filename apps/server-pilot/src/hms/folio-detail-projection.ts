/**
 * Project Guest Stay detail dump balance fields → folio balance observation.
 * Live dump AfL0kuXg proved keys balance + balancecurr (ZAR, signedMoney shape).
 * Deposit ledger / folio tab lines remain SURFACE_UNPROVEN / separate blockers.
 */
import type { ReservationDetailDumpV1 } from './reservation-detail-projection.js';

const SIGNED_MONEY = /^-?(?:0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/^ff_/, '').replace(/^filter_/, '');
}

function valueFor(dump: ReservationDetailDumpV1, key: string): string | null {
  const present = new Set(dump.keys.map(normalizeKey));
  if (!present.has(key)) return null;
  const raw = dump.values?.[key] ?? dump.values?.[key.toLowerCase()];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type ProjectedFolioBalanceFromDetail = {
  status: 'available' | 'unavailable';
  currency: string | null;
  totalBalance: string | null;
  claimKeys: string[];
  reasonCode?: 'SURFACE_UNPROVEN' | 'SOURCE_UNAVAILABLE';
  depositsReasonCode: 'SURFACE_UNPROVEN';
};

export function projectFolioBalanceFromDetailDump(
  dump: ReservationDetailDumpV1,
): ProjectedFolioBalanceFromDetail {
  const balance = valueFor(dump, 'balance');
  const currency = valueFor(dump, 'balancecurr') ?? valueFor(dump, 'propertycurrency');
  const claimKeys: string[] = [];
  if (balance != null && SIGNED_MONEY.test(balance)) claimKeys.push('balance.totalBalance');
  if (currency != null && CURRENCY.test(currency)) claimKeys.push('balance.currency');

  if (
    balance != null &&
    SIGNED_MONEY.test(balance) &&
    currency != null &&
    CURRENCY.test(currency)
  ) {
    return {
      status: 'available',
      currency,
      totalBalance: balance,
      claimKeys,
      depositsReasonCode: 'SURFACE_UNPROVEN',
    };
  }

  return {
    status: 'unavailable',
    currency: null,
    totalBalance: null,
    claimKeys: [],
    reasonCode: 'SURFACE_UNPROVEN',
    depositsReasonCode: 'SURFACE_UNPROVEN',
  };
}
