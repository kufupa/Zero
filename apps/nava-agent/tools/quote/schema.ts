import { z } from 'zod';

const id = z.string().trim().min(1);
const constraints = z.object({
  roomCodes: z.array(id).optional(), rateCodes: z.array(id).optional(),
  bedTypes: z.array(id).optional(), mealPlanBases: z.array(id).optional(),
  features: z.array(z.object({ name: id, value: id }).strict()).optional(),
}).strict().transform(value=>Object.fromEntries(Object.entries(value).filter(([,items])=>Array.isArray(items) && items.length>0)) as typeof value);
const room = z.object({
  id, quantity: z.number().int().min(1), adults: z.number().int().min(1),
  children: z.number().int().min(0), child_ages: z.array(z.number().int().min(0).max(99)),
  required: constraints.optional(), preferred: constraints.optional(),
}).strict();
const group = z.object({ group_id:id, arrival_date:id, departure_date:id, rooms:z.array(room).min(1) }).strict();
const party = z.object({nativeId:id,name:id}).strict();
export const rateContext = z.object({organization:party.optional(),bookingAgency:party.optional()}).strict();
export function isEmptyQuoteGroup(value: unknown) {
  return !!value && typeof value==='object' && 'rooms' in value && Array.isArray(value.rooms) && !value.rooms.length;
}
export const quoteInput = z.object({
  quote_id:id, party_name:z.string().trim().optional(), property_code:id, groups:z.array(group).min(1),
  rate_context:rateContext.optional(),
  search:z.object({sales_strategy:id.optional(),include_restricted:z.boolean().optional(),include_alternatives:z.boolean().optional()}).strict().optional(),
  details:z.enum(['summary','full']).optional(), max_options_per_group:z.number().int().min(1).max(200).optional(),
}).strict();
export type QuoteInput = z.infer<typeof quoteInput>;

const string = { type:'string', minLength:1 };
const constraintsSchema = { type:'object', additionalProperties:false, properties:{
  roomCodes:{type:'array',minItems:1,items:string}, rateCodes:{type:'array',minItems:1,items:string},
  bedTypes:{type:'array',minItems:1,items:string}, mealPlanBases:{type:'array',minItems:1,items:string},
  features:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,properties:{name:string,value:string},required:['name','value']}},
} };
const roomSchema = {type:'object',additionalProperties:false,properties:{id:string,quantity:{type:'integer',minimum:1},adults:{type:'integer',minimum:1},children:{type:'integer',minimum:0},child_ages:{type:'array',items:{type:'integer',minimum:0,maximum:99}},required:constraintsSchema,preferred:constraintsSchema},required:['id','quantity','adults','children','child_ages']};
const groupSchema = {type:'object',additionalProperties:false,properties:{group_id:string,arrival_date:{type:'string',format:'date'},departure_date:{type:'string',format:'date'},rooms:{type:'array',minItems:1,items:roomSchema}},required:['group_id','arrival_date','departure_date','rooms']};
const partySchema={type:'object',additionalProperties:false,properties:{nativeId:string,name:string},required:['nativeId','name']};
export const quoteSchema = {
  type:'object',additionalProperties:false,properties:{quote_id:string,party_name:string,property_code:string,groups:{type:'array',minItems:1,items:groupSchema},
    rate_context:{type:'object',additionalProperties:false,properties:{organization:partySchema,bookingAgency:partySchema}},
    search:{type:'object',additionalProperties:false,properties:{sales_strategy:string,include_restricted:{type:'boolean'},include_alternatives:{type:'boolean'}}},
    details:{type:'string',enum:['summary','full']},max_options_per_group:{type:'integer',minimum:1,maximum:200}},
  required:['quote_id','property_code','groups'],
} satisfies {type:'object';properties:Record<string,unknown>;required:string[];additionalProperties:boolean};
