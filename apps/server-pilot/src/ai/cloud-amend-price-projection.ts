import { createHash } from 'node:crypto';
import { z } from 'zod';

const REQUIRED = ['averagenightly', 'averagerate', 'grandtotal', 'totalrate', 'totalratewithtax',
  'guesttotal', 'tax', 'guesttax'] as const;
const amount = z.object({ state: z.literal('amount'), cents: z.string().regex(/^(?:0|[1-9]\d{0,11})$/) }).strict();
const currency = z.object({ state: z.literal('currency'), code: z.string().regex(/^[A-Z]{3}$/) }).strict();
const price = z.object({ data: amount, visible: amount, dataCurrency: currency, visibleCurrency: currency }).strict();
const printable = (max: number) => z.string().max(max).refine((value) => !/[\p{Cc}]/u.test(value));
const party = z.object({ nativeId: z.string().regex(/^\d{1,30}$/),
  name: printable(300).refine((value) => Boolean(value.trim())) }).strict();
/** Values sent unchanged by the complete native saved-record form. */
export const cloudAmendPreservedSchema = z.object({ cmsRecipient: printable(1000), cmsMessageId: printable(1000).optional(),
  cmsSend: z.boolean().optional(), guestEmail: printable(1000).optional(), bookerName: printable(1000).optional(),
  bookerContact: printable(1000).optional(), bookingAgency: party.nullable(), organization: party.nullable() }).strict();

