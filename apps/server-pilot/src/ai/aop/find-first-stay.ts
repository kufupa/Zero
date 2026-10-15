import { z } from 'zod';
import { dayFromText, surnameFrom } from '../voucher-find.js';

const stayCandidateSchema = z.object({
  confirmationNumber: z.string(),
  lastName: z.string(),
  arrival: z.string(),
  departure: z.string(),
  status: z.string(),
  rooms: z.number().int().optional(),
  notes: z.string().optional(),
});

export const findFirstStayMatchInputSchema = z.object({
  ask: z.object({
    lastName: z.string(),
    arrival: z.string(),
    departure: z.string().optional(),
    rooms: z.number().int().optional(),
    voucherNumber: z.string().optional(),
  }),
  candidates: z.array(stayCandidateSchema),
});

export const findFirstStayMatchOutputSchema = z.object({
  status: z.enum(['match', 'possible', 'none', 'conflict']),
  confirmationNumber: z.string().nullable(),
  why: z.array(z.string()),
});

export type FindFirstStayMatchInput = z.infer<typeof findFirstStayMatchInputSchema>;
export type FindFirstStayMatchOutput = z.infer<typeof findFirstStayMatchOutputSchema>;

export const findFirstStayMatchDescription =
  'Pick the existing HMS stay for a booking ask so create does not double-book. Call after hms find, before create_reservation_dry_run. Pass lastName + arrival (departure, rooms, voucherNumber if known) and the find rows. Exact surname + same arrival, or voucher number in notes, is a match. Same surname ±1 day or same arrival + different surname is possible (staff decide; do not pick). Two matches is conflict (do not pick). Cancelled stays never match.';

function foldSurname(value: string): string {
  const surname = surnameFrom(value) ?? value.trim();
  return surname.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function toDay(value: string): string | null {
  return dayFromText(value);
}

function dayDelta(a: string, b: string): number | null {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function isCancelled(status: string): boolean {
  return /\bcancel/i.test(status);
}

function voucherHitsNotes(voucherNumber: string | undefined, notes: string | undefined): boolean {
  const voucher = voucherNumber?.trim();
  if (!voucher || !notes) return false;
  return notes.toLowerCase().includes(voucher.toLowerCase());
}

type Ranked = { confirmationNumber: string; kind: 'match' | 'possible'; why: string };

export function findFirstStayMatch(input: FindFirstStayMatchInput): FindFirstStayMatchOutput {
  const parsed = findFirstStayMatchInputSchema.parse(input);
  const askSurname = foldSurname(parsed.ask.lastName);
  const askDay = toDay(parsed.ask.arrival);
  const ranked: Ranked[] = [];

  for (const stay of parsed.candidates) {
    if (isCancelled(stay.status)) continue;
    const staySurname = foldSurname(stay.lastName);
    const stayDay = toDay(stay.arrival);
    const sameSurname = Boolean(askSurname) && askSurname === staySurname;
    const sameArrival = Boolean(askDay && stayDay && askDay === stayDay);

    if (voucherHitsNotes(parsed.ask.voucherNumber, stay.notes)) {
      ranked.push({
        confirmationNumber: stay.confirmationNumber,
        kind: 'match',
        why: 'voucher number in notes',
      });
      continue;
    }
    if (sameSurname && sameArrival) {
      ranked.push({
        confirmationNumber: stay.confirmationNumber,
        kind: 'match',
        why: 'exact surname and arrival',
      });
      continue;
    }
    const off = askDay && stayDay ? dayDelta(askDay, stayDay) : null;
    if (sameSurname && off !== null && Math.abs(off) === 1) {
      ranked.push({
        confirmationNumber: stay.confirmationNumber,
        kind: 'possible',
        why: 'same surname, arrival ±1 day',
      });
      continue;
    }
    if (sameArrival && !sameSurname) {
      ranked.push({
        confirmationNumber: stay.confirmationNumber,
        kind: 'possible',
        why: 'same arrival, different surname',
      });
    }
  }

  const matches = ranked.filter((row) => row.kind === 'match');
  const possibles = ranked.filter((row) => row.kind === 'possible');
  if (matches.length > 1) {
    return { status: 'conflict', confirmationNumber: null, why: ['two matches, never pick'] };
  }
  if (matches.length === 1) {
    const hit = matches[0]!;
    return { status: 'match', confirmationNumber: hit.confirmationNumber, why: [hit.why] };
  }
  if (possibles.length > 0) {
    return {
      status: 'possible',
      confirmationNumber: null,
      why: possibles.map((row) => row.why),
    };
  }
  return { status: 'none', confirmationNumber: null, why: ['no overlap'] };
}
