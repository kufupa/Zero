import{describe,it,expect,vi}from'vitest';
import{createHash}from'node:crypto';
import{runReservationistRuntime}from'../src/ai/reservationist-runtime.js';
import{createReservationistDependencies}from'../src/ai/reservationist-execution.js';
import{deriveReservationistTaskKinds,deriveReservationistAskSpans}from'../src/ai/worker.js';
import{extractReservationistPlan}from'../src/ai/reservationist-extraction.js';
import{quoteDigest}from'../src/quote-proposal/quote-revision.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(text='Thank you so much!'){
 const input:any={version:1,requestId:'incoming',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'incoming',at:'2026-10-04T10:00:00Z'},messages:[{id:'incoming',at:'2026-10-04T10:00:00Z',direction:'inbound',text}],requiredTaskKinds:deriveReservationistTaskKinds(text),requiredAskSpans:deriveReservationistAskSpans(text,'incoming'),authorizedArtifacts:[],clock:{causalAt:'2026-10-04T10:00:00Z',sourceAt:'2026-10-04T10:00:00Z',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
 const plan:any={tasks:[],facts:[],noAction:{kind:'no_current_request',modelSelectionCompleted:true,inputDigest:quoteDigest(input),triggerMessageId:'incoming',sourceHash:sha(text)}};
 return{input,plan};
}
describe('source-bound no-action runtime',()=>{
 it('records no action without executing tools or composing a reply',async()=>{const f=fixture(),execute=vi.fn();const result=await runReservationistRuntime(f.input,{plan:async()=>f.plan,execute});expect(result).toMatchObject({readiness:'no_action',tasks:[],artifacts:[],quoteRefs:[],packets:[],textBody:'',htmlBody:'',assessment:{ok:true,coverage:{answered:0,total:0}}});expect(execute).not.toHaveBeenCalled();});
 it.each(['Please quote one room.','Please book one room.','Please reserve one room for one adult from 12 to 14 October 2026.','Kindly make a reservation for one adult tomorrow.','Please arrange accommodation for our delegation.','Please synchronise this channel booking in your hotel system.','Please send our invoice.','Could you confirm the status?','Thank you, please accept this booking.'])('never treats omitted current work as no action: %s',async text=>{const f=fixture(text);await expect(runReservationistRuntime(f.input,{plan:async()=>f.plan,execute:vi.fn()})).rejects.toThrow('no_action_unproven');});
 it.each(['proof','hash','input','facts','unresolved','required_ids','required_artifact','undefined_kinds'])('rejects %s no-action proof gaps',async bad=>{const f=fixture();if(bad==='proof')delete f.plan.noAction;if(bad==='hash')f.plan.noAction.sourceHash='a'.repeat(64);if(bad==='input')f.plan.noAction.inputDigest='a'.repeat(64);if(bad==='facts')f.plan.facts=[{value:'invented'}];if(bad==='unresolved')f.plan.factRecoveryProvenance=[{reason:'missing',taskIds:[],sources:[]}];if(bad==='required_ids')f.input.requiredTaskIds=['required'];if(bad==='required_artifact')f.input.requiredArtifactRefs=['missing'];if(bad==='undefined_kinds')delete f.input.requiredTaskKinds;await expect(runReservationistRuntime(f.input,{plan:async()=>f.plan,execute:vi.fn()})).rejects.toThrow('no_action_unproven');});
 it('rejects input mutation during an otherwise empty model selection',async()=>{const f=fixture();await expect(runReservationistRuntime(f.input,{plan:async()=>{f.input.messages[0].text='Please book';return f.plan;},execute:vi.fn()})).rejects.toThrow('causal_input_changed');});
 it('uses a completed empty selection from the reusable extraction factory',async()=>{const f=fixture(),invoke=vi.fn(async()=>({output:{facts:[],tasks:[],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0,rateTableVersion:'test'}})),factory=createReservationistDependencies({adapter:{invoke,reserveCalls:async()=>{}},admissions:[],header:{},converter:{url:'unused'},services:{},extractionMode:'task_first'} as any);const result=await runReservationistRuntime(f.input,factory.dependencies);expect(result.readiness).toBe('no_action');expect(invoke).toHaveBeenCalledOnce();expect(factory.collectUsage().toolCalls).toBe(0);});
 it('does not convert a failed or unresolved selection to no action',async()=>{const f=fixture();for(const output of [{facts:[],tasks:[],unresolvedAsks:['Missing request']},null]){const factory=createReservationistDependencies({adapter:{reserveCalls:async()=>{},invoke:async()=>{if(!output)throw Error('model failed');return{output,usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0,rateTableVersion:'test'}};}},admissions:[],header:{},converter:{url:'unused'},services:{},extractionMode:'task_first'} as any);await expect(runReservationistRuntime(f.input,factory.dependencies)).rejects.toThrow(output?'No typed tasks':'model failed');}});
 it('recognizes a deferred acknowledgement without activating a prior quote',()=>{const text='Thank you for the quote. I will review it and revert to you on how we would like to proceed.';expect(deriveReservationistTaskKinds(text)).toEqual([]);expect(deriveReservationistTaskKinds(text+' Please send the invoice.')).toContain('existing_document');expect(deriveReservationistTaskKinds('Thank you for the quote. Please proceed.')).toContain('acceptance');});
});


