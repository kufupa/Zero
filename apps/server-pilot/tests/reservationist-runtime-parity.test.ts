import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {runPreparedWorkerCandidateReply} from '../src/ai/worker.js';
import {runReservationistRuntime,type RuntimeWorkResult,type RuntimeTaskResult} from '../src/ai/reservationist-runtime.js';
const input={version:1 as const,requestId:'req',propertyCode:'HRCEN',trigger:{id:'incoming',at:'2026-10-04T10:00:00Z'},messages:[{id:'incoming',at:'2026-10-04T10:00:00Z',direction:'inbound' as const,text:'Please quote and advise transfer price.'}],authorizedArtifacts:[],clock:{causalAt:'2026-10-04T10:00:00Z',sourceAt:'2026-10-04T10:00:00Z',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false as const,emailSend:false as const}};
const route={route:{routeId:'synthetic-route',purpose:'draft',protocol:'in_process',access:'current_app',egress:'none',retention:'bounded',usage:'reported',modelId:'gpt-6-luna'},release:{withdrawn:false,expiresAt:new Date(Date.now()+60000).toISOString()}};
const plan={tasks:[{id:'quote',kind:'quote',required:true},{id:'transfer',kind:'question',required:true}],facts:[]};
const completedClauses:Record<string,string>={quote:'Accommodation total: ZAR 2200.02.',transfer:'Could you confirm the transfer route?'};
const completed={preparedFacts:[{key:'price',label:'Price',value:{amount:'2200.02',currency:'ZAR'},source:'hms' as const,authority:'authorized' as const,status:'known' as const}],approvedGuestClauses:completedClauses,tasks:[{id:'quote',status:'complete' as const,guestText:'Accommodation total: ZAR 2200.02.',evidenceRefs:['quote:one']},{id:'transfer',status:'needs_clarification' as const,guestText:'Could you confirm the transfer route?',evidenceRefs:[]}],artifacts:[],quoteRefs:['quote:one'],packets:[],errors:[]} satisfies RuntimeWorkResult;
describe('shared candidate and replay reservationist runtime',()=>{
 it('runs identical planning/work/composition for replay and candidate, no model prose authority',async()=>{
  const planFn=vi.fn(async()=>({...plan,replyDraft:'Booking confirmed; total R0'})),execute=vi.fn(async()=>completed);
  const deps:Parameters<typeof runReservationistRuntime>[1]={verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:planFn,execute};const a=await runReservationistRuntime(input,deps),b=await runReservationistRuntime(input,deps);
  expect(a).toEqual(b);expect(a.textBody).toContain('ZAR 2200.02');expect(a.textBody).toContain('transfer route');expect(a.textBody).not.toMatch(/confirmed|R0/);expect(planFn).toHaveBeenCalledTimes(2);expect(a.readiness).toBe('needs_clarification');
 });
 it('cannot omit a secondary mandatory task or claim a required nonexistent artifact',async()=>{
  await expect(runReservationistRuntime(input,{verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>plan,execute:async()=>({...completed,tasks:[completed.tasks[0]]})})).rejects.toThrow(/task/);
  await expect(runReservationistRuntime(input,{verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>plan,execute:async()=>({...completed,requiredArtifactRefs:['missing']})})).rejects.toThrow(/artifact/);
 });
 it('future messages and mutation capabilities fail before model invocation',async()=>{
  const planning=vi.fn(async()=>plan),deps={plan:planning,execute:async()=>completed};
  await expect(runReservationistRuntime({...input,messages:[...input.messages,{...input.messages[0],id:'later',at:'2026-10-05T00:00:00Z'}]},deps)).rejects.toThrow(/causal/);
  await expect(runReservationistRuntime({...input,capabilities:{pmsWrite:true,emailSend:false} as any},deps)).rejects.toThrow(/capability/);expect(planning).not.toHaveBeenCalled();
 });
 it('pending packet always remains unconfirmed and staff-only work never leaks',async()=>{
  const r=await runReservationistRuntime(input,{verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>({...plan,tasks:[{...plan.tasks[0],kind:'new_booking'},plan.tasks[1]]}),execute:async()=>({...completed,tasks:[{...completed.tasks[0],status:'pending_pms_action',guestText:'Booking has been made'},{...completed.tasks[1],disclosure:'staff_only',guestText:'account INTERNAL'}],packets:[{saved:false,status:'pending_pms_action',kind:'new_booking',taskId:'quote',businessRulesValidated:true}]})});
  expect(r.readiness).toBe('pending_pms_action');expect(r.textBody).not.toMatch(/has been made|INTERNAL/);expect(r.textBody).toContain('subject to staff completion');
 });
});

