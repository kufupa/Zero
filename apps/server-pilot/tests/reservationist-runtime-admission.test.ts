import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {runReservationistRuntime,type RuntimeWorkResult} from '../src/ai/reservationist-runtime.js';
const input={version:1 as const,requestId:'r',propertyCode:'HRCEN',trigger:{id:'m',at:'2026-10-04T10:00:00Z'},messages:[{id:'m',at:'2026-10-04T10:00:00Z',direction:'inbound' as const,text:'price'}],authorizedArtifacts:[],clock:{causalAt:'2026-10-04T10:00:00Z',sourceAt:'2026-10-04T10:00:00Z',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false as const,emailSend:false as const}};
const priceClauses:Record<string,string>={price:'Total ZAR 2200.02.'};
const work={tasks:[{id:'price',status:'complete' as const,guestText:'Total ZAR 2200.02.',evidenceRefs:['source']}],approvedGuestClauses:priceClauses,artifacts:[],quoteRefs:[],packets:[],errors:[]} satisfies RuntimeWorkResult;
describe('qualified runtime applies existing literal guard',()=>{
 it('fails hallucinated price even if two work fields agree, requires structured authorized facts',async()=>{
  await expect(runReservationistRuntime(input,{verifyGuestClause:async task=>work.approvedGuestClauses[task.id]===task.guestText,plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>({...work,preparedFacts:[{key:'price',label:'Price',value:{amount:'3000.00',currency:'ZAR'},source:'hms',authority:'authorized',status:'known'}]})})).rejects.toThrow(/assessment/);
 });
});
it('rejects nonexistent artifact metadata without independent byte revalidation',async()=>{
 await expect(runReservationistRuntime(input,{verifyGuestClause:async task=>work.approvedGuestClauses[task.id]===task.guestText,plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>({...work,preparedFacts:[{key:'price',label:'Price',value:{amount:'2200.02',currency:'ZAR'},source:'hms',authority:'authorized',status:'known'}],artifacts:[{ref:'invented',sha256:'a'.repeat(64),sizeBytes:100,fileName:'q.pdf',mimeType:'application/pdf'}],requiredArtifactRefs:['invented']})})).rejects.toThrow(/artifact/);
});
it('cannot silently omit an independently admitted secondary ask',async()=>{
 await expect(runReservationistRuntime({...input,requiredTaskIds:['price','transfer']},{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>work} as any)).rejects.toThrow(/obligation/);
});
it('worker requires purpose-bound released model route before qualified execution',async()=>{
 const {runPreparedWorkerCandidateReply}=await import('../src/ai/worker.js');
 await expect(runPreparedWorkerCandidateReply({requestId:'r',requestText:'price',qualifiedReservationist:{input,dependencies:{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>work}}} as any)).rejects.toThrow(/route/);
},20000);

it('requires trigger itself inbound at causal time and bounded unique messages',async()=>{
 const deps={plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>work};
 await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],direction:'outbound'}]},deps)).rejects.toThrow(/causal/);
 await expect(runReservationistRuntime({...input,messages:[input.messages[0],input.messages[0]]},deps)).rejects.toThrow(/causal/);
 await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],at:'2026-10-03T10:00:00Z'}]},deps)).rejects.toThrow(/causal/);
});

it('independently admitted task kinds cannot be silently omitted by model planning',async()=>{
 await expect(runReservationistRuntime({...input,requiredTaskKinds:['quote','question']},{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>work})).rejects.toThrow(/obligation/);
});

it('rejects self-attested work prose without independent code clause verification',async()=>{
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>({...work,tasks:[{...work.tasks[0],guestText:'Arbitrary unsupported promises'}],approvedGuestClauses:{price:'Arbitrary unsupported promises'}})})).rejects.toThrow(/clause_authority/);
});

it('rejects unbound completed guest work and invalid task states',async()=>{
 const task={id:'policy',status:'complete' as const,guestText:'Parking is available.',evidenceRefs:[]};
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'policy',kind:'question',required:true}],facts:[]}),execute:async()=>({...work,tasks:[task],approvedGuestClauses:{policy:task.guestText}}),verifyGuestClause:async()=>true})).rejects.toThrow(/evidence/);
});
it('binds attachment promises to the particular task PDF rather than an unrelated PDF',async()=>{
 const task={id:'price',status:'complete' as const,guestText:'Please see the attached quotation.',evidenceRefs:['quote:missing']};
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>({...work,tasks:[task],approvedGuestClauses:{price:task.guestText},artifacts:[{ref:'other',sha256:'a'.repeat(64),sizeBytes:10,fileName:'other.pdf',mimeType:'application/pdf'}]}),verifyGuestClause:async()=>true,verifyArtifact:async()=>true})).rejects.toThrow(/attachment_task/);
});
it('independent question coverage includes secondary questions beside a quote',async()=>{
 const {deriveReservationistTaskKinds}=await import('../src/ai/worker.js');
 expect(deriveReservationistTaskKinds('Please quote. Is the pool heated?')).toContain('question');
});
it('requires distinct source-linked question tasks for two independently observed asks',async()=>{
 const text='parking and shuttle';
 const requiredAskSpans=[{sourceId:'message:m',start:0,end:7,text:'parking'},{sourceId:'message:m',start:12,end:19,text:'shuttle'}];
 const source={attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,start:0,end:19,quote:text};
 await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredAskSpans},{plan:async()=>({tasks:[{id:'q',kind:'question',required:true,source}],facts:[]}),execute:async()=>work})).rejects.toThrow(/ambiguous_ask/);
});