const cents = z.string().regex(/^(?:0|[1-9]\d{0,13})$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const consecutive = (rows: Array<{ date: string }>) => rows.every((row, index) => index === 0 ||
  Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${rows[index - 1]!.date}T00:00:00Z`) === 86_400_000);
const savedNight = z.object({ date: day, chargeCents: cents, totalChargeCents: cents }).strict();
const quotedNight = z.object({ date: day, quoteCents: cents }).strict();
const totals = z.object({ subtotalCents: cents, taxCents: cents, feeCents: cents, totalCents: cents }).strict();
const nonemptyName = z.string().refine((value) => Boolean(value.trim()));
const nativeNight = savedNight.extend({ roomTypeName: nonemptyName, ratePlanName: nonemptyName }).strict();
const nativeRetained = z.object({ version: z.literal(1), propertyCode: z.literal('HRCEN'),
  nativeStayId: z.string().regex(/^\d{1,100}$/), currency: z.string().regex(/^[A-Z]{3}$/),
  nightly: z.array(nativeNight).min(1).refine(consecutive), totals }).strict();

// Match nativePriceDigest in saved-stay-nightly-rates.mjs without importing browser tooling into the server route.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) =>
    [key, canonical((value as Record<string, unknown>)[key])])) : value;
const nativeDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const rateOption = z.object({ ratePlan: z.string().min(1), roomType: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/), nightly: z.array(z.object({ date: day, amountCents: cents }).strict()).min(1) }).strict();
export const repricedAmendSchema = z.object({ version: z.literal(2), currency: z.string().regex(/^[A-Z]{3}$/),
  totalCents: cents, averageCents: cents.nullable(), options: z.array(rateOption).max(100) }).strict();

/** Return only native price observations staff can review. */
export function retainedPricesForApproval(input: unknown) {
  const repriced = repricedAmendSchema.safeParse(input);
  if (repriced.success) return repriced.data;
  const parsed = z.object({ version: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/),
    fields: z.record(z.string(), z.unknown()), nightlyPrices: z.object({
      saved: z.array(savedNight).min(1).refine(consecutive),
      proposed: z.array(quotedNight).min(1).refine(consecutive),
      retained: z.array(savedNight).min(1).refine(consecutive).optional(),
    }).strict(), totals: z.object({ saved: totals, quoteNightlySumCents: cents, retained: totals.optional() }).strict(),
    nativeRetained, nativeRetainedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).passthrough().safeParse(input);
  if (!parsed.success) return null;
  let nightly: z.infer<typeof price> | null = null;
  let total: z.infer<typeof price> | null = null;
  for (const key of REQUIRED) {
    const field = price.safeParse(parsed.data.fields[key]);
    if (!field.success || field.data.data.cents !== field.data.visible.cents ||
        field.data.dataCurrency.code !== parsed.data.currency || field.data.visibleCurrency.code !== parsed.data.currency) return null;
    if (key === 'averagenightly') nightly = field.data;
    if (key === 'grandtotal') total = field.data;
  }
  if (!nightly || !total) return null;
  const savedTotals = parsed.data.totals.saved, native = parsed.data.nativeRetained;
  const retained = native.nightly.map(({ date, chargeCents, totalChargeCents }) => ({ date, chargeCents, totalChargeCents }));
  const mirror = parsed.data.nightlyPrices.retained, mirrorTotals = parsed.data.totals.retained;
  const totalKeys = ['subtotalCents', 'taxCents', 'feeCents', 'totalCents'] as const;
  if (parsed.data.nightlyPrices.saved.reduce((sum, row) => sum + BigInt(row.totalChargeCents), 0n).toString() !== savedTotals.subtotalCents ||
      BigInt(savedTotals.subtotalCents) + BigInt(savedTotals.taxCents) + BigInt(savedTotals.feeCents) !== BigInt(savedTotals.totalCents) ||
      total.data.cents !== savedTotals.totalCents || parsed.data.nightlyPrices.proposed.reduce((sum, row) => sum + BigInt(row.quoteCents), 0n).toString() !==
        parsed.data.totals.quoteNightlySumCents || native.currency !== parsed.data.currency ||
      nativeDigest(native) !== parsed.data.nativeRetainedDigest || retained.length !== parsed.data.nightlyPrices.proposed.length ||
      retained.some((row, index) => row.date !== parsed.data.nightlyPrices.proposed[index]!.date) ||
      retained.reduce((sum, row) => sum + BigInt(row.totalChargeCents), 0n).toString() !== native.totals.subtotalCents ||
      BigInt(native.totals.subtotalCents) + BigInt(native.totals.taxCents) + BigInt(native.totals.feeCents) !== BigInt(native.totals.totalCents) ||
      (mirror && (mirror.length !== retained.length || mirror.some((row, index) => {
        const actual = retained[index]!;
        return row.date !== actual.date || row.chargeCents !== actual.chargeCents || row.totalChargeCents !== actual.totalChargeCents;
      }))) || (mirrorTotals && totalKeys.some((key) => mirrorTotals[key] !== native.totals[key]))) return null;
  return { version: 1 as const, currency: parsed.data.currency, fields: { averagenightly: nightly, grandtotal: total },
    nightlyPrices: { saved: parsed.data.nightlyPrices.saved, proposed: parsed.data.nightlyPrices.proposed, retained },
    totals: { saved: savedTotals, quoteNightlySumCents: parsed.data.totals.quoteNightlySumCents, retained: native.totals } };
}

/** Native preimages, source data and other price fields never leave the server. */
export function publicCloudAmendFields(input: unknown) {
  const cloud = z.object({ approvedPrices: z.unknown().optional(), preserved: z.unknown().optional() }).passthrough().safeParse(input);
  const prices = cloud.success ? retainedPricesForApproval(cloud.data.approvedPrices) : null;
  const preserved = cloud.success ? cloudAmendPreservedSchema.safeParse(cloud.data.preserved) : null;
  return { bound: true as const, ...(prices ? { approvedPrices: prices } : {}),
    ...(preserved?.success ? { preserved: { cmsRecipient: preserved.data.cmsRecipient,
      cmsMessageId: preserved.data.cmsMessageId, cmsSend: preserved.data.cmsSend,
      bookingAgency: preserved.data.bookingAgency?.name ?? null, organization: preserved.data.organization?.name ?? null } } : {}) };
}
