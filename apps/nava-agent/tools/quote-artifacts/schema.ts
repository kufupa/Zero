import { z } from 'zod';

export const input = z.object({ quote_id: z.string().min(1) }).strict();
export const manifest = {
  name: 'quote_artifacts',
  description: 'Generate a signable quotation PDF and editable workbook for an authorized published quote.',
  input_schema: {
    type: 'object' as const,
    properties: { quote_id: { type: 'string' } },
    required: ['quote_id'],
    additionalProperties: false,
  },
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const id = z.string().min(1);
export const quoteOutput = z.object({
  organization_name:z.string(), agency_name:z.string(), valid_until:z.string(), payment_terms:z.string(),
  extras:z.array(z.object({description:z.string().trim().min(1), quantity:z.number().int().positive().safe().nullable(),
    units:z.number().int().positive().safe().nullable(), unit_price:z.string().regex(/^\d+(?:\.\d{1,2})?$/).nullable()}).strict()),
}).strict();
export type QuoteOutput = z.infer<typeof quoteOutput>;
const room = z.object({ id, quantity: z.number().int().positive().safe(), adults: z.number().int().positive(),
  children: z.number().int().nonnegative(), child_ages: z.array(z.number().int().nonnegative()) }).passthrough();
const group = z.object({ group_id: id, arrival_date: date, departure_date: date, rooms: z.array(room).min(1) }).passthrough();
const option = z.object({
  availability: z.literal('available'), eligibility: z.literal('verified'), matchStatus: z.enum(['match', 'alternative']),
  rateScope: z.string().optional(),
  room: z.object({ code: id, label: z.string().nullable().optional() }).passthrough(),
  rate: z.object({ code: id, label: z.string().nullable().optional() }).passthrough(),
  mealPlan: z.union([z.string(), z.object({ code: z.string().nullable().optional(), label: z.string().nullable().optional() }).passthrough(), z.null()]).optional(),
  nightly: z.array(z.object({ date, price: z.object({ amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/), currency: z.literal('ZAR') }),
    inventory: z.number().int().nonnegative(), restricted: z.literal(false), rateAvailable: z.literal(true) }).passthrough()).min(1),
}).passthrough();
const capturedRoom = z.object({ room_id: id, native_result: z.object({
  request: z.object({ quantity: z.number().int().positive(), adults: z.number().int().positive(), children: z.number().int().nonnegative(), childAges: z.array(z.number().int().nonnegative()),
    required: z.object({roomCodes:z.array(id).optional(),rateCodes:z.array(id).optional()}).passthrough().optional() }).passthrough(),
  options: z.array(z.unknown()),
}).passthrough().nullable() }).passthrough();
const capturedGroup = z.object({ group_id: id, arrival_date: date, departure_date: date, status: z.string(),
  rooms: z.array(capturedRoom).min(1) }).passthrough();

// Snapshot is provided only by the server's authorization and revision resolver.
export const snapshot = z.object({
  quote_id: id, proposal_id: id, revision: z.number().int().positive().safe(), property_code: id,
  authored_date: date, file_prefix: z.string().regex(/^Quotation(?: [1-9][0-9]*)?$/).optional(),
  header: z.object({ attention: z.string(), organization: z.string(), clientEmail: z.string(), clientTelephone: z.string(),
    signerName: z.string(), signerEmail: z.string(), displayBookingAgency: z.string().optional() }).strict(),
  note: z.string().optional(),
  output: quoteOutput.default({organization_name:'',agency_name:'',valid_until:'',payment_terms:'',extras:[]}),
  groups: z.array(group).min(1),
  capture: z.object({ quote_id: id, property_code: id, group_order: z.array(id), groups: z.record(capturedGroup) }).passthrough(),
  selections: z.array(z.object({ group_id: id, room_id: id, option_index: z.number().int().nonnegative().safe() }).strict()).min(1),
}).strict();
export { option };
