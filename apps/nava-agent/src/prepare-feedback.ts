import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,79}$/);
const labels = new Map([
  ['guest', 'guest profile'], ['stay.arrival', 'arrival date'], ['stay.departure', 'departure date'],
  ['stay.dateRange', 'stay dates'], ['stay.adults', 'adult count'], ['stay.childAges', 'child ages'],
  ['stay.childCount', 'child count'], ['room.roomType', 'room type'], ['room.roomTypeForCharge', 'charged room type'],
  ['room.ratePlan', 'rate plan'], ['room.ratePlanCriteria', 'rate plan'], ['room.rateAvailability', 'rate availability'],
  ['guaranteeType', 'guarantee type'], ['guaranteeType.staging', 'guarantee type'], ['sourceOfBusiness', 'booking source'],
]);
const messages = new Map([
  ['guest_ambiguous', 'More than one Infor guest profile matched. Select the correct profile.'],
  ['guest_choice_required', 'Select a guest profile before preparing again.'],
  ['guest_not_found', 'Infor could not find the guest profile. Verify the guest in Infor.'],
  ['guest_email_unverified', 'Infor could not verify the guest email against the selected profile.'],
  ['room_type_not_unique', 'Infor could not confirm the selected room type. Check the room code.'],
  ['CURRENT_RATE_CODE_UNVERIFIED', 'Infor did not confirm this rate code for the selected stay.'],
  ['RATE_SHOP_CRITERIA_UNAVAILABLE', 'Infor could not confirm the rate for these stay details. Check the rate code.'],
  ['RATE_PRICE_UNCONFIRMED', 'Infor could not confirm the price for this rate.'],
  ['RATE_AVAILABILITY_UNVERIFIED', 'Infor could not verify availability for this rate.'],
  ['rate_availability_unverified', 'Infor could not verify availability for this rate.'],
  ['HMS_BROWSER_HOLD', 'Infor is still holding a session for this guest and arrival. Wait for it to close before preparing again.'],
  ['INVALID_CREATE_TARGET', 'Check the guest first name, last name, and arrival date.'],
]);
const optionalIdentifier = identifier.optional().catch(undefined);
const nativeRejection = z.object({
  issue: optionalIdentifier, field: optionalIdentifier, missing: z.array(identifier).catch([]),
  ratePlanIssue: z.object({ issue: optionalIdentifier }).optional().catch(undefined),
});
export const prepareRejection = z.object({ issues: z.array(identifier).max(2), fields: z.array(identifier).max(12) }).strict();
type PrepareRejection = z.infer<typeof prepareRejection>;

export function readPrepareRejection(data: unknown, code: string | undefined): PrepareRejection {
  const result = z.object({ native: nativeRejection.optional() }).safeParse(data);
  const native = result.success ? result.data.native : undefined;
  const issues = [native?.issue, native?.ratePlanIssue?.issue].filter((issue): issue is string => issue !== undefined);
  if (!issues.length && code && messages.has(code)) issues.push(code);
  const fields = [native?.field, ...(native?.missing ?? [])].filter((field): field is string => field !== undefined);
  return { issues: [...new Set(issues)], fields: [...new Set(fields)].slice(0, 12) };
}

export function describePrepareRejection({ issues, fields }: PrepareRejection): string {
  const reasons = issues.map(issue => messages.get(issue) ?? `Infor rejected Prepare (${issue}).`);
  if (fields.length) reasons.push(`Check: ${[...new Set(fields.map(field => labels.get(field) ?? field))].join(', ')}.`);
  return reasons.join(' ') || 'HMS Prepare did not complete.';
}