describe('runtime body literal admission',()=>{
 it('rejects work-stage money not bound to canonical verified guest clauses',async()=>{
  await expect(runReservationistRuntime(input,{verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>plan,execute:async()=>({...completed,tasks:[{...completed.tasks[0],guestText:'Total ZAR 1.00.'},completed.tasks[1]],approvedGuestClauses:{quote:'Accommodation total: ZAR 2200.02.',transfer:'Could you confirm the transfer route?'}})})).rejects.toThrow(/literal/);
 });
});

it('runs the joined runner through worker candidate seam without a final wording model call',async()=>{
 const adapter={invoke:vi.fn()};
 const result=await runPreparedWorkerCandidateReply({requestId:'req',requestText:'Please quote',adapter,route,qualifiedReservationist:{input,dependencies:{verifyGuestClause:async(task:RuntimeTaskResult)=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>plan,execute:async()=>completed}}} as any);
 expect(result.textBody).toContain('ZAR 2200.02');expect(adapter.invoke).not.toHaveBeenCalled();expect(result.metrics.reservationistResult).toBeDefined();
});
it('requires verified clauses and ignores hostile result-level overrides',async()=>{
 await expect(runReservationistRuntime(input,{verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>plan,execute:async()=>({...completed,approvedGuestClauses:undefined})})).rejects.toThrow(/clauses/);
 const r=await runReservationistRuntime(input,{verifyGuestClause:async task=>completed.approvedGuestClauses[task.id]===task.guestText,plan:async()=>plan,execute:async()=>({...completed,approvedGuestClauses:{quote:completed.tasks[0].guestText,transfer:completed.tasks[1].guestText},textBody:'Booking confirmed',readiness:'ready_for_staff_review'} as any)});
 expect(r.textBody).not.toContain('confirmed');expect(r.readiness).toBe('needs_clarification');
});
it('worker rejects qualified request binding mismatches before execution',async()=>{
 const planning=vi.fn(async()=>plan);
 await expect(runPreparedWorkerCandidateReply({requestId:'different',requestText:'Please quote',qualifiedReservationist:{input,dependencies:{plan:planning,execute:async()=>completed}}} as any)).rejects.toThrow(/binding/);
 expect(planning).not.toHaveBeenCalled();
});

it.each([['change','amendment'],['cancel_request','cancellation']])('retains %s action wording without substituting a booking confirmation',async(kind,label)=>{
 const task={id:'action',status:'pending_pms_action' as const,guestText:'unsafe arbitrary completion',evidenceRefs:['reservation-proof']};
 const result=await runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'action',kind,required:true}],facts:[]}),execute:async()=>({tasks:[task],artifacts:[],quoteRefs:[],approvedGuestClauses:{},packets:[{saved:false as const,status:'pending_pms_action',kind,taskId:'action',businessRulesValidated:true}],errors:[]})});
 expect(result.readiness).toBe('pending_pms_action');expect(result.textBody).toContain(`Your ${label} request`);expect(result.textBody).not.toContain('Your booking request');
});
it('cannot label an amendment pending without its validated action packet',async()=>{
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'change',kind:'change',required:true}],facts:[]}),execute:async()=>({tasks:[{id:'change',status:'pending_pms_action',guestText:'',evidenceRefs:['source']}],approvedGuestClauses:{},artifacts:[],quoteRefs:[],packets:[],errors:[]})})).rejects.toThrow(/pending_action_packet/);
});

