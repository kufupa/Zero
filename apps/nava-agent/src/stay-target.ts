import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { selectedStay } from '../tools/amend/index.js';
import { stageRead } from '../tools/triage/index.js';
import type { ToolResult, StaffNativeContext } from './tool-registry.js';
import type { ProposalDraft } from './schema.js';

const confirmation = z.string().regex(/^\d{6,10}-\d{1,10}$/);
export const targetLookup = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('surname'),surname:z.string().trim().min(1).max(256).regex(/^[^\r\n,]+$/)}).strict(),
  z.object({kind:z.literal('confirmation'),confirmation,arrival_date:z.string().date().optional()}).strict(),
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
  if(draft.workflow!=='amend' || draft.disposition!=='propose' || draft.bookings.length!==1 || draft.actions.length!==1 ||
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
