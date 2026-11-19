import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { sql, uid, json } from './db.js';
import { proposalDraft } from './schema.js';
import { priorQuotedRateChoices, proposalWire } from './runtime.js';
import { withCancelReviewFields } from '../tools/cancel/index.js';
import { editablePointer, pointerParts, validChildAges, withCreateNativeFields, withQuoteStaffFields } from './proposal-fields.js';
import { attachmentCheckPath, hasBoundCreateGuest, invalidGuestSelection, profileReview, profileReviewFor, requiresStaffAttachmentCheck, selectedCreateGuest, selectedStageSource, staffAttachmentsChecked } from './attachment-gate.js';
import { staffPrepareOnly } from './hms-mode.js';
import { targetSelection, withAmendRoomTypeField } from './stay-target.js';

export async function selectStayTarget(id:string,mailboxIds:string[],actor:string,input:{expected_revision:number;job_id:string;remove_fields:string[]}) {
  return sql.begin(async tx=>{
    const [ref]=await tx`SELECT p.session_id,t.mailbox_id FROM nava_agent.proposal p JOIN nava_agent.mail_thread t ON t.id=p.thread_id WHERE p.id=${id}`;
    if(!ref) throw new Error('NOT_FOUND');
    if(!mailboxIds.includes(ref.mailbox_id)) throw new Error('FORBIDDEN');
    await tx`SELECT id FROM nava_agent.agent_session WHERE id=${ref.session_id} FOR NO KEY UPDATE`;
    const [p]=await tx`SELECT * FROM nava_agent.proposal WHERE id=${id} AND session_id=${ref.session_id} FOR UPDATE`;
    if(!p) throw new Error('NOT_FOUND');
    if(p.revision!==input.expected_revision || p.phase!=='ready' || p.stage?.revision!==p.revision ||
      p.stage?.state!=='target' || p.stage?.job_id!==input.job_id || p.stage?.native_result?.kind!=='confirmation') throw new Error('STALE_REVISION');
    const source=await selectedStageSource(tx,p.session_id);
    const selection=targetSelection.safeParse(p.stage.native_result.selection);
    const draft=proposalDraft.parse(p.current);
    const booking=draft.bookings[0],action=draft.actions[0];
    if(!source.success || !isDeepStrictEqual(source.data,p.stage?.source) || source.data.mailbox_id!==ref.mailbox_id || !selection.success ||
      !['amend','cancel','filing'].includes(draft.workflow) || draft.bookings.length!==1 || draft.actions.length!==1 ||
      !booking || !action || (action.type!==draft.workflow && !(draft.workflow==='filing' && ['attach_document','voucher_submission','payment_proof_submission'].includes(action.type))) ||
      action.booking_ids.length!==1 || action.booking_ids[0]!==booking.id ||
      selection.data.booking_id!==booking.id || (booking.property_code!==null && selection.data.property_code!==booking.property_code) ||
      selection.data.property_code!==source.data.property_code) throw new Error('STALE_REVISION');
    const before=structuredClone(booking);
    booking.reservation_id=selection.data.confirmation;
    booking.property_code=selection.data.property_code;
    booking.current_state=selection.data.current_state;
    if(draft.workflow==='amend') {
      if(input.remove_fields.some(key=>!Object.hasOwn(booking.fields,key))) throw new Error('STALE_REVISION');
      for(const key of input.remove_fields) delete booking.fields[key];
      draft.field_specs=draft.field_specs.filter(spec=>!input.remove_fields.some(key=>spec.path===`/bookings/0/fields/${key}` || spec.path===`bookings/0/fields/${key}`));
      if(action.details && typeof action.details==='object' && !Array.isArray(action.details) && 'confirmation_number' in action.details)
        action.details.confirmation_number=selection.data.confirmation;
    } else if(input.remove_fields.length) throw new Error('STALE_REVISION');
    if(draft.workflow==='filing') {
      if(draft.disposition==='staff_review') draft.disposition='propose';
      const stay=selection.data.current_state;
      for(const [key,value] of Object.entries({confirmation_number:selection.data.confirmation,
        first_name:stay.first_name,guest_first_name:stay.first_name,last_name:stay.last_name,guest_last_name:stay.last_name,
        arrival_date:stay.arrival_date,departure_date:stay.departure_date})) {
        if(Object.hasOwn(booking.fields,key)) booking.fields[key]=value;
      }
    }
    const revision=p.revision+1;
    const execution:Record<string,unknown>={...z.record(z.unknown()).safeParse(p.execution).data,staff_stay_selection:selection.data};
    delete execution.error;
    const valid=proposalDraft.parse(draft);
    await tx`UPDATE nava_agent.proposal SET current=${json(valid)},revision=${revision},stage=NULL,execution=${json(execution)},updated_at=now() WHERE id=${id}`;
    const [seq]=await tx`SELECT COALESCE(max(sequence),0)+1 AS n FROM nava_agent.staff_edit WHERE proposal_id=${id}`;
    await tx`INSERT INTO nava_agent.staff_edit(id,sequence,proposal_id,session_id,workflow,kind,revision,who,snapshot)
      VALUES (${uid('edit')},${seq.n},${id},${p.session_id},${p.workflow},'stay_selected',${revision},${actor},${json({selection:selection.data,before,after:booking,removed_fields:input.remove_fields})})`;
    await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${p.session_id},'edit',${json({proposal_id:id,revision,change:'stay_selected'})})`;
    const selectedFields = [
      {path:'/bookings/0/reservation_id',before:before.reservation_id,after:booking.reservation_id,before_present:true,after_present:true},
      ...input.remove_fields.map(key=>({path:`/bookings/0/fields/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,before:before.fields[key],after:null,before_present:true,after_present:false})),
    ];
    for(const field of selectedFields) if(field.before_present!==field.after_present || !isDeepStrictEqual(field.before,field.after)) {
      await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${p.session_id},'correction',${json({proposal_id:id,workflow:p.workflow,source_message_id:source.data.source_message_id,revision,...field,who:actor})})`;
    }
    const [updated]=await tx`SELECT * FROM nava_agent.proposal WHERE id=${id}`;
    return {...proposalWire(updated),source_message_id:source.data.source_message_id};
  });
}

const change=z.object({op:z.enum(['add','replace','remove']),path:z.string(),value:z.unknown().optional()}).strict().superRefine((x,ctx)=>{
  if(x.op!=='remove' && !Object.hasOwn(x,'value')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'value required'});
  if(x.op==='remove' && Object.hasOwn(x,'value')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'remove has no value'});
});
export const editInput=z.object({expected_revision:z.number().int().min(1),changes:z.array(change),staff_attachments_checked:z.boolean().optional()}).strict()
  .refine(input=>input.changes.length>0 || input.staff_attachments_checked!==undefined,{message:'Nothing to edit'});
type Change=z.infer<typeof change>;
type Container=Record<string,unknown>|unknown[];
const nativeGuestCandidates=z.object({items:z.array(z.object({native_id:z.string(),first_name:z.string(),last_name:z.string()}))});
function quoteIdentities(draft:z.infer<typeof proposalDraft>) {
  return draft.actions.filter(action=>action.type==='quote').map(({id,details})=>{
    if(typeof details!=='object' || details===null || Array.isArray(details)) return {id,details};
    const groups=Array.isArray(details.groups)?details.groups.map(group=>{
      if(typeof group!=='object' || group===null || Array.isArray(group)) return group;
      const rooms=Array.isArray(group.rooms)?group.rooms.map((room:unknown)=>typeof room==='object' && room!==null && !Array.isArray(room) && 'id' in room?room.id:room):group.rooms;
      return {group_id:group.group_id,rooms};
    }):details.groups;
    return {id,quote_id:details.quote_id,groups};
  });
}
function pointer(path:string) {
  const parts = pointerParts(path);
  if (!parts || !editablePointer(parts)) throw new Error('INVALID_PATH');
  return parts;
}
function apply(root:unknown, change:Change) {
  const parts=pointer(change.path); let value:unknown=root;
  for(const part of parts.slice(0,-1)) {
    if(typeof value!=='object' || value===null || !Object.hasOwn(value,part)) throw new Error('INVALID_PATH');
    value=(value as Record<string,unknown>)[part];
  }
  if(typeof value!=='object' || value===null) throw new Error('INVALID_PATH');
  const parent=value as Container, key=parts[parts.length-1];
  if(Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key)>=parent.length || change.op!=='replace')) throw new Error('INVALID_PATH');
  const object=parent as Record<string,unknown>, present=Object.hasOwn(object,key), before=present?object[key]:null;
  if(change.op!=='add' && !present) throw new Error('INVALID_PATH');
  if(change.op==='remove') delete object[key]; else object[key]=change.value;
  return {before,before_present:present,after:change.op==='remove'?null:change.value,after_present:change.op!=='remove'};
}
export async function editProposal(id:string, mailboxIds:string[], actor:string, input:z.infer<typeof editInput>) {
  return sql.begin(async tx=>{
    const [p]=await tx`SELECT p.*,t.mailbox_id,t.selected_message_id FROM nava_agent.proposal p JOIN nava_agent.mail_thread t ON t.id=p.thread_id WHERE p.id=${id} FOR UPDATE OF p`;
    if(!p) throw new Error('NOT_FOUND');
    if(!mailboxIds.includes(p.mailbox_id)) throw new Error('FORBIDDEN');
    if(p.revision!==input.expected_revision) throw new Error('STALE_REVISION');
    if(p.phase!=='ready' && p.phase!=='waiting_go') throw new Error('NOT_EDITABLE');
    if(input.changes.length===0 && input.staff_attachments_checked!==undefined) {
      if(!requiresStaffAttachmentCheck(p.workflow)) throw new Error('INVALID_PATH');
      const [previous]=await tx`SELECT after = 'true'::jsonb AS checked FROM nava_agent.staff_edit
        WHERE proposal_id=${id} AND revision=${p.revision} AND kind='edit' AND path=${attachmentCheckPath}
        ORDER BY sequence DESC LIMIT 1`;
      const before=previous?.checked===true, after=input.staff_attachments_checked;
      const [last]=await tx`SELECT COALESCE(max(sequence),0)::int AS n FROM nava_agent.staff_edit WHERE proposal_id=${id}`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+p.session_id},0))`;
      const editId=uid('edit');
      const [saved]=await tx`INSERT INTO nava_agent.staff_edit(id,sequence,proposal_id,session_id,workflow,kind,revision,path,before,after,before_present,after_present,who)
        VALUES (${editId},${last.n+1},${id},${p.session_id},${p.workflow},'edit',${p.revision},${attachmentCheckPath},${json(before)},${json(after)},true,true,${actor}) RETURNING at`;
      await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${p.session_id},'edit',${json({proposal_id:id,edit_id:editId,revision:p.revision,path:attachmentCheckPath,before,after,before_present:true,after_present:true,who:actor,at:saved.at})})`;
      const quotedRates=p.workflow==='create' ? await priorQuotedRateChoices(tx,p.thread_id) : [];
      return {...proposalWire(p,null,quotedRates),staff_attachments_checked:after};
    }
    const stored=proposalDraft.parse(structuredClone(p.current));
    const draft=p.phase==='ready' ? withCancelReviewFields(withQuoteStaffFields(withCreateNativeFields(stored))) : stored;
    const editable=p.phase==='ready' ? withAmendRoomTypeField(draft,p.execution) : draft;
    const identities=JSON.stringify(quoteIdentities(draft));
    const quoteActions=p.workflow==='quote'?structuredClone(draft.actions):null;
    const changes: {change:Change;before:unknown;before_present:boolean;after:unknown;after_present:boolean}[]=[];
    for(const item of input.changes) {
      const spec=editable.field_specs.find(f=>f.path===item.path);
      if(!spec?.editable || (p.workflow==='filing' && /^\/actions\/\d+\/details\/message_id(?:\/|$)/.test(item.path))) throw new Error('INVALID_PATH');
      const modified=apply(draft,item);
      if(!draft.field_specs.includes(spec)) draft.field_specs.push(spec);
      spec.provenance='staff';
      changes.push({change:item,...modified});
    }
    const countChange=input.changes.find(change=>change.path==='/bookings/0/fields/room_count');
    const clonedFromFirst:string[]=[];
    if(countChange && p.workflow==='create') {
      const count=draft.bookings[0]?.fields.room_count;
      if(typeof count!=='number' || !Number.isInteger(count) || count<1 || count>8 || !draft.bookings[0]) throw new Error('INVALID_INPUT');
      const first=draft.bookings[0];
      while(draft.bookings.length<count) {
        const index=draft.bookings.length, id=uid('booking');
        const fields={...structuredClone(first.fields)};
        delete fields.room_count;
        draft.bookings.push({...structuredClone(first),id,fields});
        clonedFromFirst.push(id);
        for(const spec of draft.field_specs.filter(field=>field.path.startsWith('/bookings/0/fields/') && !field.path.endsWith('/room_count'))) {
          draft.field_specs.push({...structuredClone(spec),path:spec.path.replace('/bookings/0/',`/bookings/${index}/`)});
        }
        const action=draft.actions.find(item=>item.type==='create' && item.booking_ids.includes(first.id));
        if(!action) throw new Error('INVALID_INPUT');
        action.booking_ids.push(id);
      }
      if(draft.bookings.length>count) {
        const removed=new Set(draft.bookings.slice(count).map(booking=>booking.id));
        draft.bookings=draft.bookings.slice(0,count);
        draft.actions=draft.actions.map(action=>({...action,booking_ids:action.booking_ids.filter(id=>!removed.has(id))})).filter(action=>action.type!=='create' || action.booking_ids.length>0);
        draft.field_specs=draft.field_specs.filter(spec=>{const match=/^\/bookings\/(\d+)\//.exec(spec.path);return !match || Number(match[1])<count;});
      }
    }
    const valid=proposalDraft.parse(draft), revision=p.revision+1;
    if(JSON.stringify(quoteIdentities(valid))!==identities) throw new Error('INVALID_PATH');
    if(quoteActions && !isDeepStrictEqual(quoteActions,valid.actions)) {
      valid.native_result=null;
      if(!input.changes.some(change=>change.path==='/reply_draft')) valid.reply_draft=null;
    }
    const bindCreateGuest=p.workflow==='create' && staffPrepareOnly();
    const guestSelections:NonNullable<ReturnType<typeof selectedCreateGuest>>[]=[];
    const reviews:z.infer<typeof profileReview>[]=[];
    if(bindCreateGuest) {
      for(const booking of valid.bookings) {
        const old=clonedFromFirst.includes(booking.id) ? stored.bookings[0] : stored.bookings.find(item=>item.id===booking.id);
        if(!old || old.fields.first_name!==booking.fields.first_name || old.fields.last_name!==booking.fields.last_name || (old.fields.guest_email??null)!==(booking.fields.guest_email??null)) continue;
        const oldIndex=stored.bookings.findIndex(item=>item.id===old.id);
        const native=p.stage?.revision===p.revision ? p.stage.native_result : null;
        const choices=stored.bookings.length===1 ? native?.guest_candidates : native?.rooms?.[oldIndex]?.guest_candidates;
        const candidate=profileReview.safeParse({booking_id:booking.id,first_name:booking.fields.first_name,last_name:booking.fields.last_name,guest_email:booking.fields.guest_email??null,choices});
        const previous=profileReviewFor(old,p.execution);
        if(candidate.success) reviews.push(candidate.data); else if(previous) reviews.push({...previous,booking_id:booking.id});
      }
      for(const [index,booking] of valid.bookings.entries()) {
        if(booking.fields.guest_profile_id==null) continue;
        const selected=selectedCreateGuest(booking);
        const native=p.stage?.revision===p.revision?p.stage.native_result:null;
        const old=clonedFromFirst.includes(booking.id) ? stored.bookings[0] : stored.bookings.find(item=>item.id===booking.id);
        const oldIndex=old ? stored.bookings.findIndex(item=>item.id===old.id) : index;
        const choices=stored.bookings.length===1 ? native?.guest_candidates : native?.rooms?.[oldIndex]?.guest_candidates;
        const priorReview=old ? profileReviewFor(old,p.execution) : null;
        const candidates=nativeGuestCandidates.safeParse(choices ?? priorReview?.choices);
        const selectsGuest=input.changes.some(change=>change.path===`/bookings/${index}/fields/guest_profile_id` && change.op!=='remove');
        const cloned=selected!==null && clonedFromFirst.includes(booking.id) && guestSelections.some(first=>first.booking_id===valid.bookings[0]?.id &&
          first.native_id===selected.native_id && first.first_name===selected.first_name && first.last_name===selected.last_name);
        const matched=selected && candidates.success && candidates.data.items.some(candidate=>
          candidate.native_id===selected.native_id && candidate.first_name===selected.first_name && candidate.last_name===selected.last_name);
        if(selectsGuest && !matched && !hasBoundCreateGuest(booking,p.execution) && !cloned) {
          throw new Error(invalidGuestSelection.code);
        }
        if(selected && (hasBoundCreateGuest(booking,p.execution) || cloned || (selectsGuest && matched))) guestSelections.push(selected);
      }
    }
    if(p.workflow==='create') for(const change of input.changes) {
      const match=/^\/bookings\/(\d+)\/fields\/child_(?:count|ages)(?:\/|$)/.exec(change.path);
      const fields=match && valid.bookings[Number(match[1])]?.fields;
      if(fields && !validChildAges(fields.child_count,fields.child_ages)
        && !(fields.child_ages==null && (fields.child_count==null || (Number.isInteger(fields.child_count) && Number(fields.child_count)>0)))) throw new Error('INVALID_CHILD_AGES');
    }
    if(input.staff_attachments_checked!==undefined) {
      if(!requiresStaffAttachmentCheck(p.workflow)) throw new Error('INVALID_PATH');
      const before=await staffAttachmentsChecked(tx,p.id,p.revision);
      const after=input.staff_attachments_checked;
      changes.push({change:{op:'replace',path:attachmentCheckPath,value:after},before,before_present:true,after,after_present:true});
    }
    const [last]=await tx`SELECT COALESCE(max(sequence),0)::int AS n FROM nava_agent.staff_edit WHERE proposal_id=${id}`;
    let sequence=last.n;
    const stageError=p.execution?.error?.operation==='staff_stage';
    const execution=bindCreateGuest || stageError ? {...z.record(z.unknown()).safeParse(p.execution).data} : undefined;
    if(execution) {
      if(stageError) delete execution.error;
      if(bindCreateGuest) {
        execution.staff_profile_reviews=reviews;
        delete execution.staff_guest_selection;
        if(guestSelections.length) execution.staff_guest_selections=guestSelections;
        else delete execution.staff_guest_selections;
      }
    }
    await tx`UPDATE nava_agent.proposal SET current=${json(valid)},revision=${revision},stage=NULL,
      execution=CASE WHEN ${execution!==undefined} THEN ${json(execution??null)} ELSE execution END,
      updated_at=now() WHERE id=${id}`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+p.session_id},0))`;
    for(const item of changes) {
      const editId=uid('edit'); sequence++;
      const [saved]=await tx`INSERT INTO nava_agent.staff_edit(id,sequence,proposal_id,session_id,workflow,kind,revision,path,before,after,before_present,after_present,who) VALUES (${editId},${sequence},${id},${p.session_id},${p.workflow},'edit',${revision},${item.change.path},${json(item.before)},${json(item.after)},${item.before_present},${item.after_present},${actor}) RETURNING at`;
      const correction=item.change.path!==attachmentCheckPath &&
        (item.before_present!==item.after_present || !isDeepStrictEqual(item.before,item.after));
      await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${p.session_id},${correction?'correction':'edit'},${json({proposal_id:id,workflow:p.workflow,source_message_id:p.selected_message_id,edit_id:editId,revision,path:item.change.path,before:item.before,after:item.after,before_present:item.before_present,after_present:item.after_present,who:actor,at:saved.at})})`;
    }
    const [updated]=await tx`SELECT * FROM nava_agent.proposal WHERE id=${id}`;
    const quotedRates=p.workflow==='create' ? await priorQuotedRateChoices(tx,p.thread_id) : [];
    return {...proposalWire(updated,null,quotedRates),staff_attachments_checked:input.staff_attachments_checked===true};
  });
}
