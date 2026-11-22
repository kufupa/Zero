import { normalizeReservationReference } from './reservation-reference.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { selectedStay } from '../tools/amend/index.js';
import { searchReservations, stageRead } from '../tools/triage/index.js';
import type { ToolResult, StaffNativeContext } from './tool-registry.js';
import type { ProposalDraft } from './schema.js';

const confirmation = z.string().regex(/^\d{6,10}-\d{1,10}$/);
export const targetLookup = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('surname'),surname:z.string().trim().min(1).max(256).regex(/^[^\r\n,]+$/)}).strict(),
  z.object({kind:z.literal('confirmation'),confirmation:z.string().transform(normalizeReservationReference).pipe(confirmation),arrival_date:z.string().date().optional()}).strict(),
]);
export const targetInput = z.object({expected_revision:z.number().int().positive(),lookup:targetLookup}).strict();
export const targetSelection = z.object({
  confirmation, property_code:z.string(), booking_id:z.string(),
  reservation_stay_id:z.string().regex(/^\d+$/), reservation_id:z.string().regex(/^\d+$/),
  record_id:z.string().regex(/^\d+$/), guest_id:z.string().regex(/^\d+$/),
  current_state:z.object({first_name:z.string().min(1),last_name:z.string().min(1),arrival_date:z.string().date(),
    departure_date:z.string().date(),adults:z.number(),room_type:z.string(),rate_plan:z.string(),
    native_stay_id:z.string().regex(/^\d+$/),guest_id:z.string().regex(/^\d+$/),
    reservation_id:z.string().regex(/^\d+$/),record_id:z.string().regex(/^\d+$/)}).strict(),
}).strict();

export function targetIsBound(booking:ProposalDraft['bookings'][number],execution:unknown) {
  const stay=z.object({staff_stay_selection:targetSelection}).safeParse(execution).data?.staff_stay_selection;
  return !!stay && stay.booking_id===booking.id && stay.property_code===booking.property_code &&
    stay.confirmation===booking.reservation_id && isDeepStrictEqual(stay.current_state,booking.current_state);
}

export function withAmendRoomTypeField(draft:ProposalDraft,execution:unknown):ProposalDraft {
  const [booking]=draft.bookings, [action]=draft.actions;
  const path='/bookings/0/fields/room_type';
  if(draft.workflow!=='amend' || !['propose','needs_info','staff_review'].includes(draft.disposition) || draft.bookings.length!==1 || draft.actions.length!==1 ||
    !booking || !action || action.type!=='amend' || action.booking_ids.length!==1 || action.booking_ids[0]!==booking.id ||
    !targetIsBound(booking,execution)) return draft;
  const field_specs=[...draft.field_specs];
  if(!field_specs.some(spec=>spec.path===path || spec.path===path.slice(1))) {
    field_specs.push({path,label:'Room Type code',control:'text',editable:true,
      required:false,provenance:'unknown',error:null,options:[],evidence:[]});
  }
  const cmsPath='/bookings/0/fields/cms_send', current=booking.current_state;
  if(current?.guest_id==='46343' && current.first_name==='Proof' && current.last_name==='Labtest' &&
    !field_specs.some(spec=>spec.path===cmsPath || spec.path===cmsPath.slice(1))) {
    field_specs.push({path:cmsPath,label:'Send Infor confirmation (CMS)',control:'checkbox',editable:true,
      required:false,provenance:'unknown',error:null,options:[],evidence:[]});
  }
  return field_specs.length===draft.field_specs.length ? draft : {...draft,field_specs};
}

export async function lookupStay(lookup:z.infer<typeof targetLookup>, bookingId:string, context:StaffNativeContext):Promise<ToolResult> {
  if(lookup.kind==='surname') {
    const result=await stageRead({workflow:'triage',booking:{id:bookingId},action:{type:'triage',details:{lookup:{guest_name:lookup.surname}}}},
      {...context,staffStage:{...context.staffStage,workflow:'triage'}});
    return result.ok ? {...result,data:{kind:'surname',...z.record(z.unknown()).parse(result.data)}} : result;
  }
  return lookupExactStay(lookup,bookingId,context);
}

