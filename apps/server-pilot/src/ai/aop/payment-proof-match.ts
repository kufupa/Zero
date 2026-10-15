import { z } from 'zod';

export const matchPaymentProofInputSchema = z.object({
  pop: z.object({
    amount: z.number().nullable(),
    reference: z.string().nullable(),
    payerName: z.string().nullable(),
    paidOn: z.string().nullable(),
  }),
  candidates: z.array(
    z.object({
      confirmationNumber: z.string(),
      lastName: z.string(),
      arrival: z.string(),
      departure: z.string(),
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

export const matchPaymentProofDescription =
  'Score POP fields against stay candidates. Call after reading amount, reference, payer and paid-on from the mail (do not parse amounts here) and listing candidate stays. Returns exact, ambiguous (never pick) or none. Use the confirmationNumber only when status is exact.';

const SCORE_CONF = 10;
const SCORE_AMOUNT = 4;
const SCORE_NAME = 2;
const SCORE_COMPANY = 2;
const SCORE_DATE = 1;
const MIN_EXACT = SCORE_NAME;
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

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

function confInReference(reference: string | null, confirmationNumber: string): boolean {
  if (!reference) return false;
  return hasPhrase(reference, confirmationNumber, 4);
}

function isoDay(value: string | null): string | null {
  if (!value) return null;
  const match = ISO_DAY.exec(value.trim());
  return match?.[1] ?? null;
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

function scoreCandidate(pop: MatchPaymentProofInput['pop'], stay: Candidate): Scored {
  const haystack = `${pop.reference ?? ''}\n${pop.payerName ?? ''}`;
  const why: string[] = [];
  let score = 0;
  if (confInReference(pop.reference, stay.confirmationNumber)) {
    score += SCORE_CONF;
    why.push('confirmation number appears in the reference');
  }
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

export function matchPaymentProof(input: MatchPaymentProofInput): MatchPaymentProofOutput {
  const parsed = matchPaymentProofInputSchema.parse(input);
  const scored = parsed.candidates
    .map((stay) => scoreCandidate(parsed.pop, stay))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.confirmationNumber.localeCompare(b.confirmationNumber));
  const ids = scored.map((row) => row.confirmationNumber);
  if (scored.length === 0) {
    return {
      status: 'none',
      confirmationNumber: null,
      score: 0,
      why: ['no matching signals'],
      candidates: [],
    };
  }
  const top = scored[0]!;
  const tied = scored.filter((row) => row.score === top.score);
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
