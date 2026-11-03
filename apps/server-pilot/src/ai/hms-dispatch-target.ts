import { z } from 'zod';

const guestName = z.string().trim().min(1).max(256).refine((value) => !/[\p{Cc}]/u.test(value));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const confirmation = z.string().trim().regex(/^\d{1,30}-\d{1,10}$/);
const nativeStayId = z.string().trim().regex(/^\d{1,100}$/);

/** The saved-stay confirmation is preferred whenever it exists. */
export const hmsDispatchTargetSchema = z.union([
  z.object({ propertyCode: z.literal('HRCEN'), kind: z.literal('create'),
    firstName: guestName, lastName: guestName, arrival: isoDate }).strict(),
  z.object({ propertyCode: z.literal('HRCEN'), kind: z.literal('saved'),
    confirmation: confirmation.optional(), nativeStayId: nativeStayId.optional() }).strict()
    .refine((value) => Boolean(value.confirmation || value.nativeStayId)),
]);
export type HmsDispatchTarget = z.input<typeof hmsDispatchTargetSchema>;

const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const decimalKey = (value: string) => value.replace(/^0+(?=\d)/, '');

/** Stable keys are shared by the durable hold, preimage session and recovery session. */
export function hmsDispatchTargetKey(input: HmsDispatchTarget): string {
  const target = hmsDispatchTargetSchema.parse(input);
  if (target.kind === 'create') {
    return JSON.stringify([target.propertyCode, 'create', nameKey(target.firstName), nameKey(target.lastName), target.arrival]);
  }
  if (target.confirmation) {
    const [base, suffix] = target.confirmation.split('-');
    return JSON.stringify([target.propertyCode, 'saved', `${decimalKey(base!)}-${decimalKey(suffix!)}`]);
  }
  return JSON.stringify([target.propertyCode, 'saved_native', decimalKey(target.nativeStayId!)]);
}

/** Fallback for legacy rows that contain no attributable booking identity. */
export function hmsDispatchWorkItemKey(workItemId: string): string {
  return JSON.stringify(['HRCEN', 'work_item', workItemId.toLowerCase()]);
}