it('rejects a source hash forgery even when its task covers the admitted ask text',async()=>{
 const text='Is the pool heated?';
 const ask={sourceId:'message:m',start:7,end:11,text:'pool'};
 const source={attachmentId:'message:m',sourceHash:'a'.repeat(64),page:1,start:0,end:text.length,quote:text};
 let executed=false;
 await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredAskSpans:[ask]},{plan:async()=>({tasks:[{id:'q',kind:'question',required:true,source}],facts:[]}),execute:async()=>{executed=true;return work;}})).rejects.toThrow(/source_binding/);
 expect(executed).toBe(false);
});
it('rejects required ask offsets or text that are absent from the original trigger',async()=>{
 const ask={sourceId:'message:m',start:0,end:4,text:'pool'};
 let planned=false;
 await expect(runReservationistRuntime({...input,requiredAskSpans:[ask]},{plan:async()=>{planned=true;return {tasks:[{id:'q',kind:'question',required:true}],facts:[]};},execute:async()=>work})).rejects.toThrow(/source_binding/);
 expect(planned).toBe(false);
});

it('rejects unsupported confirmation even when work and its clause verifier agree',async()=>{
 const task={id:'price',status:'complete' as const,guestText:'Your rooms have been processed and confirmed.',evidenceRefs:['source']};
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>({...work,tasks:[task],approvedGuestClauses:{price:task.guestText}}),verifyGuestClause:async()=>true})).rejects.toThrow(/completion/);
});

it('does not let two overlapping broad task spans cover parking and shuttle with the same topic',async()=>{
 const text='Is parking available and is there a shuttle?';
 const hash=createHash('sha256').update(text).digest('hex');
 const requiredAskSpans=[{sourceId:'message:m',start:3,end:10,text:'parking'},{sourceId:'message:m',start:36,end:43,text:'shuttle'}];
 const tasks=[0,1].map(start=>({id:`q${start}`,kind:'question',required:true,source:{attachmentId:'message:m',sourceHash:hash,page:1,start,end:text.length,quote:text.slice(start)}}));
 await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredAskSpans},{plan:async()=>({tasks,facts:[]}),execute:async()=>work})).rejects.toThrow(/ambiguous_ask/);
});

it('admits explicitly separate current-read observations while keeping messages causal',async()=>{
 const current={...input,clock:{...input.clock,sourceAt:'2026-10-04T11:00:00Z',sourceMode:'current_read' as const}};
 const deps={plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>({...work,preparedFacts:[{key:'price',label:'Price',value:{amount:'2200.02',currency:'ZAR'},source:'hms' as const,authority:'authorized' as const,status:'known' as const}]}),verifyGuestClause:async()=>true};
 await expect(runReservationistRuntime(current,deps)).resolves.toHaveProperty('readiness','ready_for_staff_review');
 await expect(runReservationistRuntime({...current,clock:{...current.clock,sourceMode:'historical' as const}},deps)).rejects.toThrow(/causal/);
 await expect(runReservationistRuntime({...current,messages:[...current.messages,{id:'future',at:'2026-10-04T11:00:00Z',direction:'outbound',text:'future staff response'}]},deps)).rejects.toThrow(/causal/);
});