describe('no-action with unrelated unread inline history',()=>{
 function setup(text='Thank you so much!\n________________________________\nFrom: Earlier staff\nPlease see attached [cid:old-logo].'){
  const f=fixture(text),prior={id:'prior',at:'2026-10-03T10:00:00Z',direction:'outbound',text:'Earlier staff signature [cid:old-logo].'};
  f.input.messages.unshift(prior);
  const admissions:any[]=['prior','incoming'].map((messageId,i)=>({status:'manual_required',reason:i?'malformed_raster':'unsupported_business_attachment',metadata:{attachmentId:`inline-${i}`,messageId,threadId:'thread',ownerRef:'owner',messageAt:messageId==='prior'?prior.at:f.input.trigger.at,mimeType:i?'image/jpeg':'application/octet-stream',sizeBytes:20,sourceHash:sha(`original-${i}`),disclosure:'guest',inline:true,contentId:'old-logo'},draftReady:false}));
  f.input.authorizedArtifacts=admissions.map(a=>({...a.metadata}));
  const invoke=vi.fn(async()=>({output:{facts:[],tasks:[],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0,rateTableVersion:'test'}}));
  const options:any={adapter:{invoke,reserveCalls:async()=>{}},admissions,header:{},converter:{url:'unused'},services:{},extractionMode:'task_first'};
  return{...f,admissions,invoke,options};
 }
 it('keeps source-bound manual diagnostics without a tool, reply, packet or artifact',async()=>{
  const f=setup(),factory=createReservationistDependencies(f.options),result=await runReservationistRuntime(f.input,factory.dependencies);
  expect(result).toMatchObject({readiness:'no_action',tasks:[],artifacts:[],quoteRefs:[],packets:[],textBody:'',htmlBody:''});
  expect(result.sourceRecoveries).toEqual(f.admissions.map(a=>({kind:'attachment_manual',reason:a.reason,sourceRef:a.metadata.attachmentId,disclosure:'staff_only',provenance:{reason:a.reason,taskIds:[],sources:[{attachmentId:a.metadata.attachmentId,sourceHash:a.metadata.sourceHash}]}})));
  expect(f.invoke).toHaveBeenCalledOnce();expect(factory.collectUsage().toolCalls).toBe(0);
 });
 it.each(['Please review the attached voucher.\nFrom: Earlier staff','Thank you [cid:current-image].\nFrom: Earlier staff','Thank you so much!'])('does not waive unread current media incorporated or not demonstrably quoted: %s',async text=>{
  const f=setup(text);await expect(runReservationistRuntime(f.input,createReservationistDependencies(f.options).dependencies)).rejects.toThrow();
 });
 it.each(['noninline','foreign_message','wrong_timestamp','missing_cid','unbound_cid','prefix_cid','relevant_unresolved'])('preserves unread business and source boundaries: %s',async bad=>{
  const f=setup();if(bad==='noninline')f.admissions[1].metadata.inline=false;if(bad==='foreign_message')f.admissions[0].metadata.messageId='unknown';if(bad==='wrong_timestamp')f.admissions[0].metadata.messageAt=f.input.trigger.at;
  if(bad==='missing_cid')delete f.admissions[1].metadata.contentId;if(bad==='unbound_cid')f.admissions[1].metadata.contentId='unbound-image';if(bad==='prefix_cid')f.admissions[1].metadata.contentId='old';
  if(bad==='relevant_unresolved')f.invoke.mockImplementation(async()=>({output:{facts:[],tasks:[],unresolvedAsks:['Current attachment needs review']},usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0,rateTableVersion:'test'}}));
  await expect(runReservationistRuntime(f.input,createReservationistDependencies(f.options).dependencies)).rejects.toThrow();
 });
 it('applies the same guard to combined extraction and retains manual reasons',async()=>{const f=setup();const p=await extractReservationistPlan({adapter:f.options.adapter,messages:f.input.messages,triggerMessageId:'incoming',causalAt:f.input.clock.causalAt,admissions:f.admissions,signal:new AbortController().signal});expect(p.noActionSelectionCompleted).toBe(true);expect(p.manualRequired).toEqual(f.admissions.map(a=>a.reason));});
 it('rejects invented no-action diagnostic source hashes',async()=>{const f=setup();f.plan.noAction.inputDigest=quoteDigest(f.input);f.plan.sourceRecoveries=[{kind:'attachment_manual',reason:'malformed',sourceRef:'inline-0',disclosure:'staff_only',provenance:{reason:'malformed',taskIds:[],sources:[{attachmentId:'inline-0',sourceHash:'a'.repeat(64)}]}}];await expect(runReservationistRuntime(f.input,{plan:async()=>f.plan,execute:vi.fn()})).rejects.toThrow('no_action_unproven');});
});
