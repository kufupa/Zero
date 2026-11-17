import { z } from 'zod';
import { sql, uid, json } from './db.js';
import { proposalDraft } from './schema.js';
import { proposalWire } from './runtime.js';

const change=z.object({op:z.enum(['add','replace','remove']),path:z.string(),value:z.unknown().optional()}).strict().superRefine((x,ctx)=>{
  if(x.op!=='remove' && !Object.hasOwn(x,'value')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'value required'});
  if(x.op==='remove' && Object.hasOwn(x,'value')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'remove has no value'});
});
export const editInput=z.object({expected_revision:z.number().int().min(1),changes:z.array(change).min(1)}).strict();
type Change=z.infer<typeof change>;
type Container=Record<string,unknown>|unknown[];
function pointer(path:string) {
  if(!path.startsWith('/') || /~(?![01])/.test(path)) throw new Error('INVALID_PATH');
  const parts=path.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
  if(parts.some(p=>['__proto__','prototype','constructor'].includes(p))) throw new Error('INVALID_PATH');
  const editable=(parts[0]==='bookings' && /^\d+$/.test(parts[1]??'') && parts[2]==='fields' && parts.length>=4) || (parts[0]==='actions' && /^\d+$/.test(parts[1]??'') && parts[2]==='details' && parts.length>=4) || (parts.length===1 && parts[0]==='reply_draft');
  if(!editable) throw new Error('INVALID_PATH');
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
    if(!p || !mailboxIds.includes(p.mailbox_id)) throw new Error('NOT_FOUND');
    if(p.revision!==input.expected_revision) throw new Error('STALE_REVISION');
    if(p.phase!=='ready') throw new Error('NOT_EDITABLE');
    const draft=proposalDraft.parse(structuredClone(p.current));
    const changes: {change:Change;before:unknown;before_present:boolean;after:unknown;after_present:boolean}[]=[];
    for(const item of input.changes) {
      const spec=draft.field_specs.find(f=>f.path===item.path);
      if(!spec?.editable) throw new Error('INVALID_PATH');
      const modified=apply(draft,item);
      spec.provenance='staff';
      changes.push({change:item,...modified});
    }
    const valid=proposalDraft.parse(draft), revision=p.revision+1;
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
    return proposalWire(updated);
  });
}