it('independent intents distinguish a new booking and retain payment enquiries',async()=>{
 const {deriveReservationistTaskKinds}=await import('../src/ai/worker.js');
 expect(deriveReservationistTaskKinds('Please book a new room for Alex.')).toContain('new_booking');
 expect(deriveReservationistTaskKinds('I accept your quoted offer.')).toContain('acceptance');
 expect(deriveReservationistTaskKinds('Please advise the deposit balance.')).toContain('question');
 expect(deriveReservationistTaskKinds('Please quote a room and advise my reservation status.')).toEqual(expect.arrayContaining(['quote','question']));
});
describe('independent worker obligations retain account, date and document requests',()=>{
 it.each([
  ['Please quote and tell me whether our company can pay on account',['quote','question'],['company can pay on account']],
  ['confirm arrival and departure dates for reservation ABC123',['question'],['arrival','departure']],
  ['resend tax certificate',['existing_document'],['tax certificate']],
  ['send a receipt',['existing_document'],['receipt']],
 ] as const)('derives exact source obligations for %s',async(text,kinds,terms)=>{const {deriveReservationistTaskKinds,deriveReservationistAskSpans}=await import('../src/ai/worker.js');expect(deriveReservationistTaskKinds(text)).toEqual(expect.arrayContaining([...kinds]));const asks=deriveReservationistAskSpans(text,'m');for(const term of terms)expect(asks.some(ask=>ask.text.includes(term))).toBe(true);for(const ask of asks){expect(ask.sourceId).toBe('message:m');expect(text.slice(ask.start,ask.end)).toBe(ask.text);}});
 it.each(['Please quote and tell me whether our company can pay on account','confirm arrival and departure dates for reservation ABC123','resend tax certificate','send a receipt'])('rejects omitted independently sourced obligation for %s before execution',async text=>{const {deriveReservationistTaskKinds,deriveReservationistAskSpans}=await import('../src/ai/worker.js');let executed=false;await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredTaskKinds:deriveReservationistTaskKinds(text),requiredAskSpans:deriveReservationistAskSpans(text,'m')},{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>{executed=true;return work;}})).rejects.toThrow(/obligation/);expect(executed).toBe(false);});
 it('binds a document ask to an existing-document task and its exact original source',async()=>{const text='send a receipt',ask={sourceId:'message:m',start:7,end:14,text:'receipt'},source={attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,start:0,end:text.length,quote:text};const task={id:'document',status:'needs_clarification' as const,guestText:'Please confirm which receipt you need.',evidenceRefs:[]};await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredTaskKinds:['existing_document'],requiredAskSpans:[ask]},{plan:async()=>({tasks:[{id:task.id,kind:'existing_document',required:true,source}],facts:[]}),execute:async()=>({...work,tasks:[task],approvedGuestClauses:{document:task.guestText}}),verifyGuestClause:async()=>true})).resolves.toHaveProperty('readiness','needs_clarification');});
 it('keeps one stay-date inquiry source span and does not invent reads for amendment or booking dates',async()=>{const {deriveReservationistTaskKinds,deriveReservationistAskSpans}=await import('../src/ai/worker.js');const text='confirm arrival and departure dates for reservation ABC123';expect(deriveReservationistAskSpans(text,'m')).toHaveLength(1);for(const mutation of ['Please change reservation ABC123 arrival to 2026-10-12 and departure to 2026-10-14.','Please book a new reservation with arrival 2026-10-12 departure 2026-10-14.']){expect(deriveReservationistTaskKinds(mutation)).not.toContain('question');expect(deriveReservationistAskSpans(mutation,'m')).toEqual([]);}});
 it('a document task cannot substitute for an account payment question',async()=>{const text='Can our company pay on account?',source={attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,start:0,end:text.length,quote:text};const {deriveReservationistAskSpans}=await import('../src/ai/worker.js');await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredAskSpans:deriveReservationistAskSpans(text,'m')},{plan:async()=>({tasks:[{id:'doc',kind:'existing_document',required:true,source}],facts:[]}),execute:async()=>work})).rejects.toThrow(/obligation/);});
});

