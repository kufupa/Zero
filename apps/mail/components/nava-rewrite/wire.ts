import { z } from 'zod';

// Backend v0 wire contract. Keep snake_case here; native results remain JSON.
export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.string(), z.number().finite(), z.boolean(), z.array(jsonSchema), z.record(jsonSchema),
]));

const savedPriceSchema = z.object({
  currency: z.string().nullable(), totalCents: z.string().nullable(), averageCents: z.string().nullable().optional(),
});
export type SavedPrice = z.infer<typeof savedPriceSchema>;
export const amendReadbackSchema = z.object({
  arrival: z.string().optional(), departure: z.string().optional(),
  price: savedPriceSchema.nullish(), preparedPrice: savedPriceSchema.nullish(), priceInfo: z.string().optional(),
  addonAlignmentChoice: z.string().optional(), nativeWarnings: z.array(z.string()).optional(),
});
export const createReadbackSchema = z.object({
  savedPrice: savedPriceSchema.nullish(), preparedPrice: savedPriceSchema.nullish(), priceInfo: z.string().optional(),
});
export const cancelReadbackSchema = z.object({
  cancellation_fee: z.object({ state: z.string(), text: z.string().nullable() }).optional(), fee_info: z.string().optional(),
  post_save_fee: z.object({ amount: z.string(), currency: z.string().nullable() }).optional(),
});
export const cancelPrepareSchema = z.object({ policy_facts: z.array(z.string()).optional() });

const id = z.string().min(1);
const revision = z.number().int().positive();
export const workflowSchema = z.enum(['triage', 'quote', 'create', 'amend', 'cancel', 'filing']);
export const modeSchema = z.enum(['live', 'labtest', 'historical']);
export const phaseSchema = z.enum(['prefilling', 'ready', 'staging', 'waiting_go', 'saving', 'done', 'uncertain', 'error']);
const addressSchema = z.object({ name: z.string().nullable(), email: z.string() });
export const emailSchema = z.object({
  id, rfc_message_id: z.string().nullable(), direction: z.enum(['inbound', 'outbound']),
  from: addressSchema, to: z.array(addressSchema), cc: z.array(addressSchema),
  received_at: z.string(), subject: z.string(), body_text: z.string(), body_html: z.string().nullable(),
  attachment_status: z.enum(['complete', 'unknown', 'has_unread']).optional(),
  attachments: z.array(z.object({
    id, name: z.string(), mime_type: z.string(), size: z.number().nonnegative(),
    handle: z.string(), extracted_text: z.string().nullable(),
  })),
});
export const threadInputSchema = z.object({
  source: z.enum(['outlook', 'webmail', 'corpus', 'eval']), source_thread_id: id,
  mailbox_id: id, selected_message_id: id, property_code: z.string().nullable(),
  mode: modeSchema, messages: z.array(emailSchema), decision_id: z.string().optional(), input_cutoff: z.string().optional(),
});
const bookingSchema = z.object({
  id, property_code: z.string().nullable(), reservation_id: z.string().nullable(),
  current_state: z.record(jsonSchema).nullable(), fields: z.record(jsonSchema),
});
const actionSchema = z.object({ id, type: z.string(), booking_ids: z.array(id), details: jsonSchema });
export const fieldSpecSchema = z.object({
  path: z.string(), label: z.string(), provenance: z.enum(['ai', 'staff', 'hms', 'default', 'unknown']),
  editable: z.boolean(), required: z.boolean(), error: z.string().nullable(),
  control: z.enum(['text', 'number', 'date', 'checkbox', 'select', 'combobox', 'textarea']),
  options: z.array(z.object({ value: z.string(), label: z.string(), meaning: z.string().nullable() })),
  evidence: z.array(z.object({ message_id: id, attachment_id: z.string().nullable(), quote: z.string().nullable() })),
});
const artifactSchema = z.object({ id, name: z.string(), mime_type: z.string(), url: z.string() });
export const quoteOutputSchema = z.object({organization_name:z.string(),agency_name:z.string(),valid_until:z.string(),payment_terms:z.string(),
  extras:z.array(z.object({description:z.string().trim().min(1),quantity:z.number().int().positive().safe().nullable(),units:z.number().int().positive().safe().nullable(),
    unit_price:z.string().regex(/^\d+(?:\.\d{1,2})?$/).nullable()}))});
