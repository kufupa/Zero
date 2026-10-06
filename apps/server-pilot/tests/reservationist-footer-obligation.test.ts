import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {deriveReservationistAskSpans,deriveReservationistTaskKinds} from '../src/ai/worker.js';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';

const footer='Please contact accounts to confirm banking details. Payment fraud is possible. Please cancel if you are not the intended recipient.';
const at='2026-10-01T10:00:00Z';
describe('original authored requests before a decorated signoff',()=>{
 it.each(['Kind Regards 😊,','Best regards 👍🏽!','Warm regards 🙂','Regards —','Thank you and kind regards 😊,'])('does not derive footer obligations after %s',signoff=>{
  const text='Good day Reservations,\nThank you for your help.\nPlease quote two rooms.\n'+signoff+'\n'+footer;
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote']);
  expect(deriveReservationistAskSpans(text,'m')).toEqual([]);
 });
 it('retains an explicit payment question before a decorated signoff at original offsets',()=>{
  const text='Please quote two rooms. Is the deposit paid?\nKind Regards 😊,\n'+footer;
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);
  const asks=deriveReservationistAskSpans(text,'m');expect(asks.map(ask=>ask.text)).toEqual(['deposit']);
  for(const ask of asks)expect(text.slice(ask.start,ask.end)).toBe(ask.text);
 });
 it('does not cut an active request merely mentioning regards',()=>{
  const text='Regards, please quote two rooms and advise the payment terms?';
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);
  expect(deriveReservationistAskSpans(text,'m').map(ask=>ask.text)).toEqual(['payment']);
 });
 it('keeps an ownership question independent of a following rate request on the same line',()=>{
  const text='Not sure which team owns this client? Please can you assist with corporate rates.';
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);
  const asks=deriveReservationistAskSpans(text,'m');expect(asks.map(ask=>ask.text)).toEqual(['Not sure which team owns this client?']);
  for(const ask of asks)expect(text.slice(ask.start,ask.end)).toBe(ask.text);
 });
 it('rejects a footer coverage obligation before any model call',async()=>{
  const text='Please quote two rooms.\nKind Regards 😊,\n'+footer,start=text.indexOf('Payment'),invoke=vi.fn();
  await expect(extractReservationistPlan({adapter:{invoke,reserveCalls:async()=>{}} as never,messages:[{id:'m',at,direction:'inbound',text}],triggerMessageId:'m',causalAt:at,admissions:[],mode:'task_first',requiredAskSpans:[{sourceId:'message:m',start,end:start+7,text:'Payment'}],signal:new AbortController().signal})).rejects.toThrow('extraction_obligation_binding_invalid');
  expect(invoke).not.toHaveBeenCalled();
 });
 it.each(['combined','task_first'] as const)('passes footer and delegated-intent rules through the actual %s extraction wire',async mode=>{
  const delegated='Please ask the duty manager to consider a company discount for future visits.',rates='What are your room-only rates?',text=delegated+'\n'+rates+'\nKind Regards 😊,\n'+footer,hash=createHash('sha256').update(text).digest('hex');
  const source=(quote:string)=>({attachmentId:'message:m',sourceHash:hash,page:1,quote});
  const tasks=[{id:'handoff',kind:'question',factIds:[],source:source(delegated)},{id:'rates',kind:'quote',factIds:[],source:source(rates)}];
  const invoke=vi.fn(async(request:any)=>({output:JSON.parse(request.userPrompt).selectedTasks!==undefined?{facts:[],assignments:tasks.map(task=>({taskId:task.id,factIds:[]})),unresolvedAsks:[]}:{facts:[],tasks,unresolvedAsks:[]}}));
  const plan=await extractReservationistPlan({adapter:{invoke,reserveCalls:async()=>{}} as never,messages:[{id:'m',at,direction:'inbound',text}],triggerMessageId:'m',causalAt:at,admissions:[],mode,signal:new AbortController().signal});
  const request=(invoke.mock.calls as any)[0][0],prompt=JSON.parse(request.userPrompt);
  expect(request.systemPrompt).toContain('Routine signatures, legal/confidentiality notices and generic fraud or banking warnings do not request hotel work');
  expect(request.systemPrompt).toContain('An affirmative current request to ask, consult or refer a matter to management or another hotel team is a separate question task');
  expect(request.systemPrompt).toContain('Explicitly activated prior requests remain eligible through their existing continuation rules');
  expect(prompt.sources.find((source:any)=>source.attachmentId==='message:m').pages).toEqual([text]);
  expect(prompt.requestSpans.every((candidate:any)=>candidate.source.end<text.indexOf('Kind Regards'))).toBe(true);
  expect(plan.tasks.map(task=>task.kind)).toEqual(['question','quote']);
  for(const task of plan.tasks){expect(task.source.sourceHash).toBe(hash);expect(text.slice(task.source.start,task.source.end)).toBe(task.source.quote);}
 });
});