it('derives resending an existing quote or proposal as a document obligation without inventing a new quote request',async()=>{
 const {deriveReservationistTaskKinds,deriveReservationistAskSpans}=await import('../src/ai/worker.js');
 for(const text of ['Please resend the quote Q-123.','Please resend the proposal Q-123.','Please send a copy of our quotation Q-123.']){
  expect(deriveReservationistTaskKinds(text)).toEqual(['existing_document']);
  const asks=deriveReservationistAskSpans(text,'incoming');expect(asks.length).toBe(1);
  const local={...input,requiredTaskKinds:['existing_document'],requiredAskSpans:asks,messages:[{...input.messages[0],text}]};
  const task={id:'doc',kind:'existing_document',required:true,source:{attachmentId:'message:incoming',sourceHash:(await import('node:crypto')).createHash('sha256').update(text).digest('hex'),page:1,start:0,end:text.length,quote:text}};
  const result=await runReservationistRuntime(local,{plan:async()=>({tasks:[task],facts:[]}),execute:async()=>({tasks:[{id:'doc',status:'needs_clarification',guestText:'Please confirm which existing quotation you need.',evidenceRefs:[]}],artifacts:[],quoteRefs:[],packets:[],errors:[],approvedGuestClauses:{doc:'Please confirm which existing quotation you need.'}}),verifyGuestClause:async()=>true});
  expect(result.readiness).toBe('needs_clarification');
 }
 expect(deriveReservationistTaskKinds('Please quote two rooms.')).toEqual(['quote']);
 expect(deriveReservationistTaskKinds('Resend quote Q-123 and quote a new stay.')).toEqual(expect.arrayContaining(['quote','existing_document']));
});

it('retains a structurally proved channel receipt pending without saying the system was updated',async()=>{
 const {prepareReservationistChannelBookingSync}=await import('../src/ai/reservationist-pending-action.js'),{validateDocumentPlan}=await import('../src/ai/reservationist-document-facts.js'),{createHash}=await import('node:crypto');
 const text='Please update your system. Reference CH-123. Arrival 2026-10-12 departure 2026-10-14. Room A: 1 room, 2 adults. Jane Smith room A.',hash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:incoming',sourceHash:hash,disclosure:'guest' as const,pages:[text],pageCount:1,observedAt:input.clock.causalAt},span={attachmentId:source.attachmentId,sourceHash:hash,page:1,quote:text,start:0,end:text.length};
 const factSpan=(quote:string)=>({...span,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length});
 const candidate=[{id:'ref',kind:'reservation_reference',value:'CH-123',disclosure:'guest',source:factSpan('Reference CH-123.')},{id:'dates',kind:'dates',value:{arrival:'2026-10-12',departure:'2026-10-14'},disclosure:'guest',source:factSpan('Arrival 2026-10-12 departure 2026-10-14.')},{id:'room',kind:'room',value:{roomRef:'A',quantity:1,adults:2,childAges:[]},disclosure:'guest',source:factSpan('Room A: 1 room, 2 adults.')},{id:'guest',kind:'guest',value:{firstName:'Jane',lastName:'Smith',roomRef:'A'},disclosure:'guest',source:factSpan('Jane Smith room A.')}];
 const packet=prepareReservationistChannelBookingSync({taskId:'sync',requestId:input.requestId,ownerRef:'mailbox',threadId:'thread',propertyCode:input.propertyCode,taskSource:span,facts:validateDocumentPlan({facts:candidate,tasks:[],unresolvedAsks:[]},[source]).facts,sources:[source],clock:input.clock});
 const result=await runReservationistRuntime({...input,messages:[{...input.messages[0],text}]},{plan:async()=>({tasks:[{id:'sync',kind:'channel_booking_sync',required:true,source:span}],facts:[]}),execute:async()=>({tasks:[{id:'sync',status:'pending_pms_action',guestText:'Your system is updated and booking confirmed.',evidenceRefs:[source.attachmentId]}],packets:[packet],artifacts:[],quoteRefs:[],errors:[],approvedGuestClauses:{}})});
 expect(result.readiness).toBe('pending_pms_action');expect(result.textBody).toContain('channel booking details are prepared for staff review');expect(result.textBody).not.toMatch(/system is updated|booking confirmed|subject to staff completion and availability/);
});
it('does not accept an unproved channel-sync packet merely from a structural boolean',async()=>{
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'sync',kind:'channel_booking_sync',required:true}],facts:[]}),execute:async()=>({tasks:[{id:'sync',status:'pending_pms_action',guestText:'',evidenceRefs:['unproved']}],artifacts:[],quoteRefs:[],packets:[{kind:'channel_booking_sync',taskId:'sync',status:'pending_pms_action',saved:false,businessRulesValidated:true}],errors:[],approvedGuestClauses:{}})})).rejects.toThrow(/channel/);
});


