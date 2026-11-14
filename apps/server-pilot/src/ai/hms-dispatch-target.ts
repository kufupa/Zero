import { z } from 'zod';
import { propertyCodeSchema } from '../hms/property-registry.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';

const guestName = z.string().trim().min(1).max(256).refine((value) => !/[\p{Cc}]/u.test(value));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const confirmation = z.string().trim().regex(/^\d{1,30}-\d{1,10}$/);
const nativeStayId = z.string().trim().regex(/^\d{1,100}$/);

/** A saved target carries the verified native stay ID and its confirmation when available. */
export const hmsDispatchTargetSchema = z.union([
  z.object({ propertyCode: propertyCodeSchema, kind: z.literal('create'),
    firstName: guestName, lastName: guestName, arrival: isoDate }).strict(),
  z.object({ propertyCode: propertyCodeSchema, kind: z.literal('saved'),
    confirmation: confirmation.optional(), nativeStayId: nativeStayId.optional() }).strict()
    .refine((value) => Boolean(value.confirmation || value.nativeStayId)),
]);
export type HmsDispatchTarget = z.input<typeof hmsDispatchTargetSchema>;

const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const decimalKey = (value: string) => value.replace(/^0+(?=\d)/, '');

/** Return every verified alias; a saved stay can have both a confirmation and native ID. */
export function hmsDispatchTargetKeys(input: HmsDispatchTarget): string[] {
  const target = hmsDispatchTargetSchema.parse(input);
  const property = getPropertyRegistration(target.propertyCode);
  if (!property) throw new Error('hms_dispatch_property_invalid');
  const tenantId = property.expectedTenant;
  const partition = target.propertyCode === 'HRCEN' ? [] : [tenantId];
  if (target.kind === 'create') {
    return [JSON.stringify([target.propertyCode, 'create', nameKey(target.firstName), nameKey(target.lastName), target.arrival, ...partition])];
  }
  const keys: string[] = [];
  if (target.confirmation) {
    const [base, suffix] = target.confirmation.split('-');
    keys.push(JSON.stringify([target.propertyCode, 'saved', `${decimalKey(base!)}-${decimalKey(suffix!)}`, ...partition]));
  }
  if (target.nativeStayId) keys.push(JSON.stringify([target.propertyCode, 'saved_native', decimalKey(target.nativeStayId), ...partition]));
  return keys;
}

/** Session locks use native identity whenever present; durable locks use all aliases. */
export function hmsDispatchTargetKey(input: HmsDispatchTarget): string {
  const keys = hmsDispatchTargetKeys(input);
  return keys[keys.length - 1]!;
}

/** Fallback for legacy rows that contain no attributable booking identity. */
export function hmsDispatchWorkItemKey(workItemId: string): string {
  return JSON.stringify(['HRCEN', 'work_item', workItemId.toLowerCase()]);
}