export async function lookupExactStay(lookup:Extract<z.infer<typeof targetLookup>,{kind:'confirmation'}>, bookingId:string,
  context:Pick<StaffNativeContext,'propertyCode'|'credentialLease'|'signal'>):Promise<ToolResult> {
  const {withSavedStayAgentSession}=await import(new URL('../../server-pilot/tooling/hms-cloud/saved-stay-agent-session.mjs',import.meta.url).href);
  const raw=await withSavedStayAgentSession(
    ({runTool}:{runTool:(input:Record<string,unknown>)=>Promise<unknown>})=>runTool({tool:'read',confirmation:lookup.confirmation,
      ...(lookup.arrival_date ? {arrivalDate:lookup.arrival_date} : {}),includeNativePreimage:true}),
    {propertyCode:context.propertyCode,readOnly:true,readOnlyConfirmation:lookup.confirmation,signal:context.signal,credentialLease:context.credentialLease});
  const read=z.object({outcome:z.literal('ok'),shallow:z.object({confirmation}),record:z.object({nativePreimage:selectedStay})}).safeParse(raw);
  if(!read.success || read.data.shallow.confirmation!==lookup.confirmation ||
      read.data.record.nativePreimage.confirmation!==lookup.confirmation || read.data.record.nativePreimage.propertyCode!==context.propertyCode) {
    return {ok:false,data:null,error:{code:'TARGET_NOT_UNIQUE',message:'Infor could not uniquely verify this confirmation. Check the number and search again.',retryable:false,outcome:'known'}};
  }
  const stay=read.data.record.nativePreimage;
  const selection=targetSelection.parse({confirmation:stay.confirmation,property_code:stay.propertyCode,booking_id:bookingId,
    reservation_stay_id:stay.reservationStayId,reservation_id:stay.reservationId,record_id:stay.recordId,guest_id:stay.guestId,
    current_state:{first_name:stay.firstName,last_name:stay.lastName,arrival_date:stay.arrival,departure_date:stay.departure,
      adults:stay.adults,room_type:stay.roomType,rate_plan:stay.ratePlan,native_stay_id:stay.reservationStayId,
      guest_id:stay.guestId,reservation_id:stay.reservationId,record_id:stay.recordId}});
  return {ok:true,data:{kind:'confirmation',selection,status:stay.status},error:null};
}


const filingIdentity=z.object({first:z.string().trim().min(1),last:z.string().trim().min(1),arrival:z.string().date(),departure:z.string().date()});
const filingSearch=z.object({outcome:z.literal('candidates'),candidates:z.array(z.object({
  reservation_id:confirmation,first_name:z.string(),last_name:z.string(),arrival_date:z.string().date(),departure_date:z.string().date(),
}))});
const nameWords=(v:string)=>v.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
const nameKey=(v:string)=>nameWords(v).filter(word=>!['mr','mrs','ms','miss','dr'].includes(word)).sort().join(' ');

export async function lookupFilingStay(booking:ProposalDraft['bookings'][number], evidence:string,
  context:Pick<StaffNativeContext,'sessionId'|'propertyCode'|'credentialLease'|'signal'>,
  trace:(criteria:unknown,result:ToolResult)=>Promise<void>) {
  const f=booking.fields;
  const identity=filingIdentity.safeParse({first:f.first_name??f.guest_first_name,last:f.last_name??f.guest_last_name,
    arrival:f.arrival_date,departure:f.departure_date});
  if(!identity.success) return;
  const {first,last,arrival,departure}=identity.data;
  const wanted=nameKey(first+' '+last);
  const source=new Set(nameWords(evidence));
  if(!wanted || !wanted.split(' ').every(word=>source.has(word))) return;
  const refs=[...evidence.matchAll(/(?:supplier confirmation|hotel ref\.?)\s*:?\s*(\d{6,10}(?:-\d+)?)(?!\d)/gi)]
    .map(match=>normalizeReservationReference(match[1]));
  const candidates=[];
  for(const surname of new Set([last,first])) {
    const criteria={guest_name:surname,arrival_date:arrival,near_arrival:true};
    const result=await searchReservations({property_code:context.propertyCode,criteria},{...context,mode:'live'});
    await trace(criteria,result);
    const parsed=filingSearch.safeParse(result.data);
    if(!parsed.success) continue;
    candidates.push(...parsed.data.candidates.filter(stay=>nameKey(stay.first_name+' '+stay.last_name)===wanted &&
      stay.departure_date===departure && (stay.arrival_date===arrival || (stay.arrival_date<arrival &&
        refs.includes(stay.reservation_id)))));
    if(candidates.length) break;
  }
  if(candidates.length!==1) return;
  const [candidate]=candidates;
  const read=await lookupExactStay({kind:'confirmation',confirmation:candidate.reservation_id,arrival_date:candidate.arrival_date},booking.id,context);
  await trace({reservation_id:candidate.reservation_id,arrival_date:candidate.arrival_date},read);
  const stay=z.object({selection:targetSelection}).safeParse(read.data).data?.selection;
  if(stay?.current_state.departure_date===departure && stay.current_state.arrival_date===candidate.arrival_date &&
    nameKey(stay.current_state.first_name+' '+stay.current_state.last_name)===wanted) return stay;
}
