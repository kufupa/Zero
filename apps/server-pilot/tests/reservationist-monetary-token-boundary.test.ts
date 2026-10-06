import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';

const at='2026-10-01T12:00:00Z';
const instructions='For embedded rate_claim and payment_claim, ZAR or R must precede the amount. A single ordinary ASCII space may group thousands; nonbreaking/thin grouping spaces and suffix currency tokens are unsupported.';
function input(text:string,invoke:any,mode:'combined'|'task_first'='combined'){
 return {adapter:{invoke,reserveCalls:vi.fn(async()=>{})} as never,mode,messages:[{id:'m',text,at,direction:'inbound' as const}],triggerMessageId:'m',causalAt:at,admissions:[],signal:new AbortController().signal};
}
function source(text:string,quote:string){return{attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote};}

it.each(['combined','task_first'] as const)('preserves unsupported original monetary boundaries and instructs omission in %s',async mode=>{
 const rows=['The budget is 1\u202f587R','The budget is 1587 ZAR','The budget is ZAR 1\u202f587','The budget is ZAR 1 587'];
 const text=['Please quote.',...rows.map(row=>row+'.')].join('\n');let calls=0;
 const task={id:'q',kind:'quote',source:source(text,'Please quote.'),factIds:[]};
 const invoke=vi.fn(async(request:any)=>{
  calls++;const prompt=JSON.parse(request.userPrompt);
  expect(prompt.sources[0].pages).toEqual([text]);
  expect(prompt.unsupportedMonetaryRows.map((hint:any)=>({row:text.slice(hint.start,hint.end),reason:hint.reason}))).toEqual([
   {row:rows[0],reason:'unsupported_original_currency_position'},
   {row:rows[1],reason:'unsupported_original_currency_position'},
   {row:rows[2],reason:'ambiguous_original_amount_token'},
  ]);
  if(mode==='combined'||calls===2){expect(request.systemPrompt).toContain(instructions);expect(request.systemPrompt).toContain('Never rewrite these unsupported original tokens into canonical money facts');}
  return{output:mode==='task_first'&&calls===2?{facts:[],assignments:[{taskId:'q',factIds:[]}],unresolvedAsks:['Unsupported budget token remains unresolved.']}:{facts:[],tasks:[task],unresolvedAsks:[]}};
 });
 const plan=await extractReservationistPlan(input(text,invoke,mode));
 expect(plan.tasks).toHaveLength(1);expect(plan.tasks[0].source.quote).toBe('Please quote.');expect(plan.facts).toEqual([]);
});

it.each(['1\u202f587R','1587 ZAR','ZAR 1\u202f587','R1\u00a0587'])('still rejects canonical rate/payment facts from unsupported token %s',async token=>{
 const text=`Please quote.\nBudget pending payment ${token}.`;
 for(const kind of ['rate_claim','payment_claim'] as const){
  const fact={id:'money',kind,disclosure:'guest',source:source(text,`Budget pending payment ${token}.`),value:{amount:'1587',currency:'ZAR',...(kind==='rate_claim'?{basis:'budget'}:{status:'pending'})}};
  const invoke=async()=>({output:{facts:[fact],tasks:[{id:'q',kind:'quote',source:source(text,'Please quote.'),factIds:['money']}],unresolvedAsks:[]}});
  await expect(extractReservationistPlan(input(text,invoke))).rejects.toThrow('entailed');
 }
});

it.each(['ZAR 1 587','R1 587'])('retains supported ordinary-space groups and their original quote: %s',async token=>{
 const quote=`Budget ${token}.`,text=`Please quote.\n${quote}`;
 const fact={id:'money',kind:'rate_claim',disclosure:'guest',source:source(text,quote),value:{amount:'1587',currency:'ZAR',basis:'budget'}};
 const invoke=async(request:any)=>{expect(JSON.parse(request.userPrompt).unsupportedMonetaryRows).toEqual([]);return{output:{facts:[fact],tasks:[{id:'q',kind:'quote',source:source(text,'Please quote.'),factIds:['money']}],unresolvedAsks:[]}};};
 const plan=await extractReservationistPlan(input(text,invoke));
 expect(plan.facts[0]).toMatchObject({amountCents:158700,source:{quote}});
});
