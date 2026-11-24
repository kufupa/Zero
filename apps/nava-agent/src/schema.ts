import { z } from 'zod';
import { isEmptyQuoteGroup, quoteInput as nativeGroupedQuote, type QuoteInput } from '../tools/quote/schema.js';
import { hrcenCode, normalizeQuoteActionDetails } from './proposal-fields.js';
import { CENTURION_RATE_CATALOGUE } from '../../server-pilot/src/hms/centurion-rate-catalogue.js';

const id = z.string();
const json: z.ZodType<null | boolean | number | string | unknown[] | Record<string, unknown>> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(json)]));
const person = z.object({name:z.string().nullable(),email:z.string()}).strict();
const attachment = z.object({id, name:z.string(), mime_type:z.string(), size:z.number().int().nonnegative(), handle:z.string(), extracted_text:z.string().nullable()}).strict();
const email = z.object({id, rfc_message_id:z.string().nullable(), direction:z.enum(['inbound','outbound']), from:person, to:z.array(person), cc:z.array(person), received_at:z.string().datetime({offset:true}), subject:z.string(), body_text:z.string(), body_html:z.string().nullable(), attachment_status:z.enum(['complete','unknown','has_unread']).optional(), attachments:z.array(attachment)}).strict();
/** Optional server-attested enrichment; arbitrary client packets are rejected at import. */
const requestTimeContext = z.unknown().optional();
export const threadInput = z.object({source:z.enum(['outlook','webmail','corpus','eval']), source_thread_id:id, mailbox_id:id, selected_message_id:id, property_code:z.string().nullable(), mode:z.enum(['live','labtest','historical']), messages:z.array(email).min(1), decision_id:z.string().optional(), input_cutoff:z.string().optional(), replay_id:z.string().uuid().optional(), request_time_context:requestTimeContext}).strict().superRefine((v,ctx)=>{
  if(!v.messages.some(m=>m.id===v.selected_message_id)) ctx.addIssue({code:z.ZodIssueCode.custom,message:'selected message missing'});
  if(v.replay_id) {
    const cutoff=Date.parse(v.input_cutoff ?? '');
    const selected=v.messages.find(m=>m.id===v.selected_message_id);
    if(v.mode!=='live' || v.source!=='outlook' || selected?.direction!=='inbound' ||
        cutoff!==Date.parse(selected.received_at) || v.messages.some(m=>Date.parse(m.received_at)>cutoff)) {
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'live replay requires the exact selected inbound cutoff'});
    }
  }
  if(v.mode==='historical') {
    const cutoff=v.input_cutoff ? Date.parse(v.input_cutoff) : NaN;
    if(!Number.isFinite(cutoff)) ctx.addIssue({code:z.ZodIssueCode.custom,message:'historical input_cutoff required'});
    else if(v.messages.some(message=>Date.parse(message.received_at)>cutoff)) ctx.addIssue({code:z.ZodIssueCode.custom,message:'message after historical input_cutoff'});
  }
});
const booking = z.object({id, property_code:z.string().nullable(), reservation_id:z.string().nullable(), current_state:z.record(json).nullable(), fields:z.record(json)}).strict();
const action = z.object({id, type:id, booking_ids:z.array(id), details:json}).strict();
const modelFieldProvenance = ['ai','hms','default','unknown'] as const;
const fieldSpec = z.object({path:id,label:z.string(),provenance:z.enum([...modelFieldProvenance,'staff']),editable:z.boolean(),required:z.boolean(),error:z.string().nullable(),control:z.enum(['text','number','date','checkbox','select','combobox','textarea']),options:z.array(z.object({value:z.string(),label:z.string(),meaning:z.string().nullable()}).strict()),evidence:z.array(z.object({message_id:id,attachment_id:z.string().nullable(),quote:z.string().nullable()}).strict())}).strict();
export const proposalDraft = z.object({workflow:z.enum(['triage','quote','create','amend','cancel','filing']),disposition:z.enum(['propose','needs_info','decline','skip','staff_review']),reason:z.string().nullable(),bookings:z.array(booking),actions:z.array(action),field_specs:z.array(fieldSpec),missing:z.array(z.string()),warnings:z.array(z.string()),reply_draft:z.string().nullable(),native_result:json}).strict();
const proposalPublishInput = proposalDraft.transform(draft=>({...draft,
  field_specs:draft.field_specs.map(field=>field.provenance==='staff'?{...field,provenance:'ai' as const}:field),
}));
export const quoteInput = z.object({property_code:id,arrival_date:id,departure_date:id,rooms:z.array(z.object({id,quantity:z.number().int().min(1),adults:z.number().int().min(1),children:z.number().int().min(0),child_ages:z.array(z.number().int().min(0))}).strict()).min(1),search:z.record(z.unknown()).optional(),details:z.enum(['summary','full']).optional(),max_options_per_group:z.number().int().min(1).optional()}).strict();
export const replyInput = z.object({proposal_id:id,text:z.string()}).strict();
export const emptyInput = z.object({}).strict();
export const skillInput = z.object({skill_name:z.enum(['triage','quote','create','amend','cancel','filing']),path:z.string().optional()}).strict();
export const schemas = {skill_read:skillInput,mail_read_thread:emptyInput,hms_quote:quoteInput,proposal_publish:proposalPublishInput,reply_draft:replyInput};
export type ThreadInput = z.infer<typeof threadInput>;
export type ProposalDraft = z.infer<typeof proposalDraft>;
export const revisionInput = z.object({expected_revision:z.number().int().min(1)}).strict();
const operationKey = revisionInput.extend({idempotency_key:z.string().trim().min(1).max(256)});
export const goInput = operationKey.extend({prepared_job_id:id.optional()}).strict();
export const requoteInput = operationKey.extend({quote_id:z.string().min(1)}).strict();
const calendarDate = z.string().date();
const nativeGroup = nativeGroupedQuote.shape.groups.element;
const board = z.string().nullish().catch(null);
const partyField = z.string().trim().min(1).nullish().catch(null);
export const groupedQuoteRequest = z.preprocess(normalizeQuoteActionDetails, nativeGroupedQuote.strip().extend({
  board, organization_id:partyField, organization_name:partyField, agency_id:partyField, agency_name:partyField,
  party_name:nativeGroupedQuote.shape.party_name.nullish().catch(null),
  groups:z.preprocess(value=>Array.isArray(value) ? value.filter(group=>!isEmptyQuoteGroup(group)) : value,
    z.array(nativeGroup.strip().extend({board,rooms:z.array(nativeGroup.shape.rooms.element.strip().extend({
      board,room_type:partyField,rate_preference:partyField,
    })).min(1)})).min(1)),
})
  .refine(quote=>new Set(quote.groups.map(group=>group.group_id)).size===quote.groups.length,{message:'group ids must be unique'})
  .refine(({groups})=>groups.every(group=>calendarDate.safeParse(group.arrival_date).success
    && calendarDate.safeParse(group.departure_date).success && group.departure_date>group.arrival_date),{message:'departure must follow arrival'})
  .transform(({board,organization_id,organization_name,agency_id,agency_name,party_name,groups,...quote}):QuoteInput=>({
    ...quote,...(party_name ? {party_name} : {}),
    ...(organization_id && organization_name || agency_id && agency_name ? {rate_context:{
      ...(organization_id && organization_name ? {organization:{nativeId:organization_id,name:organization_name}} : {}),
      ...(agency_id && agency_name ? {bookingAgency:{nativeId:agency_id,name:agency_name}} : {}),
    }} : {}),
    groups:groups.map(({board:groupBoard,rooms,...group})=>({...group,rooms:rooms.map(({board:roomBoard,room_type,rate_preference,...room})=>{
      const meal=roomBoard ?? groupBoard ?? board;
      const hrcen=quote.property_code==='HRCEN';
      const roomCode=hrcen ? hrcenCode('room_type',room_type,meal) : null;
      const roomCodes=hrcen && room_type && /^(?:STQN|STWN|SKNG|DLXQN|DLXTWN|DLXKNG|EXKNG|LUXKNG|SUITE)$/.test(room_type)
        ? [room_type] : /^(?:standard|deluxe)(?: room)?$/i.test(room_type ?? '') && roomCode
          ? (roomCode.startsWith('DLX')?['DLXQN','DLXTWN','DLXKNG']:['STQN','STWN','SKNG']) : roomCode ? [roomCode] : [];
      const rateCode=hrcen ? hrcenCode('rate_plan',rate_preference,meal) ??
        (rate_preference && Object.hasOwn(CENTURION_RATE_CATALOGUE,rate_preference) ? rate_preference : null) : null;
      // Government rates need an organization bind; bare NGOV* filters crash Hotel Availability.
      const bindRate=rateCode && (!rateCode.startsWith('NGOV') || organization_id);
      const bases=room.required?.mealPlanBases;
      const roomOnly=meal && /^(?:ro|room only|room_only)$/i.test(meal);
      const breakfast=!meal || /\b(?:bb|dbb|breakfast|dinner)\b/i.test(meal) || /^b&b$/i.test(meal);
      const dinner=(basis:string)=>/^(?:dbb|dinner_bed_breakfast|dinner[, ]+bed)/i.test(basis);
      return {...room,required:{...room.required,
        ...(!room.required?.roomCodes?.length && roomCodes.length ? {roomCodes} : {}),
        ...(!room.required?.rateCodes?.length && bindRate ? {rateCodes:[rateCode]} : {}),
        ...(roomOnly ? {mealPlanBases:['room_only']} : bases?.length ? {mealPlanBases:bases.map(basis=>dinner(basis)?'breakfast':basis)} :
          breakfast ? {mealPlanBases:['breakfast']} : {}),
      }};
    })})),
  })));
