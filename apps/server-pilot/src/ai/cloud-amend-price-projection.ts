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
export const cloudAmendPreservedSchema = z.object({ cmsRecipient: printable(1000),
  agency: party.nullable(), organization: party.nullable() }).strict();

/** Validate every required retained amount; return only the amounts staff review. */
export function retainedPricesForApproval(input: unknown) {
  const parsed = z.object({ version: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/),
    fields: z.record(z.string(), z.unknown()) }).strict().safeParse(input);
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
  return { version: 1 as const, currency: parsed.data.currency, fields: { averagenightly: nightly, grandtotal: total } };
}

/** Native preimages, source data and other price fields never leave the server. */
export function publicCloudAmendFields(input: unknown) {
  const cloud = z.object({ approvedPrices: z.unknown().optional(), preserved: z.unknown().optional() }).passthrough().safeParse(input);
  const prices = cloud.success ? retainedPricesForApproval(cloud.data.approvedPrices) : null;
  const preserved = cloud.success ? cloudAmendPreservedSchema.safeParse(cloud.data.preserved) : null;
  return { bound: true as const, ...(prices ? { approvedPrices: prices } : {}),
    ...(preserved?.success ? { preserved: { cmsRecipient: preserved.data.cmsRecipient,
      agency: preserved.data.agency?.name ?? null, organization: preserved.data.organization?.name ?? null } } : {}) };
}
