import { z } from 'zod';

export function isIsoCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

const isoCalendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isIsoCalendarDay(value), {
    message: 'expected a real YYYY-MM-DD calendar day',
  });
const dateInput = z.union([isoCalendarDay, z.string()]);

export const matchPaymentProofInputSchema = z.object({
  pop: z.object({
    amount: z.number().nullable(),
    reference: z.string().nullable(),
    payerName: z.string().nullable(),
    paidOn: z.union([isoCalendarDay, z.string(), z.null()]).nullable(),
  }),
  candidates: z.array(
    z.object({
      confirmationNumber: z.string(),
      lastName: z.string(),
      arrival: dateInput,
      departure: dateInput,
      balanceDue: z.number().nullable().optional(),
      company: z.string().nullable().optional(),
    }),
  ),
});

export const matchPaymentProofOutputSchema = z.object({
  status: z.enum(['exact', 'ambiguous', 'none']),
  confirmationNumber: z.string().nullable(),
  score: z.number(),
  why: z.array(z.string()),
  candidates: z.array(z.string()),
});

export type MatchPaymentProofInput = z.infer<typeof matchPaymentProofInputSchema>;
export type MatchPaymentProofOutput = z.infer<typeof matchPaymentProofOutputSchema>;
export type PaymentProofSelection = {
  bodyText?: string;
  attachments?: Array<{ text?: string | null }>;
};

export const matchPaymentProofDescription =
  'Match POP fields to stay candidates. A stated confirmation number (whole token; 6–10 digit base matches its -N legs; full base-N only that leg) is decisive. Amount, payer, company and dates only break ties when no confirmation is stated. If a confirmation is stated but no unique candidate matches, returns none/ambiguous with why stated_conf_not_found and never falls back to soft signals. Soft signals that uniquely name a different stay than the stated confirmation make the result ambiguous. Use confirmationNumber only when status is exact.';

const SCORE_AMOUNT = 4;
const SCORE_NAME = 2;
const SCORE_COMPANY = 2;
const SCORE_DATE = 1;
const MIN_EXACT = SCORE_NAME;
const STATED_CONF_NOT_FOUND = 'stated_conf_not_found';
const BASE_CONF = /^\d{6,10}$/;
// A base never stands in for a malformed leg: "9999901-1A" yields no token, not the base 9999901.
// Any numeric leg counts as stated, so "9999901-123" is decisive and never drops to soft scoring.
const STATED_CONF_TOKEN = /(?<![A-Za-z0-9-])(\d{6,10}-\d+|\d{6,10})(?![A-Za-z0-9]|-[A-Za-z0-9])/g;
const POP_AMOUNT = /\b(?:R|ZAR)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)\b/gi;
const POP_ISO_DAY = /\b(\d{4}-\d{2}-\d{2})\b/g;
const POP_SLASH_DAY = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const POP_PAYER =
  /\b(?:payer(?:\s*name)?|paid\s+by|account\s+(?:name|holder))\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{1,60})/gi;
