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
  return key.toLowerCase().replace(/^ff_/, '').replace(/^filter_/, '');
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
