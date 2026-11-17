import { z } from 'zod';
import { sql, uid, json } from './db.js';
import { proposalDraft } from './schema.js';
import { proposalWire } from './runtime.js';
import { editablePointer, pointerParts, validChildAges, withCreateNativeFields } from './proposal-fields.js';
import { attachmentCheckPath, staffAttachmentsChecked } from './attachment-gate.js';

const change=z.object({op:z.enum(['add','replace','remove']),path:z.string(),value:z.unknown().optional()}).strict().superRefine((x,ctx)=>{
  if(x.op!=='remove' && !Object.hasOwn(x,'value')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'value required'});
  if(x.op==='remove' && Object.hasOwn(x,'value')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'remove has no value'});
});
export const editInput=z.object({expected_revision:z.number().int().min(1),changes:z.array(change),staff_attachments_checked:z.boolean().optional()}).strict()
  .refine(input=>input.changes.length>0 || input.staff_attachments_checked!==undefined,{message:'Nothing to edit'});
type Change=z.infer<typeof change>;
type Container=Record<string,unknown>|unknown[];
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
    const [p]=await tx`SELECT p.*,t.mailbox_id FROM nava_agent.proposal p JOIN nava_agent.mail_thread t ON t.id=p.thread_id WHERE p.id=${id} FOR UPDATE OF p`;
    if(!p) throw new Error('NOT_FOUND');
    if(!mailboxIds.includes(p.mailbox_id)) throw new Error('FORBIDDEN');
    if(p.revision!==input.expected_revision) throw new Error('STALE_REVISION');
    if(p.phase!=='ready' && p.phase!=='waiting_go') throw new Error('NOT_EDITABLE');
    const stored=proposalDraft.parse(structuredClone(p.current));
    const draft=p.phase==='ready' ? withCreateNativeFields(stored) : stored;
    const identities=JSON.stringify(quoteIdentities(draft));
    const changes: {change:Change;before:unknown;before_present:boolean;after:unknown;after_present:boolean}[]=[];
    for(const item of input.changes) {
      const spec=draft.field_specs.find(f=>f.path===item.path);
      if(!spec?.editable) throw new Error('INVALID_PATH');
      const modified=apply(draft,item);
      spec.provenance='staff';
      changes.push({change:item,...modified});
    }
    const valid=proposalDraft.parse(draft), revision=p.revision+1;
    if(JSON.stringify(quoteIdentities(valid))!==identities) throw new Error('INVALID_PATH');
    if(p.workflow==='create') for(const change of input.changes) {
      const match=/^\/bookings\/(\d+)\/fields\/child_(?:count|ages)(?:\/|$)/.exec(change.path);
      const fields=match && valid.bookings[Number(match[1])]?.fields;
      if(fields && !validChildAges(fields.child_count,fields.child_ages)) throw new Error('INVALID_CHILD_AGES');
    }
    if(input.staff_attachments_checked!==undefined) {
      if(p.workflow!=='create') throw new Error('INVALID_PATH');
      const before=await staffAttachmentsChecked(tx,p.id,p.revision);
      const after=input.staff_attachments_checked;
      changes.push({change:{op:'replace',path:attachmentCheckPath,value:after},before,before_present:true,after,after_present:true});
    }
    const [last]=await tx`SELECT COALESCE(max(sequence),0)::int AS n FROM nava_agent.staff_edit WHERE proposal_id=${id}`;
    let sequence=last.n;
    await tx`UPDATE nava_agent.proposal SET current=${json(valid)},revision=${revision},stage=NULL,updated_at=now() WHERE id=${id}`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+p.session_id},0))`;
    for(const item of changes) {
      const editId=uid('edit'); sequence++;
      const [saved]=await tx`INSERT INTO nava_agent.staff_edit(id,sequence,proposal_id,session_id,workflow,kind,revision,path,before,after,before_present,after_present,who) VALUES (${editId},${sequence},${id},${p.session_id},${p.workflow},'edit',${revision},${item.change.path},${json(item.before)},${json(item.after)},${item.before_present},${item.after_present},${actor}) RETURNING at`;
      await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${p.session_id},'edit',${json({proposal_id:id,edit_id:editId,revision,path:item.change.path,before:item.before,after:item.after,before_present:item.before_present,after_present:item.after_present,who:actor,at:saved.at})})`;
    }
    const [updated]=await tx`SELECT * FROM nava_agent.proposal WHERE id=${id}`;
    return {...proposalWire(updated),staff_attachments_checked:input.staff_attachments_checked===true};
  });
}