const quoteOptionSchema = z.object({
  group_id: id, room_id: id, option_index: z.number().int().nonnegative().safe(),
  room: z.object({ code: id, label: z.string().nullable() }),
  rate: z.object({ code: id, label: z.string().nullable() }),
  meal_plan: jsonSchema,
  nightly: z.array(z.object({
    date: z.string(), price: z.object({ amount: z.string(), currency: z.string() }),
    inventory: z.number().int().nonnegative(), restricted: z.boolean(), rateAvailable: z.boolean(),
  })),
  availability: z.literal('available'), eligibility: z.literal('verified'), match_status: z.string(),
});
const nativeDisplayBase = {
  id, booking_id: z.string().nullable(), label: z.string(), native_path: z.string(),
  quote_id: id.optional(), group_id: id.optional(),
};
export const nativeDisplayRowSchema = z.discriminatedUnion('kind', [
  z.object({ ...nativeDisplayBase, kind: z.literal('text'), value: z.string().nullable() }),
  z.object({ ...nativeDisplayBase, kind: z.literal('code'), code: z.string().nullable(), meaning: z.string().nullable() }),
  z.object({
    ...nativeDisplayBase, kind: z.literal('money'), amount: z.string().nullable(), currency: z.string().nullable(),
    unit: z.enum(['night', 'stay', 'room', 'person']).nullable(), date: z.string().nullable(),
    basis: z.enum(['native', 'calculated']), official: z.boolean(),
  }),
  z.object({
    ...nativeDisplayBase, kind: z.literal('availability'),
    status: z.enum(['available', 'unavailable', 'restricted', 'unknown']), rooms_available: z.number().finite().nullable(),
  }),
]);
export const proposalSchema = z.object({
  workflow: workflowSchema, disposition: z.enum(['propose', 'needs_info', 'decline', 'skip', 'staff_review']),
  reason: z.string().nullable(), bookings: z.array(bookingSchema), actions: z.array(actionSchema),
  field_specs: z.array(fieldSpecSchema), missing: z.array(z.string()), warnings: z.array(z.string()),
  reply_draft: z.string().nullable(), native_result: jsonSchema,
  id, thread_id: id, session_id: id, revision, phase: phaseSchema,
  created_at: z.string(), updated_at: z.string(), display_rows: z.array(nativeDisplayRowSchema),
  staff_attachments_checked: z.boolean().default(false),
  profile_reviews:z.array(z.object({booking_id:id,first_name:z.string(),last_name:z.string(),guest_email:z.string().nullable(),choices:jsonSchema})).default([]),
  profile_outcome:z.object({booking_id:z.string().optional(),native_id:z.string().nullable().optional()}).nullable().default(null),
  quoted_rate_choices:z.array(z.object({
    source_message_id:id, quote_proposal_id:id, quote_revision:revision, quote_id:id, group_id:id, room_id:id,
    arrival_date:z.string(), departure_date:z.string(),
    room:z.object({code:id,label:z.string().nullable()}), rate:z.object({code:id,label:z.string().nullable()}),
  })).optional(),
  stay_target_selected: z.boolean().default(false),
  stage: z.object({
    revision, state: z.string().optional(), job_id: id.optional(), quote_id: id.optional(), quote_options: z.array(quoteOptionSchema).optional(),
    quote_choices: z.array(quoteOptionSchema).optional(), quote_selected_options: z.array(quoteOptionSchema).optional(),
    quote_artifact_block_reason: z.string().nullable().optional(), summary: z.array(z.string()), native_result: jsonSchema,
    display_rows: z.array(nativeDisplayRowSchema), coverage: jsonSchema.optional(),
    observed_fields: jsonSchema.optional(), cancellation_fee: jsonSchema.optional(),
    artifacts: z.array(artifactSchema).optional(),
    quote_output:quoteOutputSchema.optional(),
    quote_sets: z.array(z.object({quote_id:id,job_id:id,state:z.string(),display_rows:z.array(nativeDisplayRowSchema),
      quote_options:z.array(quoteOptionSchema),quote_choices:z.array(quoteOptionSchema),
      quote_selected_options:z.array(quoteOptionSchema),quote_artifact_block_reason:z.string().nullable(),artifacts:z.array(artifactSchema),
      quote_output:quoteOutputSchema.optional()})).optional(),
  }).nullable(),
  result: z.object({
    confirmation: z.string().nullable(), reservation_id: z.string().nullable(),
    readback: jsonSchema, display_rows: z.array(nativeDisplayRowSchema), artifacts: z.array(artifactSchema),
    rooms: z.array(z.object({booking_id:id,state:z.enum(['unattempted','dispatched','saved','failed','uncertain']),confirmation:z.string().nullable(),reservation_id:z.string().nullable(),readback:jsonSchema.optional()})).optional(),
  }).nullable(),
  error: z.object({ code: z.string(), message: z.string(), outcome: z.enum(['known', 'uncertain']), recovery: z.string().nullable() }).nullable(),
});
export const threadSnapshotSchema = z.object({
  id, selected_message_id: id, messages: z.array(emailSchema),
  session: z.object({ id, managed_session_id: z.string().nullable(), status: z.string(), mode: modeSchema, error: jsonSchema }).nullable(),
  proposals: z.array(proposalSchema), event_sequence: z.number().int().nonnegative(),
});
export const capabilitiesSchema = z.object({
  workflows: jsonSchema, tools: jsonSchema, model: z.string(),
  environment_type: z.string(), auth_ready: z.boolean(),
  workflow_capabilities: z.record(z.string(), z.object({
    stage: z.boolean().optional(), quote: z.boolean().optional(), go: z.boolean().optional(), reconcile: z.boolean().optional(),
  })).optional(),
});
export const eventSchema = z.object({
  sequence: z.number().int().nonnegative(), event_id: id, kind: z.string(), at: z.string(),
  session_id: id, proposal_id: z.string().nullable(), payload: jsonSchema,
});
export const acceptedStageSchema = z.object({ proposal_id: id, revision, phase: z.literal('staging'), job_id: id.optional() });
export const acceptedGoSchema = z.object({ proposal_id: id, revision, phase: z.literal('saving') });
export const acceptedQuoteSchema = z.object({ job_id: id, proposal_id: id, revision, quote_id: id, phase: z.literal('staging') });
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: jsonSchema }) });

export type Workflow = z.infer<typeof workflowSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type Email = z.infer<typeof emailSchema>;
export type ThreadInput = z.infer<typeof threadInputSchema>;
export type FieldSpec = z.infer<typeof fieldSpecSchema>;
export type NativeDisplayRow = z.infer<typeof nativeDisplayRowSchema>;
export type QuoteOption = z.infer<typeof quoteOptionSchema>;
export type QuoteSelection = Pick<QuoteOption, 'group_id' | 'room_id' | 'option_index'>;
export type QuoteOutput = z.infer<typeof quoteOutputSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type NavaEvent = z.infer<typeof eventSchema>;
export type AcceptedStage = z.infer<typeof acceptedStageSchema>;
export type AcceptedGo = z.infer<typeof acceptedGoSchema>;
export type AcceptedQuote = z.infer<typeof acceptedQuoteSchema>;
export type Change =
  | { op: 'add' | 'replace'; path: string; value: Json }
  | { op: 'remove'; path: string };
