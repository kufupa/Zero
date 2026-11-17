import { z } from 'zod';
import { propertySwitchSchema } from '../hms/property-switch.js';

const groupSchema = z
  .object({
    id: z.string().min(1).max(64),
    arrivalDate: z.string(),
    departureDate: z.string(),
    quantity: z.number().int().min(1).max(100),
    adults: z.number().int().min(1).max(6),
    childrenAges: z.array(z.number().int().min(0).max(17)).max(6).default([]),
    mealPlan: z.enum(['room_only', 'bb', 'dinner_bb']),
    roomCodes: z
      .array(z.string().regex(/^[A-Z0-9_-]{1,16}$/))
      .min(1)
      .max(8)
      .optional(),
    // The rate card the staff pinned, re-run with exactly this HMS rate code. A contract code prices only with its verified party.
    rateCode: z.string().regex(/^[A-Z0-9_-]{1,16}$/).optional(),
  })
  .strict();
/** How an "other" charge multiplies: per guest per night, per guest, per trip, or once as an item. */
export const OTHER_CHARGE_UNITS = ['per_person_night', 'per_person', 'per_trip', 'item'] as const;
export type OtherChargeUnit = (typeof OTHER_CHARGE_UNITS)[number];
const staffLabel = z.string().trim().max(120);
/** Largest accepted amount for one extra unit: R1,000,000 in cents. Keeps every total far from unsafe integers. */
export const MAX_EXTRA_AMOUNT_MINOR = 100_000_000;
const extraAmount = z.number().int().positive().max(MAX_EXTRA_AMOUNT_MINOR);
/**
 * Staff row prices (KTD6). A row with no entry is priced by HMS. A saved rate is named by id only: the server reads its name
 * and amount. An override needs its rate code, its per-night rate and a note saying who approved it and why.
 */
export const staffRowPriceInput = z.discriminatedUnion('source', [
  z
    .object({ groupId: z.string().min(1).max(64), source: z.literal('saved'), customRateId: z.string().uuid() })
    .strict(),
  z
    .object({ groupId: z.string().min(1).max(64), source: z.literal('one_off'), oneOffRate: extraAmount })
    .strict(),
  z
    .object({
      groupId: z.string().min(1).max(64),
      source: z.literal('override'),
      rateCode: z.string().regex(/^[A-Z0-9_-]{1,16}$/),
      overrideRate: extraAmount,
      note: z.string().trim().min(1, 'The override needs a note: who approved it and why').max(500),
    })
    .strict(),
]);
export type StaffRowPriceInput = z.infer<typeof staffRowPriceInput>;
/** Prices, native party IDs and qualification flags are deliberately not client inputs. */
/** The HMS id a picked party carries: plain characters, as HMS shows them. */
const partyNativeId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const pickedOrganization = z
  .object({ kind: z.literal('organization'), nativeId: partyNativeId, name: z.string().min(1).max(256) })
  .strict();
const pickedBookingAgency = z
  .object({ kind: z.literal('bookingAgency'), nativeId: partyNativeId, name: z.string().min(1).max(256) })
  .strict();
/**
 * The company and agency staff picked with Find in HMS. Both may be picked on one quote. The server re-checks each
 * one in HMS before any rate is bound to it (verifyPartyPick), so a client-sent id is never trusted on its own.
 */
export const staffQuoteParties = z
  .object({ organization: pickedOrganization.optional(), bookingAgency: pickedBookingAgency.optional() })
  .strict();
export type StaffQuoteParties = z.infer<typeof staffQuoteParties>;

export const staffQuoteInput = z
  .object({
    messageId: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    propertySwitch: propertySwitchSchema.optional(),
    selectionEpoch: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    groups: z.array(groupSchema).min(1).max(8),
    salesStrategy: z.enum(['BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER', 'Government']).default('BAR'),
    organization: z.string().max(256).default(''),
    bookingAgency: z.string().max(256).default(''),
    attention: z.string().max(256).default(''),
    clientEmail: z.string().max(256).default(''),
    clientTelephone: z.string().max(128).default(''),
    // Staff-typed extras. Every amount is ZAR minor units and must be positive; absent means not charged.
    dinnerAllowanceMinor: extraAmount.optional(),
    dinnerAllowanceLabel: staffLabel.optional(),
    dinnerAllowanceUnit: z.enum(['per_person_per_night', 'per_room_per_night', 'per_person']).optional(),
    // Staff-approved dinner charge scope. Omitted on a manual dinner charge means every group.
    dinnerAllowanceGroupIds: z.array(z.string().min(1).max(64)).max(8).optional(),
    extras: z.array(z.object({
      id: z.string().min(1).max(80),
      service: z.enum(['lunch_allowance', 'shuttle', 'office_transfer']),
      amountMinor: extraAmount,
      unit: z.enum(['per_person_night', 'per_person', 'per_room_per_night', 'per_trip', 'item']),
      groupIds: z.array(z.string().min(1).max(64)).min(1).max(8),
    }).strict()).max(100).optional(),
    lunchAllowanceMinor: extraAmount.optional(),
    lunchAllowanceLabel: staffLabel.optional(),
    officeTransferMinor: extraAmount.optional(),
    officeTransferDays: z.number().int().min(1).max(31).optional(),
    shuttleRequested: z.boolean().optional(),
    shuttleMinor: extraAmount.optional(),
    shuttleTrips: z.number().int().min(1).max(50).optional(),
    other: z
      .object({
        // A blank label is kept, not rejected: the amount then raises a review item instead of vanishing.
        label: z.string().trim().max(120).default(''),
        amountMinor: extraAmount,
        unit: z.enum(OTHER_CHARGE_UNITS),
      })
      .strict()
      .optional(),
    /** Unpriced staff note, printed on the quotation as a note. */
    notes: z.string().trim().max(1000).optional(),
    // The HMS company and/or agency the pane's Find in HMS picker chose. Absent means public rates, as before.
    parties: staffQuoteParties.optional(),
    // Row prices staff chose instead of HMS's nightly rate. Part of the approved input digest, so an approval binds them.
    rowPrices: z.array(staffRowPriceInput).max(8).optional(),
    /** All-room BAR search sends 200. A pinned room type keeps the default 50. */
    maxOptionsPerGroup: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type StaffQuoteInput = z.infer<typeof staffQuoteInput>;