describe('booking pending readiness requires task-bound validated packets',()=>{
 const task={id:'book',status:'pending_pms_action' as const,guestText:'untrusted confirmation',evidenceRefs:['source']};
 const pendingWork={tasks:[task],approvedGuestClauses:{},artifacts:[],quoteRefs:[],packets:[],errors:[]};
 const run=(kind:string,packets:any[],status:typeof task.status|'complete'|'blocked'|'needs_clarification'='pending_pms_action')=>runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'book',kind,required:true}],facts:[]}),execute:async()=>({...pendingWork,tasks:[{...task,status}],packets}),verifyGuestClause:async()=>true});
 it.each(['acceptance','new_booking'])('rejects pending %s without a packet',async kind=>{
  await expect(run(kind,[])).rejects.toThrow('pending_booking_packet_unproven');
 });
 it.each(['acceptance','new_booking'])('admits one exact %s preparation packet without completion wording',async kind=>{
  const packet={taskId:'book',kind:kind==='acceptance'?'accepted_quote':'new_booking',status:'pending_pms_action',saved:false,businessRulesValidated:true};
  const result=await run(kind,[packet]);expect(result.readiness).toBe('pending_pms_action');expect(result.textBody).not.toContain('untrusted confirmation');
 });
 it('rejects duplicate, mismatched, unbound and unvalidated packets',async()=>{
  const packet={taskId:'book',kind:'new_booking',status:'pending_pms_action',saved:false,businessRulesValidated:true};
  for(const packets of [[packet,packet],[{...packet,taskId:'other'}],[{...packet,kind:'accepted_quote'}],[{...packet,businessRulesValidated:false}],[{...packet,status:'blocked'}],[{...packet,taskId:undefined}],[{...packet,kind:undefined}]])await expect(run('new_booking',packets)).rejects.toThrow(/packet/);
 });
 it('rejects a packet without a matching pending task or a falsely completed booking task',async()=>{
  const packet={taskId:'book',kind:'new_booking',status:'pending_pms_action',saved:false,businessRulesValidated:true};
  await expect(run('quote',[packet])).rejects.toThrow(/packet/);
  await expect(run('new_booking',[packet],'complete')).rejects.toThrow(/packet/);
 });
 it.each(['acceptance','new_booking','change','cancel_request'])('retains a bound blocked %s packet as failure evidence without prepared wording',async kind=>{
  const packet={taskId:'book',kind:kind==='acceptance'?'accepted_quote':kind,status:'blocked',saved:false,businessRulesValidated:false} satisfies RuntimeWorkResult['packets'][number];
  const text='Staff must verify the missing request details.';
  const result=await runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'book',kind,required:true}],facts:[]}),execute:async()=>({...pendingWork,tasks:[{...task,status:'blocked',guestText:text}],approvedGuestClauses:{book:text},packets:[packet]}),verifyGuestClause:async()=>true});
  expect(result.readiness).toBe('blocked');expect(result.packets).toEqual([packet]);expect(result.textBody).not.toContain('request is prepared');
 });
 it('retains a bound clarification packet without upgrading overall readiness to pending',async()=>{
  const packet={taskId:'book',kind:'new_booking',status:'needs_clarification',saved:false,businessRulesValidated:false} satisfies RuntimeWorkResult['packets'][number];
  const text='Please confirm the guest name.';
  const result=await runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'book',kind:'new_booking',required:true}],facts:[]}),execute:async()=>({...pendingWork,tasks:[{...task,status:'needs_clarification',guestText:text}],approvedGuestClauses:{book:text},packets:[packet]}),verifyGuestClause:async()=>true});
  expect(result.readiness).toBe('needs_clarification');expect(result.textBody).not.toContain('request is prepared');
  await expect(run('new_booking',[{...packet,businessRulesValidated:true}],'needs_clarification')).rejects.toThrow(/packet/);
 });
});

describe('ordinary quote coverage preserves requested hold authority',()=>{
 it.each([
 'Please quote single and double rates. Our client requires the provisional bookings to be held for an extended period.',
 'Please quote accommodation. Please advise whether rooms can be held while we market the tour.',
 ])('requires the distinct original hold question: %s',async text=>{
  const {deriveReservationistTaskKinds,deriveReservationistAskSpans}=await import('../src/ai/worker.js');
  expect(deriveReservationistTaskKinds(text)).toEqual(expect.arrayContaining(['quote','question']));
  const asks=deriveReservationistAskSpans(text,'m');expect(asks).toHaveLength(1);
  expect(asks[0].text).toMatch(/held/);expect(text.slice(asks[0].start,asks[0].end)).toBe(asks[0].text);
  let executed=false;await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredTaskKinds:deriveReservationistTaskKinds(text),requiredAskSpans:asks},{plan:async()=>({tasks:[{id:'quote',kind:'quote',required:true,source:{attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length}}],facts:[]}),execute:async()=>{executed=true;return work;}})).rejects.toThrow('required_obligation_omitted');expect(executed).toBe(false);
 });
 it.each(['Please quote accommodation. Please hold the line.','Please quote accommodation. No rooms are to be held.','Please quote accommodation.\nKind Regards\nOur client requires rooms to be held for an extended period.'])('does not invent hold work from unrelated, negated or footer text: %s',async text=>{
  const {deriveReservationistAskSpans}=await import('../src/ai/worker.js');expect(deriveReservationistAskSpans(text,'m')).toEqual([]);
 });
});


it('blocks an omitted source-bound benefit ask before any quote execution',async()=>{
 const {deriveReservationistTaskKinds,deriveReservationistAskSpans}=await import('../src/ai/worker.js');
 const text='Please quote one room. Please explain the accommodation benefits.',asks=deriveReservationistAskSpans(text,'m');let executed=false;
 expect(asks).toHaveLength(1);
 await expect(runReservationistRuntime({...input,messages:[{...input.messages[0],text}],requiredTaskKinds:deriveReservationistTaskKinds(text),requiredAskSpans:asks},{plan:async()=>({tasks:[{id:'price',kind:'quote',required:true}],facts:[]}),execute:async()=>{executed=true;return work;}})).rejects.toThrow(/obligation/);
 expect(executed).toBe(false);
});