export type Workflow = ProposalDraft['workflow'];
const S={type:'string'};
const J={};
const nullable=(schema:object)=>({anyOf:[schema,{type:'null'}]});
const array=(items:object)=>({type:'array',items});
const object=(properties:Record<string,object>,required:string[])=>({type:'object' as const,properties,required,additionalProperties:false});
const bookingSchema=object({id:S,property_code:nullable(S),reservation_id:nullable(S),current_state:nullable({type:'object',additionalProperties:J}),fields:{type:'object',additionalProperties:J}},['id','property_code','reservation_id','current_state','fields']);
const actionSchema=object({id:S,type:S,booking_ids:array(S),details:J},['id','type','booking_ids','details']);
const optionSchema=object({value:S,label:S,meaning:nullable(S)},['value','label','meaning']);
const evidenceSchema=object({message_id:S,attachment_id:nullable(S),quote:nullable(S)},['message_id','attachment_id','quote']);
const fieldSchema=object({path:S,label:S,provenance:{type:'string',enum:modelFieldProvenance},editable:{type:'boolean'},required:{type:'boolean'},error:nullable(S),control:{type:'string',enum:['text','number','date','checkbox','select','combobox','textarea']},options:array(optionSchema),evidence:array(evidenceSchema)},['path','label','provenance','editable','required','error','control','options','evidence']);
const proposalSchema=object({workflow:{type:'string',enum:['triage','quote','create','amend','cancel','filing']},disposition:{type:'string',enum:['propose','needs_info','decline','skip','staff_review']},reason:nullable(S),bookings:array(bookingSchema),actions:array(actionSchema),field_specs:array(fieldSchema),missing:array(S),warnings:array(S),reply_draft:nullable(S),native_result:J},['workflow','disposition','reason','bookings','actions','field_specs','missing','warnings','reply_draft','native_result']);
const roomSchema=object({id:S,quantity:{type:'integer',minimum:1},adults:{type:'integer',minimum:1},children:{type:'integer',minimum:0},child_ages:array({type:'integer',minimum:0})},['id','quantity','adults','children','child_ages']);
const quoteSchema=object({property_code:S,arrival_date:S,departure_date:S,rooms:{type:'array',minItems:1,items:roomSchema},search:{type:'object'},details:{type:'string',enum:['summary','full']},max_options_per_group:{type:'integer',minimum:1}},['property_code','arrival_date','departure_date','rooms']);
export const tools=[
  {type:'custom' as const,name:'skill_read',description:'Read a pinned skill or its relative Markdown reference.',input_schema:object({skill_name:{type:'string',enum:['triage','quote','create','amend','cancel','filing']},path:S},['skill_name'])},
  {type:'custom' as const,name:'mail_read_thread',description:'Read this thread and its supplied messages.',input_schema:object({},[])},
  {type:'custom' as const,name:'hms_quote',description:'Read native HMS availability and prices; never book.',input_schema:quoteSchema},
  {type:'custom' as const,name:'proposal_publish',description:'Persist proposal for staff review.',input_schema:proposalSchema},
  {type:'custom' as const,name:'reply_draft',description:'Save draft text; never send.',input_schema:object({proposal_id:S,text:S},['proposal_id','text'])},
];