const POP_VOUCHER =
  /\b(?:voucher(?:\s*(?:number|no\.?|#))?|vch)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/gi;

type Candidate = MatchPaymentProofInput['candidates'][number];
type Scored = {
  confirmationNumber: string;
  score: number;
  why: string[];
};

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(haystack: string, needle: string, minLength: number): boolean {
  const phrase = needle.trim();
  if (phrase.length < minLength) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`, 'i').test(haystack);
}

function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return isIsoCalendarDay(trimmed) ? trimmed : null;
}

function amountMatches(amount: number | null, balanceDue: number | null | undefined): boolean {
  if (amount == null || balanceDue == null) return false;
  return Math.abs(amount - balanceDue) <= 1;
}

function paidBeforeDeparture(paidOn: string | null, departure: string): boolean {
  const paid = isoDay(paidOn);
  const leave = isoDay(departure);
  if (!paid || !leave) return false;
  return paid < leave;
}

function statedConfTokens(reference: string | null): string[] {
  if (!reference) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of reference.matchAll(STATED_CONF_TOKEN)) {
    const token = match[1];
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function confMatchesToken(confirmationNumber: string, token: string): boolean {
  if (confirmationNumber === token) return true;
  if (!BASE_CONF.test(token)) return false;
  return new RegExp(`^${escapeRe(token)}-\\d+$`).test(confirmationNumber);
}

function matchesStatedConf(confirmationNumber: string, tokens: string[]): boolean {
  return tokens.some((token) => confMatchesToken(confirmationNumber, token));
}

function scoreSoft(pop: MatchPaymentProofInput['pop'], stay: Candidate): Scored {
  const haystack = `${pop.reference ?? ''}\n${pop.payerName ?? ''}`;
  const why: string[] = [];
  let score = 0;
  if (amountMatches(pop.amount, stay.balanceDue ?? null)) {
    score += SCORE_AMOUNT;
    why.push('amount equals balanceDue within R1');
  }
  if (hasPhrase(haystack, stay.lastName, 2)) {
    score += SCORE_NAME;
    why.push('surname in payer or reference');
  }
  if (stay.company && hasPhrase(haystack, stay.company, 3)) {
    score += SCORE_COMPANY;
    why.push('company in payer or reference');
  }
  if (paidBeforeDeparture(pop.paidOn, stay.departure)) {
    score += SCORE_DATE;
    why.push('paidOn is before departure');
  }
  return { confirmationNumber: stay.confirmationNumber, score, why };
}

function decideFromSoft(scored: Scored[]): MatchPaymentProofOutput {
  const ranked = scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.confirmationNumber.localeCompare(b.confirmationNumber));
  const ids = ranked.map((row) => row.confirmationNumber);
  if (ranked.length === 0) {
    return {
      status: 'none',
      confirmationNumber: null,
      score: 0,
      why: ['no matching signals'],
      candidates: [],
    };
  }
  const top = ranked[0]!;
  const tied = ranked.filter((row) => row.score === top.score);
  if (tied.length > 1) {
    return {
      status: 'ambiguous',
      confirmationNumber: null,
      score: top.score,
      why: ['tied candidates; never pick'],
      candidates: tied.map((row) => row.confirmationNumber),
    };
  }
  if (top.score < MIN_EXACT) {
    return {
      status: 'none',
      confirmationNumber: null,
      score: top.score,
      why: top.why,
      candidates: [],
    };
  }
  return {
    status: 'exact',
    confirmationNumber: top.confirmationNumber,
    score: top.score,
    why: top.why,
    candidates: ids,
  };
}

function uniqueSoftWinner(scored: Scored[]): Scored | null {
  const decided = decideFromSoft(scored);
  if (decided.status !== 'exact' || !decided.confirmationNumber) return null;
  return scored.find((row) => row.confirmationNumber === decided.confirmationNumber) ?? null;
}

function selectionSourceTexts(selection: PaymentProofSelection | undefined): {
  attachmentText: string;
  bodyText: string;
} {
  const attachmentText = (selection?.attachments ?? [])
    .map((row) => (typeof row.text === 'string' ? row.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
  const bodyText = typeof selection?.bodyText === 'string' ? selection.bodyText.trim() : '';
  return { attachmentText, bodyText };
}

function preferUnique<T>(attachment: T[], body: T[]): T | null {
  const unique = (values: T[]): T[] => [...new Set(values)];
  const fromAttachment = unique(attachment);
  if (fromAttachment.length > 1) return null;
  if (fromAttachment.length === 1) return fromAttachment[0]!;
  const fromBody = unique(body);
  return fromBody.length === 1 ? fromBody[0]! : null;
}

function amountsIn(text: string): number[] {
  const cents = new Set<number>();
  for (const match of text.matchAll(POP_AMOUNT)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    if (Number.isFinite(value)) cents.add(Math.round(value * 100));
  }
  return [...cents].map((value) => value / 100);
}

function amountDigitForms(text: string): Set<string> {
  const skip = new Set<string>();
  for (const match of text.matchAll(POP_AMOUNT)) {
    const compact = match[1]!.replace(/,/g, '');
    skip.add(compact.replace('.', ''));
    skip.add(compact.split('.')[0]!);
  }
  return skip;
}

function refsIn(text: string): string[] {
  const skip = amountDigitForms(text);
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(STATED_CONF_TOKEN)) {
    const token = match[1];
    if (!token || skip.has(token.replace(/-/g, '')) || seen.has(token)) continue;
    seen.add(token);
    refs.push(token);
  }
  return refs;
}

function slashToIso(day: string, month: string, year: string): string | null {
  const value = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isIsoCalendarDay(value) ? value : null;
}

function datesIn(text: string): string[] {
  const days = new Set<string>();
  for (const match of text.matchAll(POP_ISO_DAY)) {
    const day = match[1];
    if (day && isIsoCalendarDay(day)) days.add(day);
  }
  for (const match of text.matchAll(POP_SLASH_DAY)) {
    const day = slashToIso(match[1]!, match[2]!, match[3]!);
    if (day) days.add(day);
  }
  return [...days];
}

function payersIn(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(POP_PAYER)) {
    const name = match[1]?.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function vouchersIn(text: string): string[] {
  const vouchers: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(POP_VOUCHER)) {
    const voucher = match[1]?.trim();
    if (!voucher) continue;
    const key = voucher.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    vouchers.push(voucher);
  }
  return vouchers;
}

/** POP fields from attachment text first (SyncedQuoteAttachment.text), then the body. Several amounts → null. */
export function buildPaymentProofPop(selection: PaymentProofSelection): MatchPaymentProofInput['pop'] {
  const { attachmentText, bodyText } = selectionSourceTexts(selection);
  const attachRefs = refsIn(attachmentText);
  const bodyRefs = refsIn(bodyText);
  const reference = attachRefs.length > 0 ? attachRefs.join(' ') : bodyRefs.length > 0 ? bodyRefs.join(' ') : null;
  return {
    amount: preferUnique(amountsIn(attachmentText), amountsIn(bodyText)),
    reference,
    payerName: preferUnique(payersIn(attachmentText), payersIn(bodyText)),
    paidOn: preferUnique(datesIn(attachmentText), datesIn(bodyText)),
  };
}

/** Voucher number from attachment text first, then the body. Several distinct values → null. */
export function extractVoucherNumber(selection: PaymentProofSelection): string | null {
  const { attachmentText, bodyText } = selectionSourceTexts(selection);
  return preferUnique(vouchersIn(attachmentText), vouchersIn(bodyText));
}

export function matchPaymentProof(input: MatchPaymentProofInput): MatchPaymentProofOutput {
  const parsed = matchPaymentProofInputSchema.parse(input);
  const tokens = statedConfTokens(parsed.pop.reference);
  const soft = parsed.candidates.map((stay) => scoreSoft(parsed.pop, stay));

  if (tokens.length > 0) {
    const matched = parsed.candidates.filter((stay) =>
      matchesStatedConf(stay.confirmationNumber, tokens),
    );
    const ids = matched.map((stay) => stay.confirmationNumber);
    if (matched.length === 0) {
      return {
        status: 'none',
        confirmationNumber: null,
        score: 0,
        why: [STATED_CONF_NOT_FOUND],
        candidates: [],
      };
    }
    if (matched.length > 1) {
      return {
        status: 'ambiguous',
        confirmationNumber: null,
        score: 0,
        why: [STATED_CONF_NOT_FOUND],
        candidates: ids,
      };
    }
    const winner = matched[0]!;
    const otherSoft = uniqueSoftWinner(soft);
    if (otherSoft && otherSoft.confirmationNumber !== winner.confirmationNumber) {
      const conflictIds = [winner.confirmationNumber, otherSoft.confirmationNumber].sort();
      return {
        status: 'ambiguous',
        confirmationNumber: null,
        score: otherSoft.score,
        why: ['soft signals point to a different stay'],
        candidates: conflictIds,
      };
    }
    return {
      status: 'exact',
      confirmationNumber: winner.confirmationNumber,
      score: 10,
      why: ['stated confirmation number matches'],
      candidates: [winner.confirmationNumber],
    };
  }

  return decideFromSoft(soft);
}
