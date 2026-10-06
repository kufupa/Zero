import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';
import {createReservationistDependencies} from '../src/ai/reservationist-execution.js';
import {runReservationistRuntime} from '../src/ai/reservationist-runtime.js';
import {runReservationistLocalEvaluation,localEvaluationInputHash} from '../src/ai/reservationist-evaluation-composition.js';

const at='2026-10-01T10:00:00Z',hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
function admission(id:string,mime='application/pdf',text='Nightly ZAR 200.00'){
 const body=mime==='application/pdf'?Buffer.from('%PDF-1.7 synthetic '+id+' '+text):(()=>{const data=Buffer.from(id),chunk=Buffer.alloc(12+data.length);chunk.writeUInt32BE(data.length);chunk.write('tEXt',4);data.copy(chunk,8);return Buffer.concat([png.subarray(0,png.length-12),chunk,png.subarray(png.length-12)]);})(),sha256=hash(body);
 return{status:'admitted',metadata:{attachmentId:id,messageId:'m',ownerRef:'owner',threadId:'thread',messageAt:at,mimeType:mime,sizeBytes:body.length,sourceHash:sha256,disclosure:'guest'},source:{attachmentId:id,sourceHash:sha256,disclosure:'guest',pages:mime==='application/pdf'?[text]:null,pageCount:1},bytes:{body,sha256}};
}
function setup(text='Please accept the offer.\nNightly ZAR 100.00'){
 const admissions=[admission('pdf'),...['image-1','image-2','image-3'].map(id=>admission(id,'image/png'))];
 const source={attachmentId:'message:m',sourceHash:hash(text),page:1,quote:text.split('\n')[0]!};
 const tasks=[{id:'asked',kind:'acceptance',factIds:[],source}];
 const select=()=>({facts:[],tasks:structuredClone(tasks),unresolvedAsks:[]});
 const empty=()=>({facts:[],assignments:tasks.map(t=>({taskId:t.id,factIds:[]})),unresolvedAsks:[]});
 const outputs:(Record<string,unknown>|Error)[]=[select(),empty(),empty(),empty()];
 const reserveCalls=vi.fn(async()=>{}),invoke=vi.fn(async(_request:any)=>{const output=outputs.shift();if(output instanceof Error)throw output;if(!output)throw new Error('Synthetic model response unavailable');return{output,modelId:'gpt-6-luna',usage:{inputTokens:10,outputTokens:10,totalTokens:20,latencyMs:1,estimatedCostUsd:0.00001,rateTableVersion:'synthetic-only'}};});
 const input={adapter:{reserveCalls,invoke},mode:'task_first',factEnrichmentMode:'source_batches',triggerMessageId:'m',messages:[{id:'m',at,text,direction:'inbound'}],causalAt:at,admissions,signal:new AbortController().signal};
 const fact=(id:string,attachmentId:string,quote:string,amount:string)=>{const s=attachmentId==='message:m'?{sourceHash:hash(text),pages:[text]}:input.admissions.find(a=>a.source.attachmentId===attachmentId)!.source;const start=s.pages![0]!.indexOf(quote);return{id,kind:'rate_claim',value:{amount,currency:'ZAR',basis:'nightly'},disclosure:'guest',source:{attachmentId,sourceHash:s.sourceHash,page:1,quote,start,end:start+quote.length}};};
 return{input,outputs,invoke,reserveCalls,tasks,empty,fact};
}
const extract=(s:ReturnType<typeof setup>)=>extractReservationistPlan(s.input as never);
describe('immutable source-batch extraction',()=>{
 it('reserves four once, selects once and sends every media occurrence only in its designated fact batch',async()=>{
  const s=setup(),p:any=await extract(s),calls=s.invoke.mock.calls.map(c=>c[0]);
  expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(4,s.input.signal);expect(s.reserveCalls.mock.invocationCallOrder[0]).toBeLessThan(s.invoke.mock.invocationCallOrder[0]!);
  expect(calls).toHaveLength(4);expect(calls.map(c=>[c.files.length,c.images.length])).toEqual([[1,3],[0,0],[1,0],[0,3]]);
  expect(calls[3].images.map((i:any)=>i.filename)).toEqual(['image-1.png','image-2.png','image-3.png']);
  for(const c of calls.slice(1))expect(JSON.parse(c.userPrompt).selectedTasks).toEqual(p.tasks);
  expect(p.extractionDiagnostics).toMatchObject({mode:'source_batches',plannedPhysicalCalls:4,actualInvokedCalls:4,taskSelection:'completed',batches:[{kind:'messages',status:'completed'},{kind:'pdf',status:'completed'},{kind:'raster',status:'completed'}]});
 });
 it('retains exact original message context while restricting fact schemas to each batch',async()=>{
  const s=setup();await extract(s);const calls=s.invoke.mock.calls.map(c=>c[0]);
  for(const c of calls.slice(1)){const p=JSON.parse(c.userPrompt);expect([...p.sources,...p.contextSources].find((x:any)=>x.attachmentId==='message:m').pages).toEqual([s.input.messages[0]!.text]);expect(p.sourceManifest).toHaveLength(5);expect(c.systemPrompt).toContain('contextSources are not fact sources');}
  expect(JSON.parse(calls[2].userPrompt).sources.map((x:any)=>x.attachmentId)).toEqual(['pdf']);
  const wire=JSON.stringify(calls[2].responseSchema);expect(wire).toContain('pdf');expect(wire).not.toContain('image-1');expect(wire).not.toContain('message:m');
 });
 it('projects strict wire facts and preserves conflicting claims with exact per-batch assignment remapping',async()=>{
  const s=setup();s.outputs[1]={...s.empty(),facts:[s.fact('local','message:m','Nightly ZAR 100.00','100.00')],assignments:[{taskId:'asked',factIds:['local']}]};s.outputs[2]={...s.empty(),facts:[s.fact('local','pdf','Nightly ZAR 200.00','200.00')],assignments:[{taskId:'asked',factIds:['local']}]};
  const p=await extract(s);expect(p.facts.map(f=>f.amountCents)).toEqual([10000,20000]);expect(p.facts.map(f=>f.source.attachmentId)).toEqual(['message:m','pdf']);expect(new Set(p.facts.map(f=>f.id)).size).toBe(2);expect(p.tasks[0]!.factIds).toEqual(p.facts.map(f=>f.id));expect(p.facts.every(f=>f.authority==='customer_claim'&&f.verification==='text_verified')).toBe(true);expect(p.draftReady).toBe(false);
 });
 it('retains immutable source/task provenance for every completed batch diagnostic and selection uncertainty',async()=>{
  const s=setup();(s.outputs[0] as any).unresolvedAsks=['Request scope uncertain'];s.outputs[1]={...s.empty(),unresolvedAsks:['No stay in this source']};s.outputs[2]={...s.empty(),unresolvedAsks:['No stay in this source']};
  const p:any=await extract(s);expect(p.unresolvedAsks).toEqual(['Request scope uncertain','No stay in this source']);
  expect(p.unresolvedDiagnostics).toEqual([{phase:'task_selection',reason:'Request scope uncertain'},...['message:m','pdf'].map(id=>({phase:'fact_enrichment',reason:'No stay in this source',taskIds:['asked'],sources:[{attachmentId:id,sourceHash:id==='message:m'?hash(s.input.messages[0]!.text):s.input.admissions[0]!.source.sourceHash}]}))]);
 });
 it('deduplicates exact same-source claims without losing their task assignments',async()=>{
  const s=setup(),a=s.fact('a','message:m','Nightly ZAR 100.00','100.00');s.outputs[1]={...s.empty(),facts:[a,{...structuredClone(a),id:'b'}],assignments:[{taskId:'asked',factIds:['a','b']}]};const p=await extract(s);expect(p.facts).toHaveLength(1);expect(p.tasks[0]!.factIds).toEqual([p.facts[0]!.id]);
 });
 it.each(['context','wrongpair','unknown_assignment','changed_task','subject_guest'])('fails closed for %s provider claims',async kind=>{
  const s=setup();let f:any=s.fact('local','message:m','Nightly ZAR 100.00','100.00');
  if(kind==='wrongpair')f.source.sourceHash=s.input.admissions[0]!.source.sourceHash;
  if(kind==='subject_guest'){Object.assign(s.input.messages[0]!,{subject:'Alex Example'});f={id:'local',kind:'guest',value:{firstName:'Alex',lastName:'Example'},disclosure:'guest',source:{attachmentId:'message-subject:m',sourceHash:hash('Alex Example'),page:1,quote:'Alex Example'}};}
  const e:any={...s.empty(),facts:[f],assignments:[{taskId:'asked',factIds:[kind==='unknown_assignment'?'missing':'local']}]};if(kind==='changed_task')e.tasks=[{...s.tasks[0],kind:'new_booking'}];s.outputs[kind==='context'?2:1]=e;
  await expect(extract(s)).rejects.toThrow();
 });
 it('stops on incomplete PDF and records failed plus unprocessed sources while retaining only completed claims',async()=>{
  const s=setup();s.outputs[1]={...s.empty(),facts:[s.fact('local','message:m','Nightly ZAR 100.00','100.00')],assignments:[{taskId:'asked',factIds:['local']}]};s.outputs[2]=new Error('azure_luna_completion_incomplete');const p:any=await extract(s);
  expect(s.invoke).toHaveBeenCalledTimes(3);expect(p.facts).toHaveLength(1);expect(p.sourceIncomplete.map((x:any)=>x.attachmentId)).toEqual(['pdf','image-1','image-2','image-3']);expect(p.extractionDiagnostics.batches.map((x:any)=>x.status)).toEqual(['completed','failed','not_attempted']);expect(p.extractionDiagnostics.actualInvokedCalls).toBe(3);expect(p.draftReady).toBe(false);
 });
 it('denies a structured read with retained message reference and unread PDF before any resolver',async()=>{
  const s=setup('What is the status of reservation ABC123?');s.tasks[0]!.kind='question';s.outputs[0]={facts:[],tasks:structuredClone(s.tasks),unresolvedAsks:[]};s.outputs[1]={...s.empty(),facts:[{id:'ref',kind:'reservation_reference',value:'ABC123',disclosure:'guest',source:s.tasks[0]!.source}],assignments:[{taskId:'asked',factIds:['ref']}]};s.outputs[2]=new Error('azure_luna_completion_incomplete');
  const resolveReadTask=vi.fn(async()=>{throw new Error('unsafe_resolver_reached');}),factory=createReservationistDependencies({adapter:s.input.adapter,extractionMode:'task_first',factEnrichmentMode:'source_batches',admissions:s.input.admissions,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'http://synthetic.invalid'},services:{resolveReadTask}} as never);
  const input:any={version:1,requestId:'m',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'m',at},messages:s.input.messages,authorizedArtifacts:s.input.admissions.map(a=>({attachmentId:a.metadata.attachmentId,sourceHash:a.metadata.sourceHash})),clock:{causalAt:at,sourceAt:at,sourceMode:'historical',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
  const r=await runReservationistRuntime(input,{...factory.dependencies,signal:s.input.signal});expect(resolveReadTask).not.toHaveBeenCalled();expect(r.tasks[0]!.status).toBe('needs_clarification');expect(r.readReceipts??[]).toEqual([]);expect(r.preparedFacts??[]).toEqual([]);expect(r.sourceRecoveries?.some(x=>x.reason.includes('source_batch'))).toBe(true);
 });
 it('refuses oversized or inconsistent mode inventory before reservation',async()=>{
  const s=setup();s.input.admissions=Array.from({length:65},(_,i)=>admission('pdf-'+i));await expect(extract(s)).rejects.toThrow('source_batches_inventory_unsupported');expect(s.reserveCalls).not.toHaveBeenCalled();expect(s.invoke).not.toHaveBeenCalled();
 });
 it('chunks all 23 original PDF/raster descriptors into bounded immutable media batches',async()=>{
  const s=setup();s.input.admissions=[...Array.from({length:9},(_,i)=>admission(`pdf-${i}`,'application/pdf',`Original PDF ${i}`)),...Array.from({length:14},(_,i)=>admission(`image-${i}`,'image/png'))];s.outputs.splice(0,s.outputs.length,s.outputs[0],...Array.from({length:5},()=>s.empty()));
  const p:any=await extract(s),calls=s.invoke.mock.calls.map(c=>c[0]);expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(6,s.input.signal);expect(calls.map(c=>[c.files.length,c.images.length])).toEqual([[0,0],[0,0],[8,0],[1,0],[0,8],[0,6]]);
  const sources=p.extractionDiagnostics.batches.flatMap((b:any)=>b.sources).filter((x:any)=>!x.attachmentId.startsWith('message:'));expect(sources).toEqual(s.input.admissions.map(a=>({attachmentId:a.metadata.attachmentId,sourceHash:a.metadata.sourceHash})));expect(JSON.parse(calls[0].userPrompt).sources).toHaveLength(24);
  for(let i=1;i<calls.length;i++){const body=JSON.parse(calls[i].userPrompt);expect(body.sources.map((x:any)=>x.attachmentId)).toEqual(p.extractionDiagnostics.batches[i-1].sources.map((x:any)=>x.attachmentId));expect(body.selectedTasks.map((t:any)=>t.id)).toEqual(['asked']);}
 });
 it.each(['grouped','per_source'])('denies over-eight planned %s calls before reservation without discarding descriptors',async mode=>{
  const s=setup();s.input.admissions=Array.from({length:49},(_,i)=>admission(`raster-${i}`,'image/png'));if(mode==='per_source')(s.input as any).messageBatching='per_source';await expect(extract(s)).rejects.toThrow('source_batches_inventory_unsupported');expect(s.reserveCalls).not.toHaveBeenCalled();expect(s.invoke).not.toHaveBeenCalled();expect(s.input.admissions).toHaveLength(49);
 });
 it('admits exactly eight planned calls and preserves every one of 48 raster source identities',async()=>{
  const s=setup();s.input.admissions=Array.from({length:48},(_,i)=>admission(`image-${i}`,'image/png'));s.outputs.splice(0,s.outputs.length,s.outputs[0],...Array.from({length:7},()=>s.empty()));const p:any=await extract(s);
  expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(8,s.input.signal);expect(s.invoke).toHaveBeenCalledTimes(8);expect(s.invoke.mock.calls.map(c=>c[0].files.length+c[0].images.length)).toEqual([0,0,8,8,8,8,8,8]);expect(p.extractionDiagnostics.batches.flatMap((b:any)=>b.sources).filter((x:any)=>x.attachmentId.startsWith('image-'))).toHaveLength(48);
 });
 it('keeps per-source planning bounded and cannot assign a fact from another PDF chunk',async()=>{
  const s=setup();s.input.admissions=Array.from({length:9},(_,i)=>admission(`pdf-${i}`));(s.input as any).messageBatching='per_source';s.input.messages.push({...s.input.messages[0]!,id:'prior',at:'2026-09-30T10:00:00Z',text:'Earlier context'});s.outputs.splice(0,s.outputs.length,s.outputs[0],...Array.from({length:4},()=>s.empty()));
  const p:any=await extract(s);expect(p.extractionDiagnostics.plannedPhysicalCalls).toBe(5);expect(p.extractionDiagnostics.batches.map((b:any)=>b.sources.length)).toEqual([1,1,8,1]);
  const f=setup();f.input.admissions=Array.from({length:9},(_,i)=>admission(`pdf-${i}`));f.outputs.splice(0,f.outputs.length,f.outputs[0],f.empty(),{...f.empty(),facts:[f.fact('local','pdf-8','Nightly ZAR 200.00','200.00')],assignments:[{taskId:'asked',factIds:['local']}]},f.empty());await expect(extract(f)).rejects.toThrow('source_batch_fact_identity_invalid');
 });
 it('retains every failed and unattempted chunk identity after a completed first PDF chunk',async()=>{
  const s=setup();s.input.admissions=[...Array.from({length:9},(_,i)=>admission(`pdf-${i}`)),...Array.from({length:9},(_,i)=>admission(`raster-${i}`,'image/png'))];s.outputs.splice(0,s.outputs.length,s.outputs[0],s.empty(),s.empty(),new Error('azure_luna_completion_incomplete'));
  const p:any=await extract(s);expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(6,s.input.signal);expect(s.invoke).toHaveBeenCalledTimes(4);expect(p.sourceIncomplete.map((x:any)=>x.attachmentId)).toEqual(['pdf-8',...Array.from({length:9},(_,i)=>`raster-${i}`)]);expect(p.extractionDiagnostics.batches.map((b:any)=>b.status)).toEqual(['completed','completed','failed','not_attempted','not_attempted']);
 });
 it('rejects original byte mutation in the final chunk without returning a successful plan',async()=>{
  const s=setup();s.input.admissions=Array.from({length:9},(_,i)=>admission(`pdf-${i}`));let calls=0;
  s.invoke.mockImplementation(async()=>{if(++calls===4)s.input.admissions[8]!.bytes.body[0]^=1;const output=calls===1?s.outputs[0]:s.empty();if(!output||output instanceof Error)throw new Error('Synthetic model response unavailable');return{output,modelId:'gpt-6-luna',usage:{inputTokens:10,outputTokens:10,totalTokens:20,latencyMs:1,estimatedCostUsd:0.00001,rateTableVersion:'synthetic-only'}};});
  await expect(extract(s)).rejects.toThrow('Original extraction source inventory changed');expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(4,s.input.signal);expect(s.invoke).toHaveBeenCalledTimes(4);
 });
 it('denies aggregate original bytes above 20 MiB before reserving or invoking any chunk',async()=>{
  const s=setup();s.input.admissions=Array.from({length:9},(_,i)=>{const a=admission(`pdf-${i}`),body=Buffer.alloc(3*1024*1024),sha256=hash(body);return{...a,metadata:{...a.metadata,sizeBytes:body.length,sourceHash:sha256},source:{...a.source,sourceHash:sha256},bytes:{body,sha256}};});
  await expect(extract(s)).rejects.toThrow('source_batches_inventory_unsupported');expect(s.reserveCalls).not.toHaveBeenCalled();expect(s.invoke).not.toHaveBeenCalled();expect(s.input.admissions).toHaveLength(9);
 });
 it('preserves manual GIF blocking alongside chunked media through the actual factory',async()=>{
  const s=setup('Please accept the offer.');s.input.admissions=Array.from({length:12},(_,i)=>admission(`image-${i}`,'image/png'));const metadata={...s.input.admissions[0]!.metadata,attachmentId:'original-gif',mimeType:'image/gif',sourceHash:'f'.repeat(64)};(s.input.admissions as any[]).push({status:'manual_required',reason:'unsupported_gif',metadata,draftReady:false});s.outputs.splice(0,s.outputs.length,s.outputs[0],...Array.from({length:3},()=>s.empty()));
  const factory=createReservationistDependencies({adapter:s.input.adapter,extractionMode:'task_first',factEnrichmentMode:'source_batches',admissions:s.input.admissions as never,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'http://synthetic.invalid'},services:{}});
  const input:any={version:1,requestId:'m',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'m',at},messages:s.input.messages,authorizedArtifacts:s.input.admissions.map(a=>a.metadata),clock:{causalAt:at,sourceAt:at,deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
  const r=await runReservationistRuntime(input,factory.dependencies);expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(4,expect.any(AbortSignal));expect(r.readiness).toBe('needs_clarification');expect(r.sourceRecoveries).toContainEqual({kind:'attachment_manual',reason:'unsupported_gif',sourceRef:'original-gif',disclosure:'staff_only'});expect(r.packets).toEqual([]);
 });
 it('denies reservation failure and source mutation with zero successful extraction',async()=>{
  const s=setup();s.reserveCalls.mockRejectedValueOnce(new Error('paid_cumulative_cap_exceeded'));await expect(extract(s)).rejects.toThrow('paid_cumulative_cap_exceeded');expect(s.invoke).not.toHaveBeenCalled();
  const m=setup();m.reserveCalls.mockImplementationOnce(async()=>{m.input.admissions[0]!.bytes.body[0]=0;});await expect(extract(m)).rejects.toThrow('source inventory changed');expect(m.invoke).not.toHaveBeenCalled();
 });
 it('leaves ordinary task-first extraction at two calls when the new mode is absent',async()=>{
  const s=setup();delete(s.input as any).factEnrichmentMode;const p=await extract(s);expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(2,s.input.signal);expect(s.invoke).toHaveBeenCalledTimes(2);expect(p).not.toHaveProperty('extractionDiagnostics');
 });
 it.each(['mode','trigger','causal','deadline'])('rejects mutated %s options after reservation before dispatch',async key=>{
  const s=setup();s.reserveCalls.mockImplementationOnce(async()=>{if(key==='mode')delete(s.input as any).factEnrichmentMode;if(key==='trigger')s.input.triggerMessageId='foreign';if(key==='causal')s.input.causalAt='2026-10-02T10:00:00Z';if(key==='deadline')(s.input as any).deadlineAt=Date.now()+90000;});await expect(extract(s)).rejects.toThrow('source inventory changed');expect(s.invoke).not.toHaveBeenCalled();
 });
 it.each(['metadata_id','page_count','expired'])('denies invalid %s before reserving or invoking',async key=>{
  const s=setup();if(key==='metadata_id')s.input.admissions[0]!.metadata.attachmentId='foreign';if(key==='page_count')s.input.admissions[0]!.source.pageCount=0;if(key==='expired')(s.input as any).deadlineAt=Date.now()-1;await expect(extract(s)).rejects.toThrow();expect(s.reserveCalls).not.toHaveBeenCalled();expect(s.invoke).not.toHaveBeenCalled();
 });
 it.each(['2026-10-02T10:00:00Z','invalid'])('denies noncausal admitted timestamp %s before reservation',async messageAt=>{const s=setup();s.input.admissions[0]!.metadata.messageAt=messageAt;await expect(extract(s)).rejects.toThrow('source_batches_inventory');expect(s.reserveCalls).not.toHaveBeenCalled();expect(s.invoke).not.toHaveBeenCalled();});
 it('wires explicit source batches through the guarded local evaluator without unrelated PMS fixtures',async()=>{
  const s=setup('Is parking available?');s.tasks[0]!.kind='question';s.outputs[0]={facts:[],tasks:structuredClone(s.tasks),unresolvedAsks:[]};s.input.admissions=[];
  const input:any={version:1,requestId:'m',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'m',at},messages:s.input.messages,authorizedArtifacts:[],clock:{causalAt:at,sourceAt:at,sourceMode:'historical',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
  const options:any={input,adapter:s.input.adapter,extractionMode:'task_first',factEnrichmentMode:'source_batches',authorization:{version:'reservationist-local-evaluation-v1',kind:'user_authorized_local_evaluation',authorizationSource:'reservationist-recovery-user-20261004',scope:'local_disposable_evaluation',issuedAt:new Date().toISOString(),inputHash:localEvaluationInputHash(input),pmsWrite:false,emailSend:false,productionDraftWrite:false},budget:{route:{routeId:'synthetic',releaseId:'synthetic',modelId:'gpt-6-luna',purpose:'extraction',provider:'azure-foundry',deployment:'gpt-6-luna'},tokenLimits:{version:'synthetic',maxInputTokens:65536,maxOutputTokens:8192,maxModelCalls:4,reservedUsd:1},cost:{version:'synthetic-only',inputUsdPerMillion:1,outputUsdPerMillion:2}},admissions:[],header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'http://synthetic.invalid'},signal:s.input.signal};
  s.invoke.mockImplementation(async()=>{const output=s.outputs.shift();if(!output||output instanceof Error)throw new Error('Synthetic model response unavailable');return{output,modelId:'gpt-6-luna',provenance:{routeId:'synthetic',modelId:'gpt-6-luna',purpose:'extraction',usageSource:'reported'},usage:{inputTokens:10,outputTokens:10,totalTokens:20,latencyMs:1,estimatedCostUsd:0.00003,rateTableVersion:'synthetic-only'}};});
  const r=await runReservationistLocalEvaluation(options);expect(r.extractionDiagnostics).toMatchObject({mode:'source_batches',plannedPhysicalCalls:2,actualInvokedCalls:2});expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(2,expect.any(AbortSignal));expect(r.runtime.tasks[0]!.status).toBe('needs_clarification');expect(r.historicalTruth).toBe(false);expect(r.productionQualified).toBe(false);
 });
 it('refuses merged overflow without dropping distinct source claims',async()=>{
  const amounts=Array.from({length:33},(_,i)=>`Nightly ZAR ${100+i}.00`),s=setup('Please accept the offer.\n'+amounts.join('\n'));
  const pdfAmounts=Array.from({length:32},(_,i)=>`Nightly ZAR ${200+i}.00`);s.input.admissions[0]=admission('pdf','application/pdf',pdfAmounts.join('\n'));
  for(const [index,id,rows] of [[1,'message:m',amounts],[2,'pdf',pdfAmounts]] as const){const facts=rows.map((quote,i)=>s.fact('local-'+i,id,quote,quote.slice(11)));s.outputs[index]={...s.empty(),facts,assignments:[{taskId:'asked',factIds:facts.map(f=>f.id)}]};}
  await expect(extract(s)).rejects.toThrow('Merged extraction plan exceeds bounds');expect(s.invoke).toHaveBeenCalledTimes(3);
 });
 it.each(['before','reservation','invoke'])('denies abort %s with no successful completion',async phase=>{
  const s=setup(),controller=new AbortController();s.input.signal=controller.signal;if(phase==='before')controller.abort();if(phase==='reservation')s.reserveCalls.mockImplementationOnce(async()=>{controller.abort();});if(phase==='invoke')s.invoke.mockImplementationOnce(async()=>{controller.abort();return{output:{facts:[],tasks:structuredClone(s.tasks),unresolvedAsks:[]},modelId:'gpt-6-luna',usage:{inputTokens:10,outputTokens:10,totalTokens:20,latencyMs:1,estimatedCostUsd:0.00001,rateTableVersion:'synthetic-only'}};});await expect(extract(s)).rejects.toThrow();expect(s.invoke.mock.calls.length).toBe(phase==='invoke'?1:0);
 });
 it('rejects manual reason mutation before dispatch without changing unavailable evidence',async()=>{const s=setup();(s.input.admissions as any[]).push({status:'manual_required',reason:'encrypted_original',metadata:{attachmentId:'manual',sourceHash:'a'.repeat(64)}});s.reserveCalls.mockImplementationOnce(async()=>{(s.input.admissions.at(-1) as any).reason='rewritten';});await expect(extract(s)).rejects.toThrow('source inventory changed');expect(s.invoke).not.toHaveBeenCalled();});
 it('cannot bypass the original abort by replacing its signal during reservation',async()=>{const s=setup(),controller=new AbortController();s.input.signal=controller.signal;s.reserveCalls.mockImplementationOnce(async()=>{controller.abort();s.input.signal=new AbortController().signal;});await expect(extract(s)).rejects.toThrow();expect(s.invoke).not.toHaveBeenCalled();});
});