describe('source-scoped recovery readiness',()=>{
 const h=(text:string)=>createHash('sha256').update(text).digest('hex');
 const provenance={reason:'This source contains no stay',taskIds:['quote'],sources:[{attachmentId:'message:incoming',sourceHash:h(input.messages[0].text)}]};
 const onePlan:any={tasks:[plan.tasks[0]],facts:[],factRecoveryProvenance:[provenance]};
 const recovery:any={kind:'unresolved_fact',reason:provenance.reason,disclosure:'staff_only',provenance};
 const oneWork:any={...completed,tasks:[completed.tasks[0]],sourceRecoveries:[recovery]};
 const run=(p:any=onePlan,w:any=oneWork,i:any=input)=>runReservationistRuntime(i,{plan:async()=>structuredClone(p),execute:async()=>structuredClone(w),verifyGuestClause:async()=>true});
 it('retains the diagnostic while admitting a source-validated completed quote',async()=>{const r=await run();expect(r.readiness).toBe('ready_for_staff_review');expect(r.sourceRecoveries).toEqual([recovery]);expect(r.textBody).not.toContain(provenance.reason);});
 it.each(['unscoped','selection','manual','missing_task','unknown_task','wrong_hash','wrong_source','changed_reason','empty_sources','duplicates'])('keeps %s recovery blocking',async key=>{
  const p=structuredClone(onePlan),w=structuredClone(oneWork);
  if(key==='unscoped')delete w.sourceRecoveries[0].provenance;
  if(key==='selection')delete p.factRecoveryProvenance;
  if(key==='manual')w.sourceRecoveries[0].kind='attachment_manual';
  if(key==='missing_task'){w.tasks[0].status='needs_clarification';w.tasks[0].evidenceRefs=[];}
  if(key==='unknown_task'){p.factRecoveryProvenance[0].taskIds=['other'];w.sourceRecoveries[0].provenance.taskIds=['other'];}
  if(key==='wrong_hash')w.sourceRecoveries[0].provenance.sources[0].sourceHash='a'.repeat(64);
  if(key==='wrong_source'){p.factRecoveryProvenance[0].sources[0].attachmentId='foreign';w.sourceRecoveries[0].provenance.sources[0].attachmentId='foreign';}
  if(key==='changed_reason')w.sourceRecoveries[0].reason='Unknown price conflict';
  if(key==='empty_sources'){p.factRecoveryProvenance[0].sources=[];w.sourceRecoveries[0].provenance.sources=[];}
  if(key==='duplicates'){p.factRecoveryProvenance[0].taskIds=['quote','quote'];w.sourceRecoveries[0].provenance.taskIds=['quote','quote'];}
  expect((await run(p,w)).readiness).toBe('needs_clarification');
 });
 it.each(['source','task'])('keeps post-plan %s mutation blocking',async kind=>{
  const p=structuredClone(onePlan),i=structuredClone(input),w=structuredClone(oneWork);
  const r=await runReservationistRuntime(i,{plan:async()=>p,execute:async()=>{if(kind==='source'){i.messages[0].text='Changed request';const next=h(i.messages[0].text);p.factRecoveryProvenance[0].sources[0].sourceHash=next;w.sourceRecoveries[0].provenance.sources[0].sourceHash=next;}else p.tasks[0].source={attachmentId:'changed'};return w;},verifyGuestClause:async()=>true});expect(r.readiness).toBe('needs_clarification');
 });
 it('never overrides blocked quote conflicts or a missing secondary mandatory answer',async()=>{
  const w=structuredClone(oneWork);w.tasks[0].status='blocked';expect((await run(onePlan,w)).readiness).toBe('blocked');
  const p:any={...onePlan,tasks:plan.tasks,factRecoveryProvenance:[{...provenance,taskIds:['quote','transfer']}]};const both:any={...completed,sourceRecoveries:[{...recovery,provenance:p.factRecoveryProvenance[0]}]};expect((await run(p,both)).readiness).toBe('needs_clarification');
 });
 it('keeps unknown attachment and non-business question diagnostics blocking',async()=>{
  const p=structuredClone(onePlan),w=structuredClone(oneWork);p.factRecoveryProvenance[0].sources=[{attachmentId:'doc',sourceHash:'a'.repeat(64)}];w.sourceRecoveries[0].provenance.sources=p.factRecoveryProvenance[0].sources;expect((await run(p,w)).readiness).toBe('needs_clarification');
  p.tasks[0].kind='question';expect((await run(p,w)).readiness).toBe('needs_clarification');
 });
});
