import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { extractReservationistPlan } from '../src/ai/reservationist-extraction.js';
import {documentPlanSchema} from '../src/ai/reservationist-document-facts.js';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {AzureLunaModelAdapter} from '../src/ai/bedrock/azure-luna.js';
import {assertRevisionSourceFacts} from '../src/ai/reservationist-source-facts.js';
import {syntheticRevision} from './helpers/synthetic-quote-revision.js';

describe('original multiline fact citations', () => {
  const stay = 'Stay from 12 November 2026\n\nthrough 13 November 2026.';
  const text = `Please quote one room for one adult.\n\n${stay}`;
  async function extract(quote: string, requireCopyInstruction = false) {
    const sourceHash = createHash('sha256').update(text).digest('hex');
    const source = {attachmentId:'message:multiline',sourceHash,page:1};
    let call = 0;
    return extractReservationistPlan({adapter:{reserveCalls:async()=>{},invoke:async(request:any)=>{
      if (++call === 1) return {output:{facts:[],tasks:[{id:'quote',kind:'quote',factIds:[],source:{...source,quote:'Please quote one room for one adult.'}}],unresolvedAsks:[]}};
      expect(JSON.parse(request.userPrompt).sources[0].pages[0]).toBe(text);
      if(requireCopyInstruction) expect(request.systemPrompt).toContain('Copy every blank line and indentation between the beginning and end of a multi-line citation');
      return {output:{facts:[{id:'dates',kind:'dates',value:{arrival:'12 November 2026',departure:'13 November 2026'},disclosure:'guest',source:{...source,quote}}],assignments:[{taskId:'quote',factIds:['dates']}],unresolvedAsks:[]}};
    }} as never,mode:'task_first',factEnrichmentMode:'source_batches',triggerMessageId:'multiline',messages:[{id:'multiline',direction:'inbound',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});
  }
  it('instructs exact copying and binds a complete multi-line date citation to the unchanged source', async()=>{
    const plan = await extract(stay,true);
    expect(plan.facts[0]).toMatchObject({value:{arrival:'2026-11-12',departure:'2026-11-13'},source:{quote:stay,start:text.indexOf(stay),end:text.indexOf(stay)+stay.length},verification:'text_verified'});
  });
  it.each([stay.replace('\n\n','\n'),stay.replace('13 November','14 November')])('rejects changed blank lines or date digits without restoring a fabricated citation: %s',async quote=>{
    await expect(extract(quote)).rejects.toThrow('Unverified original text span');
  });
});

describe('qualified extraction', () => {
  it('reads a complete observed-size business message without truncating source offsets', async () => {
    const text = 'Please quote.' + ' '.repeat(34800), sourceHash = createHash('sha256').update(text).digest('hex');
    const source = { attachmentId: 'message:long', sourceHash, page: 1, quote: 'Please quote.', start: 0, end: 13 };
    const invoke = vi.fn(async () => ({ output: { facts: [], tasks: [{ id: 'quote', kind: 'quote', factIds: [], source }], unresolvedAsks: [] } }));
    const plan = await extractReservationistPlan({ adapter: { invoke } as never, messages: [{ id: 'long', at: '2026-10-01T00:00:00Z', text }], causalAt: '2026-10-01T00:00:00Z', admissions: [], signal: new AbortController().signal });
    expect(plan.tasks).toHaveLength(1); expect(invoke).toHaveBeenCalledTimes(1);
    const prompt=JSON.parse((invoke.mock.calls as unknown as [[{ userPrompt: string }]])[0][0].userPrompt);expect(prompt.sources[0].pages[0]).toBe(text);expect(prompt.messages[0]).not.toHaveProperty('text');expect(prompt.triggerMessageId).toBe('long');
  });
  it('keeps an explicit message and aggregate character resource bound before model invocation', async () => {
    const invoke = vi.fn(), base = { adapter: { invoke } as never, causalAt: '2026-10-01T00:00:00Z', admissions: [], signal: new AbortController().signal };
    await expect(extractReservationistPlan({ ...base, messages: [{ id: 'over', at: base.causalAt, text: 'x'.repeat(40001) }] })).rejects.toThrow('bounded');
    await expect(extractReservationistPlan({ ...base, messages: Array.from({ length: 64 }, (_, i) => ({ id: String(i), at: base.causalAt, text: 'x'.repeat(20001) })) })).rejects.toThrow('bounded');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('passes admitted actual PDF bytes, retains uncertainty and never emits authoritative draft prose', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 synthetic');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const mail='Please quote. Is breakfast included?'; const mailHash=createHash('sha256').update(mail).digest('hex');
    const taskSpan=(quote:string)=>({attachmentId:'message:m',sourceHash:mailHash,page:1,quote,start:mail.indexOf(quote),end:mail.indexOf(quote)+quote.length});
    const invoke = vi.fn(async (_request:any) => ({ output: { facts: [], tasks: [{ id: 'q', kind: 'quote', factIds: [],source:taskSpan('Please quote.') }, { id: 'answer', kind: 'question', factIds: [],source:taskSpan('Is breakfast included?') }], unresolvedAsks: ['occupancy'] }, usage: {} }));
    const result = await extractReservationistPlan({ adapter: { invoke } as any, messages: [{ id: 'm', at: '2026-10-01T00:00:00Z', text: mail }], causalAt: '2026-10-01T00:00:00Z', admissions: [{ status: 'admitted', metadata: { attachmentId: 'pdf', mimeType: 'application/pdf', sourceHash: hash }, source: { attachmentId: 'pdf', sourceHash: hash, disclosure: 'guest', pages: null, pageCount: 1 }, bytes: { body: bytes, sha256: hash } }] as any, signal: new AbortController().signal });
    expect(invoke.mock.calls[0]![0].files[0].data).toEqual(bytes);
    expect(result.tasks).toHaveLength(2);
    expect(result.draftReady).toBe(false);
    expect(result).not.toHaveProperty('replyDraft');
  });
  it('rejects valid source span with unrelated model money', async () => {
    const text = 'Nightly ZAR 100.00'; const hash = 'a'.repeat(64);
    const output = { facts: [{ id: 'rate', kind: 'rate_claim', disclosure: 'guest', source: { attachmentId: 's', sourceHash: hash, page: 1, quote: text, start: 0, end: text.length }, value: { amount: '900.00', currency: 'ZAR', basis: 'nightly' } }], tasks: [{ id: 'q', kind: 'quote', factIds: ['rate'],source:{attachmentId:'s',sourceHash:hash,page:1,quote:text,start:0,end:text.length} }], unresolvedAsks: [] };
    await expect(extractReservationistPlan({ adapter: { invoke: async () => ({ output }) } as any, messages: [], causalAt: '2026-10-01T00:00:00Z', admissions: [{ status: 'admitted', source: { attachmentId: 's', sourceHash: hash, disclosure: 'guest', pages: [text], pageCount: 1 }, metadata: { mimeType: 'text/plain' } }] as any, signal: new AbortController().signal })).rejects.toThrow('entailed');
  });

});

it('sends the complete canonical discriminated fact and source schema through the actual SDK wire',async()=>{
  const text='Is parking available?',hash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:m',sourceHash:hash,page:1,quote:text,start:0,end:text.length};
  const candidate={facts:[],tasks:[{id:'q',kind:'question',factIds:[],source}],unresolvedAsks:[]};
  let wire:any;
  const adapter=new AzureLunaModelAdapter({baseURL:'https://synthetic.invalid/openai/v1',apiKey:'synthetic',route:{routeId:'synthetic-extraction',modelId:'gpt-6-luna',purpose:'extraction',protocol:'azure-foundry-responses'},cost:{version:'synthetic',effectiveAt:'2026-10-01T00:00:00Z',inputUsdPerMillion:1,outputUsdPerMillion:2},fetch:async(_url,init)=>{wire=JSON.parse(String(init?.body));return new Response(JSON.stringify({id:'synthetic',object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(candidate),annotations:[]}]}],usage:{input_tokens:100,output_tokens:50,output_tokens_details:{reasoning_tokens:40}}}),{headers:{'content-type':'application/json'}});}});
  await extractReservationistPlan({adapter,messages:[{id:'m',at:'2026-10-04T08:00:00Z',direction:'inbound',text}],causalAt:'2026-10-04T08:00:00Z',admissions:[],signal:new AbortController().signal});
  const schema=wire.text.format.schema;
  const canonical:any=zodToJsonSchema(documentPlanSchema,{$refStrategy:'none'});
  const alternatives=schema.properties.facts.items.anyOf;
  for(const fact of alternatives)expect(fact.properties.source.properties.region).toEqual({type:'array',minItems:4,maxItems:4,items:{type:'number',minimum:0,maximum:1}});
  expect(schema.properties.tasks.items.anyOf[0].properties.source.properties.region).toEqual(alternatives[0].properties.source.properties.region);
  for(const fact of canonical.properties.facts.items.anyOf){fact.properties.source.properties.region.items=fact.properties.source.properties.region.items[0];fact.properties.source.properties.sourceHash.enum=[hash];fact.properties.source.properties.attachmentId.enum=['message:m'];}
  canonical.properties.tasks.items.properties.source.properties.region.items=canonical.properties.tasks.items.properties.source.properties.region.items[0];canonical.properties.tasks.items.properties.source.properties.sourceHash.enum=[hash];canonical.properties.tasks.items.properties.source.properties.attachmentId.enum=['message:m'];
  expect(schema.properties.tasks.items.anyOf[0]).toEqual(canonical.properties.tasks.items);expect(schema.properties.tasks.items.anyOf[1]).toMatchObject({additionalProperties:false,required:['id','kind','factIds','sourceCandidateId'],properties:{sourceCandidateId:{type:'string',enum:['request-1']}}});const original=structuredClone(schema);original.properties.tasks.items=original.properties.tasks.items.anyOf[0];expect(original).toEqual(canonical);
  const visualCandidate=(region:number[])=>({facts:[],tasks:[{id:'scan',kind:'quote',factIds:[],source:{attachmentId:'scan',sourceHash:hash,page:1,region}}],unresolvedAsks:[]});
  expect(documentPlanSchema.safeParse(visualCandidate([0,0,1,1])).success).toBe(true);
  for(const region of [[0,0,1],[0,0,1,1,1],[-0.1,0,1,1],[0,0,1.1,1]])expect(documentPlanSchema.safeParse(visualCandidate(region)).success).toBe(false);
  const party=alternatives.find((fact:any)=>fact.properties.kind.const==='party');
  expect(party.properties.value).toMatchObject({type:'string',minLength:1,maxLength:512});
  const rate=alternatives.find((fact:any)=>fact.properties.kind.const==='rate_claim');
  expect(rate.properties.value).toMatchObject({additionalProperties:false,required:['amount','currency','basis']});
  expect(Object.keys(rate.properties.value.properties)).toEqual(['amount','currency','basis','roomRef']);
  for(const fact of alternatives){expect(fact.additionalProperties).toBe(false);expect(fact.properties.source).toMatchObject({additionalProperties:false,required:['attachmentId','sourceHash','page']});}
  expect(schema.properties.tasks.items.anyOf[0].properties.source).toEqual(party.properties.source);
  const serialized=JSON.stringify(wire);
  expect(serialized).toContain('Use only the explicit room/group ID token');
  expect(serialized).toContain('not inclusion prose such as breakfast included');
  expect(serialized).toContain('Party value is a scalar name string');
  expect(serialized).toContain('extract the literal supported word breakfast with that row as its source');
  expect(serialized).toContain('Preserve every independently explicit room/group board fact');
  expect(serialized).toContain('For scanned sources with pages:null');
  expect(serialized).toContain('omit quote, start and end');
  expect(serialized).toContain('Each task factIds must contain only facts needed for that particular task');
  expect(serialized).toContain('A list of taxes, breakfast options and cancellation policy is three separate question tasks');
  expect(serialized).toContain('A payment mention without an explicit monetary amount is an unresolved fact, never an incomplete payment_claim');
  expect(serialized).toContain('channel_booking_sync');
  expect(serialized).toContain('Do not spend the output allowance on repeated deliberation');
  expect(serialized).toContain('When offsets are omitted, the server can resolve only one unique exact quote');
  expect(serialized).toContain('Source page numbers are one-based: use page:1 for every email message');
  expect(serialized).toContain('Omit yearContext when both date values already contain their explicit year');
  expect(serialized).toContain('A question asking which room options are shown is a question');
  expect(serialized).toContain('Select tasks for the current inbound trigger; earlier requests are context, not fresh obligations');
  expect(serialized).toContain('A requested arrival time is a question, not a change to reservation dates');
  expect(serialized).toContain('Exact customer stay dates can identify the payment target');
  expect(serialized).toContain('An attached voucher mentioned for linkage requires its own question task');
  expect(serialized).toContain('copy-all or reply-all instructions require their own question task');
  expect(documentPlanSchema.safeParse({facts:[{id:'party',kind:'party',disclosure:'guest',source,value:'Group A'},{id:'rate',kind:'rate_claim',disclosure:'guest',source,value:{amount:'1234.56',currency:'ZAR',basis:'nightly'}}],tasks:candidate.tasks,unresolvedAsks:[]}).success).toBe(true);
  expect(documentPlanSchema.safeParse({facts:[{id:'party',kind:'party',disclosure:'guest',source,value:{name:'Group A',type:'group'}}],tasks:candidate.tasks,unresolvedAsks:[]}).success).toBe(false);
  expect(documentPlanSchema.safeParse({facts:[{id:'rate',kind:'rate_claim',disclosure:'guest',source,value:{amount:'1234.56',currency:'ZAR',basis:'nightly',party:'Group A',nights:2,claimType:'customer_claim'}}],tasks:candidate.tasks,unresolvedAsks:[]}).success).toBe(false);
});

it('rejects future context and aborted extraction before approved model call', async () => {
  const invoke = vi.fn(); const controller = new AbortController(); controller.abort();
  await expect(extractReservationistPlan({ adapter: { invoke } as any, messages: [], admissions: [], causalAt: '2026-10-01T00:00:00Z', signal: controller.signal })).rejects.toThrow();
  await expect(extractReservationistPlan({ adapter: { invoke } as any, messages: [{ id: 'future', at: '2026-10-02T00:00:00Z', text: 'later booking' }], admissions: [], causalAt: '2026-10-01T00:00:00Z', signal: new AbortController().signal })).rejects.toThrow('causal');
  expect(invoke).not.toHaveBeenCalled();
});
it('retains staff disclosure and contradicting claims without upgrading authority', async () => {
  const hash = 'b'.repeat(64), text = 'Nightly ZAR 100.00\nNightly ZAR 200.00';
  const facts = ['100.00', '200.00'].map((amount, i) => ({ id: `r${i}`, kind: 'rate_claim', disclosure: 'guest', source: { attachmentId: 's', sourceHash: hash, page: 1, quote: text, start: 0, end: text.length }, value: { amount, currency: 'ZAR', basis: 'nightly' } }));
  const result = await extractReservationistPlan({ adapter: { invoke: async () => ({ output: { facts, tasks: [{ id: 'q', kind: 'quote', factIds: ['r0', 'r1'],source:{attachmentId:'s',sourceHash:hash,page:1,quote:text,start:0,end:text.length} }], unresolvedAsks: ['conflicting rates'] } }) } as any, messages: [], causalAt: '2026-10-01T00:00:00Z', admissions: [{ status: 'admitted', metadata: { mimeType: 'text/plain' }, source: { attachmentId: 's', sourceHash: hash, pages: [text], pageCount: 1, disclosure: 'staff_only' } }] as any, signal: new AbortController().signal });
  expect(result.facts.every(f => f.disclosure === 'staff_only' && f.authority === 'customer_claim')).toBe(true);
  expect(result.unresolvedAsks).toEqual(['conflicting rates']);
});
it('rechecks actual admitted PDF hash before passing file bytes', async () => {
  const hash = 'a'.repeat(64), invoke = vi.fn();
  await expect(extractReservationistPlan({ adapter: { invoke } as any, causalAt: '2026-10-01T00:00:00Z', messages: [], admissions: [{ status: 'admitted', metadata: { mimeType: 'application/pdf', sourceHash: hash }, source: { attachmentId: 's', sourceHash: hash, disclosure: 'guest', pages: null, pageCount: 1 }, bytes: { sha256: hash, body: new TextEncoder().encode('%PDF-changed') } }] as any, signal: new AbortController().signal })).rejects.toThrow('identity');
  expect(invoke).not.toHaveBeenCalled();
});
it('extracts source-bound stay facts directly from causal email without inventing a PDF',async()=>{
 const text='Arrival 2026-10-12 departure 2026-10-14';const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(text).digest('hex');
 const output={facts:[{id:'dates',kind:'dates',disclosure:'guest',source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:text,start:0,end:text.length},value:{arrival:'2026-10-12',departure:'2026-10-14'}}],tasks:[{id:'q',kind:'quote',factIds:['dates'],source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:text,start:0,end:text.length}}],unresolvedAsks:[]};
 const result=await extractReservationistPlan({adapter:{invoke:async()=>({output})} as any,messages:[{id:'m',at:'2026-10-04T10:00:00Z',text}],causalAt:'2026-10-04T10:00:00Z',admissions:[],signal:new AbortController().signal});
 expect(result.facts[0].verification).toBe('text_verified');expect(result.facts[0].authority).toBe('customer_claim');
});

async function extractSyntheticFact(kind: string, value: unknown, text: string, selectedQuote = text, taskKind = 'new_booking') {
  const hash = createHash('sha256').update(text).digest('hex');
  const source = { attachmentId: 'message:synthetic', sourceHash: hash, page: 1, quote: selectedQuote, start: text.indexOf(selectedQuote), end: text.indexOf(selectedQuote) + selectedQuote.length };
  const output = { facts: [{ id: 'f', kind, value, disclosure: 'guest', source }], tasks: [{ id: 'book', kind: taskKind, factIds: ['f'], source }], unresolvedAsks: [] };
  const invoke = vi.fn(async (_request:any) => ({ output }));
  const result = await extractReservationistPlan({ adapter: { invoke } as any, messages: [{ id: 'synthetic', at: '2026-10-04T00:00:00Z', text }], causalAt: '2026-10-04T00:00:00Z', admissions: [], signal: new AbortController().signal });
  return { result, invoke };
}

describe('original guest spelling after model casing changes',()=>{
 it.each([['Alex','Example','ALEX EXAMPLE'],['ALEX','EXAMPLE','Alex Example']])('restores only the uniquely matched original spelling: %s %s',async(firstName,lastName,name)=>{
  const text=`Please quote for ${name}.`,{result}=await extractSyntheticFact('guest',{firstName,lastName},text,name,'quote');
  expect(result.facts[0].value).toEqual({firstName:name.split(' ')[0],lastName:name.split(' ')[1]});
  expect(result.facts[0].source.quote).toBe(name);expect(result.facts[0].source.sourceHash).toBe(createHash('sha256').update(text).digest('hex'));
 });
 it('accepts repeated identical original spelling without choosing between different spellings',async()=>{const text='Please quote for ALEX EXAMPLE. Guest: ALEX EXAMPLE.';const {result}=await extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example'},text,text,'quote');expect(result.facts[0].value).toEqual({firstName:'ALEX',lastName:'EXAMPLE'});});
 it.each(['Please quote for ALEX EXAMPLE and Alex Example.','Please quote for ALEXANDER EXAMPLE.','Please quote for ALEX EXAMPLÉ.','Please quote; not for ALEX EXAMPLE.'])('keeps ambiguous, changed or excluded identity rejected: %s',async text=>{
  await expect(extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example'},text,text,'quote')).rejects.toThrow(/entailed|Ambiguous/);
 });
});

describe('sourced booking extraction', () => {
  async function roomAssistance(text:string,subject:string,subjectAt='2026-10-04T00:00:00Z',messageId='synthetic'){
    const source={attachmentId:`message:${messageId}`,sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};
    return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[],tasks:[{id:'book',kind:'new_booking',factIds:[],source}],unresolvedAsks:[]}})} as any,messages:[{id:messageId,at:subjectAt,direction:'inbound',text,subject}],triggerMessageId:'synthetic',causalAt:'2026-10-04T00:00:00Z',admissions:[],signal:new AbortController().signal});
  }
  it.each([['Kindly assist with 2 room for two of our clients:\nIn: 05 October 2026\nOut: 10 October2026\n-Client One\n-Client Two','Room reservation'],['Please help with three rooms for our guests.','Accommodation booking request']])('accepts current explicit room assistance activated by reservation subject',async(text,subject)=>{
    const result=await roomAssistance(text,subject);expect(result.tasks[0].kind).toBe('new_booking');expect(result.tasks[0].source.attachmentId).toBe('message:synthetic');expect(result.facts).toEqual([]);
  });
  it.each([['Kindly assist with 2 rooms for our clients.','Room availability'],['Kindly assist with 2 rooms for our clients.','Room reservation confirmation'],['Kindly assist with 2 rooms for our clients.','Re: Room reservation'],['Kindly assist with 2 rooms for our clients.','Fwd: Room reservation'],['Please do not assist with 2 rooms for our clients.','Room reservation'],['Could you help with 2 rooms for our clients?','Room reservation'],['Please assist with cleaning 2 rooms for our guests.','Room reservation'],['Please help with 2 rooms for our clients if available.','Room reservation'],['Kindly assist with rates for 2 rooms for our clients.','Room reservation'],['We have 2 rooms for our clients.','Room reservation']])('rejects room assistance without an unambiguous new reservation request: %s / %s',async(text,subject)=>{
    await expect(roomAssistance(text,subject)).rejects.toThrow(/New booking request not entailed/);
  });
  it('does not use a prior message subject to activate current room assistance',async()=>{
    await expect(roomAssistance('Please assist with 2 rooms for our clients.','Room reservation','2026-10-03T00:00:00Z')).rejects.toThrow(/New booking request not entailed/);
  });
  it('does not use a different message subject to activate room assistance',async()=>{
    const text='Please assist with 2 rooms for our clients.',source={attachmentId:'message:synthetic',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};
    await expect(extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[],tasks:[{id:'book',kind:'new_booking',factIds:[],source}],unresolvedAsks:[]}})} as any,messages:[{id:'other',at:'2026-10-04T00:00:00Z',direction:'inbound',text:'Earlier context',subject:'Room reservation'},{id:'synthetic',at:'2026-10-04T00:00:00Z',direction:'inbound',text}],triggerMessageId:'synthetic',causalAt:'2026-10-04T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow(/New booking request not entailed/);
  });
  it.each(['grouped','per_source'] as const)('retains current room assistance in the ordinary task-first %s source path',async batching=>{
    const text='Kindly help with two rooms for our delegates.',subject='Room booking',source={attachmentId:'message:synthetic',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text};
    let calls=0;
    const invoke=vi.fn(async()=>({output:calls++===0?{facts:[],tasks:[{id:'book',kind:'new_booking',factIds:[],source}],unresolvedAsks:[]}:{facts:[],assignments:[{taskId:'book',factIds:[]}],unresolvedAsks:[]}}));
    const result=await extractReservationistPlan({adapter:{invoke,reserveCalls:async()=>{}} as any,mode:'task_first',factEnrichmentMode:'source_batches',...(batching==='per_source'?{messageBatching:'per_source' as const}:{}),messages:[{id:'synthetic',at:'2026-10-04T00:00:00Z',direction:'inbound',text,subject}],triggerMessageId:'synthetic',causalAt:'2026-10-04T00:00:00Z',admissions:[],signal:new AbortController().signal});
    expect(result.tasks[0].kind).toBe('new_booking');expect(result.tasks[0].source).toMatchObject({...source,start:0,end:text.length});expect(result.facts).toEqual([]);
    expect(result.extractionDiagnostics?.batches.every(batch=>batch.status==='completed')).toBe(true);
  });
  it.each(['Please assist with a reservation for the below','Please help me with a booking for two guests','Please reserve one room for one adult.','Kindly make a reservation for one adult tomorrow.','Please arrange accommodation for our delegation.'])('accepts an explicit request for help preparing a reservation: %s',async text=>{
    const hash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:synthetic',sourceHash:hash,page:1,quote:text,start:0,end:text.length};
    const output={facts:[],tasks:[{id:'book',kind:'new_booking',factIds:[],source}],unresolvedAsks:[]};
    const result=await extractReservationistPlan({adapter:{invoke:async()=>({output})} as any,messages:[{id:'synthetic',at:'2026-10-04T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-04T00:00:00Z',admissions:[],signal:new AbortController().signal});
    expect(result.tasks[0]!.kind).toBe('new_booking');
  });
  it.each(['Please do not assist with a reservation for the below','Please assist with a reservation status enquiry','Please help me with a booking confirmation copy','Please do not arrange accommodation for our delegation.'])('rejects help language that is negated or requests an existing record: %s',async text=>{
    const hash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:synthetic',sourceHash:hash,page:1,quote:text,start:0,end:text.length};
    const output={facts:[],tasks:[{id:'book',kind:'new_booking',factIds:[],source}],unresolvedAsks:[]};
    await expect(extractReservationistPlan({adapter:{invoke:async()=>({output})} as any,messages:[{id:'synthetic',at:'2026-10-04T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-04T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow(/New booking request not entailed/);
  });
  it.each(['&','and'])('accepts exactly coordinated given names with a shared surname (%s)',async conjunction=>{
    const text=`Book 1st Room - 2 people (Couple) Guests Alex ${conjunction} Morgan Example.`;
    expect((await extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example'},text)).result.facts[0].value).toEqual({firstName:'Alex',lastName:'Example'});
    expect((await extractSyntheticFact('guest',{firstName:'Morgan',lastName:'Example'},text)).result.facts[0].value).toEqual({firstName:'Morgan',lastName:'Example'});
  });
  it.each([
    'Book guests Alex / Morgan Example.',
    'Book guests Alex Smith and Morgan Example.',
    'Book guests Alex and Morgan Sample.',
    'Book guests Al and Morgan Example.',
    'Book guests Alex and Morgan and Casey Example.',
    'Book guests not Alex and Morgan Example.',
    'Book guests Alex and not Morgan Example.',
    'Book guests previous Alex and Morgan Example.',
  ])('does not infer a coordinated surname from ambiguous or noncurrent names: %s',async text=>{
    await expect(extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example'},text)).rejects.toThrow('entailed');
  });
  it('does not borrow coordinated-name evidence outside the fact source span',async()=>{
    await expect(extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example'},'Book guests Alex and Morgan Example.','Alex')).rejects.toThrow('entailed');
  });
  it.each([
    [{firstName:'Smith',lastName:'Example'},'Book guests Alex Smith and Morgan Example.'],
    [{firstName:'Morgan',lastName:'Example'},'Book guests Alex and Morgan and Casey Example.'],
  ])('does not reinterpret a separately printed surname or longer coordinated list %#',async(value,text)=>{
    await expect(extractSyntheticFact('guest',value,text)).rejects.toThrow('entailed');
  });
  it('does not infer age or room assignment from a coordinated-name row',async()=>{
    const text='Book 1st Room - 2 people (Couple) Guests Alex & Morgan Example.';
    await expect(extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example',age:35},text)).rejects.toThrow('entailed');
    await expect(extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example',roomRef:'1',roomIndex:1},text)).rejects.toThrow('entailed');
  });
  it('extracts exact named guests and publishes the booking vocabulary to the approved model schema', async () => {
    const { result, invoke } = await extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example', roomRef: 'A', roomIndex: 2, profileId: 'P-7', age: 35 }, 'Book Group A, room 2: Alex Example, age 35, profile P-7.');
    expect(result.facts[0].value).toMatchObject({ firstName: 'Alex', lastName: 'Example', roomIndex: 2 });
    const request = invoke.mock.calls[0]![0] as any;
    expect(request.responseSchema.properties.facts.items.anyOf.map((fact:any)=>fact.properties.kind.const)).toEqual(expect.arrayContaining(['guest', 'reservation_reference']));
    expect(request.responseSchema.properties.tasks.items.properties.kind.enum).toContain('new_booking');
    expect(request.systemPrompt).toContain('new_booking');
    expect(result.facts[0].authority).toBe('customer_claim');
  });
  it.each([
    [{ firstName: 'Al', lastName: 'Example' }, 'Book Alex Example.'],
    [{ firstName: 'Alex', lastName: 'Exam' }, 'Book Alex Example.'],
    [{ firstName: 'Alex', lastName: 'Example', roomRef: 'A' }, 'Book Group B: Alex Example.'],
    [{ firstName: 'Alex', lastName: 'Example', roomIndex: 2 }, 'Book room 1: Alex Example, 2 nights.'],
    [{ firstName: 'Alex', lastName: 'Example', age: 35 }, 'Book Alex Example, 35 nights.'],
    [{ firstName: 'Alex', lastName: 'Example', profileId: 'P-7' }, 'Book Alex Example, reference P-7.'],
  ])('rejects guest identity or assignment not exactly entailed %#', async (value, text) => {
    await expect(extractSyntheticFact('guest', value, text)).rejects.toThrow('entailed');
  });
  it('rejects quantity taken from nights instead of rooms', async () => {
    await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [], quantity: 2 }, 'Book Group A: 1 adult, 2 nights.')).rejects.toThrow('entailed');
    expect((await extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [], quantity: 2 }, 'Book Group A: 2 rooms, 1 adult each.')).result.facts[0].value).toMatchObject({ quantity: 2 });
  });
  it('requires exact reservation references rather than a matching substring', async () => {
    expect((await extractSyntheticFact('reservation_reference', 'R-42', 'Book against reservation R-42.')).result.facts[0].value).toBe('R-42');
    await expect(extractSyntheticFact('reservation_reference', 'R-4', 'Book against reservation R-42.')).rejects.toThrow('entailed');
  });
  it('allows code-normalized named-month source dates without trusting model calendar guesses', async () => {
    const { result } = await extractSyntheticFact('dates', { arrival: '2026-10-12', departure: '2026-10-14' }, 'Book arrival 12 October 2026 departure 14 October 2026.');
    expect(result.facts[0].value).toEqual({ arrival: '2026-10-12', departure: '2026-10-14' });
  });
});

it('binds a room quantity to its own source room rather than another group', async () => {
  await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [], quantity: 2 }, 'Book Group A: 1 room, 1 adult.\nGroup B: 2 rooms, 1 adult each.')).rejects.toThrow('entailed');
});
it('binds guest room assignment to the named guest source row rather than another guest', async () => {
  await expect(extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example', roomRef: 'A', roomIndex: 2 }, 'Book Group A, room 1: Alex Example.\nGroup A, room 2: Morgan Sample.')).rejects.toThrow('entailed');
});

it('does not cross-associate multiple room quantities within a single source row', async () => {
  await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [], quantity: 2 }, 'Book Group A: 1 room, 1 adult, Group B: 2 rooms, 1 adult each.')).rejects.toThrow('entailed');
});
it('does not cross-associate guest room assignments within a single source row', async () => {
  await expect(extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example', roomRef: 'A', roomIndex: 2 }, 'Book Group A, room 1: Alex Example, Group A, room 2: Morgan Sample.')).rejects.toThrow('entailed');
});

it('refuses to turn a quote-only ask into a new booking task', async () => {
  await expect(extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example' }, 'Please quote for Alex Example.')).rejects.toThrow('booking request');
});
it('does not treat explicit prior quote acceptance as a new booking task', async () => {
  await expect(extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example' }, 'I accept your prior quote. Please book for Alex Example.')).rejects.toThrow('booking request');
});

it('does not prepare a new booking from an explicitly negated booking instruction', async () => {
  await expect(extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example' }, 'Do not book for Alex Example; please quote first.')).rejects.toThrow('booking request');
});


describe('rate intent preservation', () => {
  it.each([
    ['budget', 'Book with a budget of ZAR 1 560.00 per night.'],
    ['budget', 'Book around ZAR 1 560.00 per night.'],
    ['unknown', 'Book for ZAR 1 560.00.'],
    ['unknown', 'Book for ZAR 1 560.00 nightly or total, please clarify.'],
  ] as const)('retains %s without manufacturing an exact rate basis', async (basis, text) => {
    const { result } = await extractSyntheticFact('rate_claim', { amount: '1560.00', currency: 'ZAR', basis }, text);
    expect(result.facts[0]).toMatchObject({ authority: 'customer_claim', amountCents: 156000, value: { basis } });
  });
  it.each(['Book with dinner capped at ZAR 250.00.','Book with dinner cap of ZAR 250.00.'])('preserves an explicit capped amount as a ceiling: %s',async text=>{const {result}=await extractSyntheticFact('rate_claim',{amount:'250.00',currency:'ZAR',basis:'ceiling'},text);expect(result.facts[0]).toMatchObject({kind:'rate_claim',amountCents:25000,value:{basis:'ceiling'}});});
  it('does not turn a capped amount into an exact nightly agreement',async()=>{await expect(extractSyntheticFact('rate_claim',{amount:'250.00',currency:'ZAR',basis:'nightly'},'Dinner capped at ZAR 250.00 per night.')).rejects.toThrow('entailed');});
  it.each(['nightly', 'total', 'ceiling', 'adr'] as const)('does not upgrade a budget to %s agreement', async basis => {
    await expect(extractSyntheticFact('rate_claim', { amount: '1560.00', currency: 'ZAR', basis }, 'Book with a budget of ZAR 1560.00 nightly, total maximum ADR.')).rejects.toThrow('entailed');
  });
  it('does not associate nightly meaning from another monetary source row', async () => {
    await expect(extractSyntheticFact('rate_claim', { amount: '1560.00', currency: 'ZAR', basis: 'nightly' }, 'Book with a budget of ZAR 1560.00. Nightly ZAR 1800.00.')).rejects.toThrow('entailed');
  });
});


describe('original semantic source rows', () => {
  it.each([
    ['Book maximum ZAR 1560.00 per night.', 'nightly'],
    ['Book ZAR 1560.00 nightly or total, please clarify.', 'nightly'],
    ['Book ZAR 1560.00 nightly or total, please clarify.', 'total'],
  ])('rejects source intent upgrade %s to %s', async (text, basis) => {
    await expect(extractSyntheticFact('rate_claim', { amount: '1560.00', currency: 'ZAR', basis }, text)).rejects.toThrow('entailed');
  });
  it.each(['Book with a budget of ZAR 1560.00 per night.', 'Book; not ZAR 1560.00 per night.'])('does not let a narrower span remove the original monetary qualifier %s', async text => {
    await expect(extractSyntheticFact('rate_claim', { amount: '1560.00', currency: 'ZAR', basis: 'nightly' }, text, 'ZAR 1560.00 per night')).rejects.toThrow('entailed');
  });
  it('binds adults to the exact group row', async () => {
    await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 2, childAges: [], quantity: 1 }, 'Book Group A: 1 room, 1 adult. Group B: 1 room, 2 adults.')).rejects.toThrow('entailed');
  });
  it('does not use duration as a child age', async () => {
    await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [12], quantity: 1 }, 'Book Group A: 1 room, 1 adult, 12 nights.')).rejects.toThrow('entailed');
    expect((await extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [12], quantity: 1 }, 'Book Group A: 1 room, 1 adult, child aged 12.')).result.facts[0].value).toMatchObject({ childAges: [12] });
  });
  it.each([
    'Book; payment paid ZAR 200.00; accommodation ZAR 1560.00 per night.',
    'Book; deposit due ZAR 1560.00.',
    'Book; payment not paid ZAR 1560.00.',
  ])('does not manufacture a paid claim from unrelated or negated money %s', async text => {
    await expect(extractSyntheticFact('payment_claim', { amount: '1560.00', currency: 'ZAR', status: 'claimed_paid' }, text)).rejects.toThrow('entailed');
  });
  it('retains actually sourced paid and requested payment claims distinctly', async () => {
    for (const [status, text] of [['claimed_paid', 'Book; I paid ZAR 1560.00.'], ['requested', 'Book; deposit due ZAR 1560.00.']] as const)
      expect((await extractSyntheticFact('payment_claim', { amount: '1560.00', currency: 'ZAR', status }, text)).result.facts[0]).toMatchObject({ value: { status }, authority: 'customer_claim' });
  });
});


it('does not omit explicit child ages from a quoted room allocation', async () => {
  await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [] }, 'Book Group A: 1 adult, child aged 7.')).rejects.toThrow('entailed');
});
it('retains all explicit ages from a children list on the same allocation', async () => {
  const value = { roomRef: 'A', adults: 1, childAges: [7, 12], quantity: 1 };
  expect((await extractSyntheticFact('room', value, 'Book Group A: 1 room, 1 adult, 2 children aged 7 and 12.')).result.facts[0].value).toEqual(value);
});
it('does not extract an included board from explicit exclusion', async () => {
  await expect(extractSyntheticFact('board', 'breakfast', 'Book room only, no breakfast.')).rejects.toThrow('entailed');
});
it('does not let a narrowed booking task remove a negated original instruction', async () => {
  await expect(extractSyntheticFact('guest', { firstName: 'Alex', lastName: 'Example' }, 'Do not book for Alex Example.', 'book for Alex Example')).rejects.toThrow('booking request');
});


it('does not omit explicit physical room quantity from extracted allocation', async () => {
  await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [] }, 'Book Group A: 2 rooms, 1 adult each.')).rejects.toThrow('entailed');
});
it('does not interpret an explicit number of children with missing ages as zero children', async () => {
  await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [] }, 'Book Group A: 1 adult and 2 children.')).rejects.toThrow('entailed');
});
it('does not omit a child when the source count differs from the supplied ages', async () => {
  await expect(extractSyntheticFact('room', { roomRef: 'A', adults: 1, childAges: [7] }, 'Book Group A: 1 adult and 2 children, child aged 7.')).rejects.toThrow('entailed');
});


it('does not let a narrowed board span remove postposed exclusion', async () => {
  await expect(extractSyntheticFact('board', 'breakfast', 'Breakfast is not included; please book room only.', 'Breakfast', 'quote')).rejects.toThrow('entailed');
});

it('extracts an existing quote reference independently of reservation identity and refuses prefix laundering',async()=>{
 const {result,invoke}=await extractSyntheticFact('document_reference','Q-123','Please resend the quote Q-123.','Please resend the quote Q-123.','existing_document');
 expect(result.facts[0]).toMatchObject({kind:'document_reference',value:'Q-123',verification:'text_verified'});
 expect((invoke.mock.calls[0]![0] as any).responseSchema.properties.facts.items.anyOf.map((fact:any)=>fact.properties.kind.const)).toContain('document_reference');
 await expect(extractSyntheticFact('document_reference','Q-123','Please resend the quote Q-1234.','Please resend the quote Q-1234.','existing_document')).rejects.toThrow(/entailed/);
 await expect(extractSyntheticFact('document_reference','Q-123','Please resend receipt Q-123.','Please resend receipt Q-123.','existing_document')).rejects.toThrow(/entailed/);
});

it('cannot classify a narrowed reference as a prior quote when its original request asks for a new quotation',async()=>{
 await expect(extractSyntheticFact('document_reference','Q-123','Attach a new quotation Q-123.','quotation Q-123','existing_document')).rejects.toThrow(/entailed/);
});

it('extracts board only with an explicit same-row group association',async()=>{
 const result=await extractSyntheticFact('board',{board:'Room Only R',roomRef:'A'},'Please quote Group A: Room Only R; Group B: Bed & Breakfast R.','Group A: Room Only R','quote');
 expect(result.result.facts[0].value).toEqual({board:'Room Only R',roomRef:'A'});
});
it.each([
 [{board:'breakfast',roomRef:'A'},'Please quote Group A: room only; Group B: breakfast.','breakfast'],
 [{board:'breakfast',roomRef:'A'},'Please quote breakfast.','breakfast'],
 [{board:'breakfast',roomRef:'A'},'Please quote Group AB: breakfast.','Group AB: breakfast'],
 [{board:'breakfast',roomRef:'A'},'Please quote Group A: breakfast not included.','Group A: breakfast'],
 [{board:'breakfast',roomRef:'A'},'Please quote Group A room only, Group B breakfast.','Group A room only, Group B breakfast'],
])('rejects scoped board group laundering %#',async(value,text,selected)=>{await expect(extractSyntheticFact('board',value,text,selected,'quote')).rejects.toThrow();});

describe('original board alias negation',()=>{
  const labels=['room_only','breakfast','dinner_bed_breakfast','Room Only R','Bed & Breakfast R','Dinner Bed & Breakfast R','room only','bed and breakfast','bed & breakfast','dinner bed and breakfast','dinner bed & breakfast'];
  it.each([
    ['room only','Room Only R'],
    ['bed and breakfast','Bed & Breakfast R'],
  ])('binds an affirmative %s alias to the actual native revision',async(board,native)=>{
    const {result}=await extractSyntheticFact('board',{board,roomRef:'g1'},`Please quote Group g1: ${board}.`,undefined,'quote');
    const revision=await syntheticRevision(['100.00'],native);
    expect(()=>assertRevisionSourceFacts(result.facts,revision)).not.toThrow();
  });
  it.each([
    ['room only','Please quote Group g1: not room only; bed and breakfast.','Group g1: not room only'],
    ['bed and breakfast','Please quote Group g1: not bed and breakfast; room only.','Group g1: not bed and breakfast'],
    ['room only','Please quote Group g1: not room only, bed and breakfast.','room only'],
    ['bed & breakfast','Please quote Group g1: no bed & breakfast.','bed & breakfast'],
    ['dinner bed and breakfast','Please quote Group g1: without dinner bed and breakfast.','dinner bed and breakfast'],
    ['Room Only R','Please quote Group g1: excluding Room Only R.','Room Only R'],
  ])('rejects the exact negated alias %s even in a narrowed span',async(board,text,selected)=>{
    await expect(extractSyntheticFact('board',{board,roomRef:'g1'},text,selected,'quote')).rejects.toThrow('entailed');
  });
  it('does not treat an unrelated negation as exclusion of an affirmative board',async()=>{
    const {result}=await extractSyntheticFact('board',{board:'room only',roomRef:'g1'},'Please quote Group g1: not cancelled, room only.','room only','quote');
    expect(result.facts[0].value).toEqual({board:'room only',roomRef:'g1'});
  });
  it.each(labels)('retains an affirmative exact scoped label %s without treating it as a room identifier',async board=>{
    const {result}=await extractSyntheticFact('board',{board,roomRef:'g1'},`Please quote Group g1: ${board}.`,undefined,'quote');
    expect(result.facts[0].value).toEqual({board,roomRef:'g1'});
  });
  it.each(labels)('rejects a postposed exclusion of %s from its original row',async board=>{
    await expect(extractSyntheticFact('board',{board,roomRef:'g1'},`Please quote Group g1: ${board} is not required.`,board,'quote')).rejects.toThrow('entailed');
  });
  it.each(labels)('rejects an unscoped %s span that omits the original negation',async board=>{
    await expect(extractSyntheticFact('board',board,`Please quote Group g1: not ${board}.`,board,'quote')).rejects.toThrow('entailed');
  });
});


describe('unique original source quote offset resolution',()=>{
 const at='2026-10-01T00:00:00Z';
 function extract(text:string,span:Record<string,unknown>={}){
  const source={attachmentId:'message:unique',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:'Please quote.',...span};
  return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[],tasks:[{id:'q',kind:'quote',factIds:[],source}],unresolvedAsks:[]}})} as never,messages:[{id:'unique',at,text}],causalAt:at,admissions:[],signal:new AbortController().signal});
 }
 it('resolves omitted offsets from one exact original quote without changing evidence',async()=>{
  const result=await extract('Intro. Please quote. End.');expect(result.tasks[0].source).toMatchObject({quote:'Please quote.',start:7,end:20});
 });
 it('refuses ambiguous or nonmatching quote and preserves explicit incorrect offsets',async()=>{
  await expect(extract('Please quote. Please quote.')).rejects.toThrow(/span|ambiguous/);
  await expect(extract('Please reserve.')).rejects.toThrow(/span|unverified/i);
  await expect(extract('Intro. Please quote.',{start:0,end:13})).rejects.toThrow(/span/i);
 });
});


it.each(['Not ', 'Previous cancelled guest: '])('rejects narrowed guest identity with original noncurrent qualifier %s',async qualifier=>{
 await expect(extractSyntheticFact('guest',{firstName:'Jane',lastName:'Smith',roomRef:'A'},`${qualifier}Guest Jane Smith room A.`,'Guest Jane Smith room A.','quote')).rejects.toThrow('entailed');
});

it('passes admitted raster bytes with region-only source provenance and rejects mutated bytes before the model',async()=>{
 const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')),hash=createHash('sha256').update(png).digest('hex'),source={attachmentId:'raster',sourceHash:hash,page:1,region:[0,0,1,1]},output={facts:[],tasks:[{id:'q',kind:'quote',factIds:[],source}],unresolvedAsks:[]},invoke=vi.fn(async()=>({output}));
 const admission:any={status:'admitted',metadata:{attachmentId:'raster',mimeType:'image/png',sourceHash:hash},source:{attachmentId:'raster',sourceHash:hash,pages:null,pageCount:1,disclosure:'guest'},bytes:{body:png,sha256:hash}};
 const options={adapter:{invoke} as never,messages:[],causalAt:'2026-10-01T00:00:00Z',admissions:[admission],signal:new AbortController().signal};
 const result=await extractReservationistPlan(options);expect(result.tasks[0].source.region).toEqual([0,0,1,1]);expect((invoke.mock.calls as unknown as [[any]])[0][0].images[0].data).toEqual(png);expect((invoke.mock.calls as unknown as [[any]])[0][0].files).toEqual([]);
 const changed=structuredClone(admission);changed.bytes.body[20]^=1;await expect(extractReservationistPlan({...options,admissions:[changed]})).rejects.toThrow('identity');expect(invoke).toHaveBeenCalledTimes(1);
});

it.each(['Arrival 12 October 2026 departure 17 October 2026, not 11-16 October 2026.','Do not quote 11-16 October 2026.'])('rejects excluded or contradictory shared calendar range in its original row: %s',async text=>{
 const quote='11-16 October 2026',hash=createHash('sha256').update(text).digest('hex'),span={attachmentId:'message:range',sourceHash:hash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length};
 const output={facts:[{id:'dates',kind:'dates',disclosure:'guest',source:span,value:{arrival:'2026-10-11',departure:'2026-10-16'}}],tasks:[{id:'q',kind:'quote',factIds:['dates'],source:{...span,quote:text,start:0,end:text.length}}],unresolvedAsks:[]};
 await expect(extractReservationistPlan({adapter:{invoke:async()=>({output})} as never,messages:[{id:'range',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow();
});

it('extracts ten legitimate causal media sources in bounded batches and merges only identical task spans',async()=>{
 const bytes=new Uint8Array(Buffer.from('%PDF-1.7 synthetic batching control')),sha=createHash('sha256').update(bytes).digest('hex'),text='Please quote.',mailHash=createHash('sha256').update(text).digest('hex'),span={attachmentId:'message:batch',sourceHash:mailHash,page:1,quote:text,start:0,end:text.length};
 const admissions=Array.from({length:10},(_,i)=>({status:'admitted',metadata:{attachmentId:`batch${i}`,mimeType:'application/pdf',sourceHash:sha},source:{attachmentId:`batch${i}`,sourceHash:sha,disclosure:'guest',pages:['Nightly ZAR 100.00'],pageCount:1},bytes:{body:bytes,sha256:sha}}));
 let calls=0;const invoke=vi.fn(async(request:any)=>{calls++;expect(request.files.length).toBeLessThanOrEqual(8);const sources=JSON.parse(request.userPrompt).sources.filter((s:any)=>!s.attachmentId.startsWith('message:'));return{output:{facts:sources.map((s:any,i:number)=>({id:`f${i}`,kind:'rate_claim',disclosure:'guest',source:{attachmentId:s.attachmentId,sourceHash:s.sourceHash,page:1,quote:'Nightly ZAR 100.00',start:0,end:18},value:{amount:'100.00',currency:'ZAR',basis:'nightly'}})),tasks:[{id:'q',kind:'quote',factIds:sources.map((_:any,i:number)=>`f${i}`),source:span}],unresolvedAsks:[]}};});
 const result=await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'batch',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal});
 expect(calls).toBe(2);expect(invoke.mock.calls.map(([r])=>r.files.length)).toEqual([8,2]);expect(result.facts).toHaveLength(10);expect(result.tasks).toHaveLength(1);expect(new Set(result.facts.map(f=>f.id)).size).toBe(10);expect(result.tasks[0].factIds).toHaveLength(10);expect(result.draftReady).toBe(false);
});

it('denies final-batch source mutation and preserves an independent mail ask after a later batch fails',async()=>{
 const body=new Uint8Array(Buffer.from('%PDF-1.7 synthetic batch partial')),sha=createHash('sha256').update(body).digest('hex'),text='Is parking available?',h=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:partial',sourceHash:h,page:1,quote:text,start:0,end:text.length};
 const make=()=>Array.from({length:10},(_,i)=>({status:'admitted',metadata:{attachmentId:`p${i}`,mimeType:'application/pdf',sourceHash:sha},source:{attachmentId:`p${i}`,sourceHash:sha,disclosure:'guest',pages:['source'],pageCount:1},bytes:{body:new Uint8Array(body),sha256:sha}}));
 for(const kind of ['mutate','mutate_throw','fail']){const admissions=make();let calls=0;const adapter={invoke:async()=>{calls++;if(calls===2){if(kind==='mutate'||kind==='mutate_throw')admissions[9].bytes.body[8]^=1;if(kind!=='mutate')throw new Error('later batch failed');}return{output:{facts:[],tasks:[{id:'parking',kind:'question',factIds:[],source}],unresolvedAsks:[]}};}};
 const options={adapter:adapter as never,messages:[{id:'partial',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal};
 if(kind==='mutate'||kind==='mutate_throw')await expect(extractReservationistPlan(options)).rejects.toThrow('Batched source inventory changed');
 else{const result=await extractReservationistPlan(options);expect(result.tasks).toHaveLength(1);expect(result.tasks[0].source).toEqual(source);expect(result.sourceIncomplete).toHaveLength(2);expect(result.manualRequired).toContain('attachment_batch_unavailable');expect(calls).toBe(2);}
 }
});

it('rejects conflicting task kinds for the exact same original span across media batches',async()=>{
 const body=new Uint8Array(Buffer.from('%PDF-1.7 synthetic batch conflict')),sha=createHash('sha256').update(body).digest('hex'),text='Which room options?',h=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:conflict',sourceHash:h,page:1,quote:text,start:0,end:text.length},admissions=Array.from({length:10},(_,i)=>({status:'admitted',metadata:{attachmentId:`c${i}`,mimeType:'application/pdf',sourceHash:sha},source:{attachmentId:`c${i}`,sourceHash:sha,disclosure:'guest',pages:['source'],pageCount:1},bytes:{body:new Uint8Array(body),sha256:sha}}));let calls=0;
 await expect(extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[],tasks:[{id:'t',kind:++calls===1?'question':'quote',factIds:[],source}],unresolvedAsks:[]}})} as never,messages:[{id:'conflict',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal})).rejects.toThrow('Conflicting batched task source');
});

it('recovers only exact independent current email questions after the first media call fails without dispatching again',async()=>{
 const body=Buffer.from('%PDF-1.7 synthetic first failure'),sha=createHash('sha256').update(body).digest('hex'),text='Is parking available? Please quote Group A.\nFrom: Earlier customer\nIs transfer available?',h=createHash('sha256').update(text).digest('hex'),admissions=Array.from({length:10},(_,i)=>({status:'admitted',metadata:{attachmentId:`first${i}`,mimeType:'application/pdf',sourceHash:sha},source:{attachmentId:`first${i}`,sourceHash:sha,disclosure:'guest',pages:['source'],pageCount:1},bytes:{body:Buffer.from(body),sha256:sha}}));const invoke=vi.fn(async()=>{throw new Error('synthetic_model_incomplete');});
 const result=await extractReservationistPlan({adapter:{invoke} as never,triggerMessageId:'first',messages:[{id:'earlier',at:'2026-09-30T00:00:00Z',text:'Is breakfast available?'},{id:'first',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal});
 expect(invoke).toHaveBeenCalledTimes(1);expect(result.tasks).toHaveLength(1);expect(result.tasks[0]).toMatchObject({kind:'question',factIds:[],source:{attachmentId:'message:first',sourceHash:h,page:1,quote:'Is parking available?',start:0,end:21}});expect(result.facts).toEqual([]);expect(result.sourceIncomplete).toHaveLength(10);expect(result.manualRequired).toContain('attachment_batch_unavailable');expect(result.unresolvedAsks).toContain('Original request requires staff review after model extraction failure');
});

it.each(['Please review.\n---------- Forwarded message ---------\nIs parking available?','Please review.\n> Is parking available?'])('never recovers quoted or forwarded history as a new task after model failure: %s',async text=>{
 const body=Buffer.from('%PDF-1.7 synthetic history'),sha=createHash('sha256').update(body).digest('hex'),admissions=Array.from({length:10},(_,i)=>({status:'admitted',metadata:{attachmentId:`h${i}`,mimeType:'application/pdf',sourceHash:sha},source:{attachmentId:`h${i}`,sourceHash:sha,disclosure:'guest',pages:['source'],pageCount:1},bytes:{body:Buffer.from(body),sha256:sha}}));const invoke=vi.fn(async()=>{throw new Error('synthetic_model_incomplete');});
 await expect(extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'history',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal})).rejects.toThrow('synthetic_model_incomplete');expect(invoke).toHaveBeenCalledTimes(1);
});

it('retains exact independent mail asks and all source dispositions when total media exceed bounded capacity',async()=>{
 const body=Buffer.from('%PDF-1.7 synthetic resource overflow'),sha=createHash('sha256').update(body).digest('hex'),text='Is parking available?',admissions=Array.from({length:65},(_,i)=>({status:'admitted',metadata:{attachmentId:`o${i}`,mimeType:'application/pdf',sourceHash:sha},source:{attachmentId:`o${i}`,sourceHash:sha,disclosure:'guest',pages:['source'],pageCount:1},bytes:{body:Buffer.from(body),sha256:sha}}));const invoke=vi.fn();
 const result=await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'overflow',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal});expect(invoke).not.toHaveBeenCalled();expect(result.tasks[0].source.quote).toBe(text);expect(result.facts).toEqual([]);expect(result.sourceIncomplete).toHaveLength(65);expect(result.sourceIncomplete?.every(s=>s.reason==='attachment_total_resource_unavailable')).toBe(true);expect(result.manualRequired).toContain('attachment_total_resource_unavailable');
});

describe('complete original monetary tokens',()=>{
 it.each(['Book; paid ZAR 9,315.00.','Book; paid R9,315.00.','Book; paid ZAR 1,234,567.89.'])('normalizes an explicit comma-thousands/dot-decimal source token without changing its quote: %s',async text=>{const amount=text.includes('1,234,567')?'1234567.89':'9315.00';const {result}=await extractSyntheticFact('payment_claim',{amount,currency:'ZAR',status:'claimed_paid'},text);expect(result.facts[0]).toMatchObject({amountCents:amount==='9315.00'?931500:123456789,source:{quote:text}});});
 it.each(['Book; paid ZAR 9,315.00.','Book; paid R9,315.00.'])('denies a forged prefix amount from %s',async text=>{await expect(extractSyntheticFact('payment_claim',{amount:'9',currency:'ZAR',status:'claimed_paid'},text)).rejects.toThrow('entailed');});
 it.each(['Book; nightly ZAR 9,315.00.','Book; total ZAR 9,315.00.'])('uses the same complete token for rate kind: %s',async text=>{const basis=text.includes('nightly')?'nightly':'total';expect((await extractSyntheticFact('rate_claim',{amount:'9315.00',currency:'ZAR',basis},text)).result.facts[0].amountCents).toBe(931500);await expect(extractSyntheticFact('rate_claim',{amount:'9',currency:'ZAR',basis},text)).rejects.toThrow('entailed');});
 it.each(['9,31.00','9,315.000','9,,315.00','9,315.00.50','9,315.00x','9,315','1,234','1,234,567','9.315,00','9%','9:315.00','9*315.00','9-315.00','9/315.00','9 _315.00','9 ,315.00','9 31.00','9  315.00','9\t315.00','9\u2009315.00','9e3'])('rejects ambiguous or malformed whole token %s and its prefix',async token=>{for(const amount of ['9','9315.00','1','1234.00'])await expect(extractSyntheticFact('payment_claim',{amount,currency:'ZAR',status:'claimed_paid'},`Book; paid ZAR ${token}.`)).rejects.toThrow('entailed');});
 it.each(['Book; paid ZAR 9,315.00 and ZAR 1,000.00.','Book; not paid ZAR 9,315.00.','Book; pending payment ZAR 9,315.00.'])('denies conflicting or non-paid original monetary row: %s',async text=>{await expect(extractSyntheticFact('payment_claim',{amount:'9315.00',currency:'ZAR',status:'claimed_paid'},text)).rejects.toThrow('entailed');});
 it('does not narrow away a negated original row around a complete monetary token',async()=>{const text='Book; not paid ZAR 9,315.00.';await expect(extractSyntheticFact('payment_claim',{amount:'9315.00',currency:'ZAR',status:'claimed_paid'},text,'paid ZAR 9,315.00')).rejects.toThrow('entailed');});
});

it('binds an explicitly selected code-owned original request candidate without copying or normalizing its newline',async()=>{
 const text='Please\nensure you UPDATE your system.\nIs parking available?\nFrom: Older mail\nPlease cancel the booking.',hash=createHash('sha256').update(text).digest('hex');let selected:any;
 const invoke=vi.fn(async(request:any)=>{const candidates=JSON.parse(request.userPrompt).requestSpans;expect(candidates.length).toBeGreaterThan(0);selected=candidates.find((c:any)=>c.source.quote==='Please\nensure you UPDATE your system.');expect(selected).toBeDefined();expect(candidates.every((c:any)=>!c.source.quote.includes('cancel'))).toBe(true);return{output:{facts:[],tasks:[{id:'sync',kind:'channel_booking_sync',factIds:[],sourceCandidateId:selected.id}],unresolvedAsks:[]}};});
 const result=await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'candidate',at:'2026-10-01T00:00:00Z',direction:'inbound' as const,text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});expect(result.tasks[0].source).toEqual({attachmentId:'message:candidate',sourceHash:hash,page:1,quote:'Please\nensure you UPDATE your system.',start:0,end:37});expect(result.tasks[0]).not.toHaveProperty('sourceCandidateId');
});

it.each(['unknown','both','mutated','history'])('rejects unbound or changed selected request candidate: %s',async kind=>{
 const messages=[{id:'candidate',at:'2026-10-01T00:00:00Z',direction:'inbound' as const,text:'Is parking available?\nFrom: Older mail\nIs transfer available?'}];const invoke=vi.fn(async(request:any)=>{const candidate=JSON.parse(request.userPrompt).requestSpans[0],task:any={id:'q',kind:'question',factIds:[],sourceCandidateId:kind==='unknown'||kind==='history'?'unbound':candidate.id};if(kind==='both')task.source=candidate.source;if(kind==='mutated')messages[0].text+=' changed';return{output:{facts:[],tasks:[task],unresolvedAsks:[]}};});
 await expect(extractReservationistPlan({adapter:{invoke} as never,messages,causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow(/candidate|inventory/i);expect(invoke).toHaveBeenCalledOnce();
});

 it.each(['cancel_request','quote','new_booking','change','acceptance','existing_document','channel_booking_sync'])('rejects a parking candidate mislabeled as %s',async kind=>{const invoke=vi.fn(async(request:any)=>({output:{facts:[],tasks:[{id:'q',kind,factIds:[],sourceCandidateId:JSON.parse(request.userPrompt).requestSpans[0].id}],unresolvedAsks:[]}}));await expect(extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text:'Is parking available?'}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow(/candidate.*kind/i);});
 it.each([{direction:'outbound' as const},{direction:'inbound' as const,disclosure:'staff_only' as const},{}])('does not offer request candidates for a non-customer trigger %j',async extra=>{const text='Is parking available?',hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(request:any)=>{expect(JSON.parse(request.userPrompt).requestSpans).toEqual([]);return{output:{facts:[],tasks:[{id:'q',kind:'question',factIds:[],sourceCandidateId:'request-1'}],unresolvedAsks:[]}};});await expect(extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',text,...extra}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow(/unbound/i);});

 it('offers only original ambiguous monetary row hints without turning them into facts or narrowing source pages',async()=>{const text='Please quote.\nNightly ZAR 100.00; total ZAR 200.00.\nNightly ZAR 150.00 and total ZAR 300.00.\nPaid ZAR 9,31.00.',hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(request:any)=>{const prompt=JSON.parse(request.userPrompt);expect(prompt.sources[0].pages).toEqual([text]);expect(prompt.unsupportedMonetaryRows).toEqual([{attachmentId:'message:m',sourceHash:hash,page:1,start:text.indexOf('Nightly ZAR 150'),end:text.indexOf('Nightly ZAR 150')+'Nightly ZAR 150.00 and total ZAR 300.00'.length,reason:'different_amounts_on_original_row'},{attachmentId:'message:m',sourceHash:hash,page:1,start:text.indexOf('Paid ZAR'),end:text.indexOf('Paid ZAR')+'Paid ZAR 9,31.00'.length,reason:'ambiguous_original_amount_token'}]);return{output:{facts:[],tasks:[{id:'q',kind:'quote',factIds:[],source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:'Please quote.',start:0,end:13}}],unresolvedAsks:['Original row totals cannot be used as validated rates.']}};});const result=await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});expect(result.facts).toEqual([]);expect(result.tasks).toHaveLength(1);});

 it.each([['Do not cancel the reservation.','cancel_request'],['Was my booking changed?','change'],['Was the quote accepted?','acceptance'],['Do not update your system.','channel_booking_sync'],['Do not send a quote.','quote'],['Can you cancel the booking?','cancel_request']])('does not certify action intent in candidate %s',async(text,kind)=>{const hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(request:any)=>{const candidates=JSON.parse(request.userPrompt).requestSpans;expect(candidates.every((c:any)=>!Object.hasOwn(c,'allowedKinds'))).toBe(true);return{output:{facts:[],tasks:[{id:'q',kind:'question',factIds:[],source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:text,start:0,end:text.length}}],unresolvedAsks:[]}};});await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});});

 it.each(['Do not please send the invoice.','> Please send the invoice.','Begin forwarded message:\nPlease send the invoice.','If approved please send the invoice.','Without approval please send the invoice.'])('never narrows original history or polarity into an action candidate: %s',async text=>{const hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(request:any)=>{expect(JSON.parse(request.userPrompt).requestSpans.every((c:any)=>!Object.hasOwn(c,'allowedKinds'))).toBe(true);return{output:{facts:[],tasks:[{id:'q',kind:'question',factIds:[],source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:text,start:0,end:text.length}}],unresolvedAsks:[]}};});await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});});

 it('keeps heuristic kinds server-only and offers only question/channel candidate shortcuts while commercial tasks retain canonical sources',async()=>{const text='Please see the quotation received.\nYou can book the rooms as she allocated it.\nIs parking available?\nPlease update your system.',hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(request:any)=>{const prompt=JSON.parse(request.userPrompt);expect(prompt.requestSpans.every((c:any)=>!Object.hasOwn(c,'allowedKinds'))).toBe(true);expect(prompt.requestSpans.every((c:any)=>!c.source.quote.includes('quotation')&&!c.source.quote.includes('book the rooms'))).toBe(true);const parking=prompt.requestSpans.find((c:any)=>c.source.quote==='Is parking available?');expect(parking).toBeDefined();return{output:{facts:[],tasks:[{id:'accept',kind:'acceptance',factIds:[],source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:'You can book the rooms as she allocated it.',start:text.indexOf('You can'),end:text.indexOf('You can')+'You can book the rooms as she allocated it.'.length}},{id:'parking',kind:'question',factIds:[],sourceCandidateId:parking.id}],unresolvedAsks:[]}};});const plan=await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});expect(plan.tasks.map(t=>t.kind)).toEqual(['acceptance','question']);expect(invoke).toHaveBeenCalledOnce();});

it('constrains source hash choices to actual original source inventory on the SDK request without repairing a mismatched output',async()=>{const text='Please quote.',hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(request:any)=>{for(const fact of request.responseSchema.properties.facts.items.anyOf)expect(fact.properties.source.properties.sourceHash.enum).toEqual([hash]);expect(request.responseSchema.properties.tasks.items.properties.source.properties.sourceHash.enum).toEqual([hash]);return{output:{facts:[],tasks:[{id:'q',kind:'quote',factIds:[],source:{attachmentId:'message:m',sourceHash:hash.slice(0,62),page:1,quote:text,start:0,end:text.length}}],unresolvedAsks:[]}};});await expect(extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow('Invalid bounded document plan');});

it('instructs exact paired source identity copying on actual SDK wire and refuses a one-character model hash error',async()=>{
 const text='Please quote.\nNightly ZAR 100.00',hash=createHash('sha256').update(text).digest('hex'),wrong=(hash[0]==='a'?'b':'a')+hash.slice(1),quote='Nightly ZAR 100.00';let wire:any;
 const output={facts:[{id:'rate',kind:'rate_claim',disclosure:'guest',source:{attachmentId:'message:m',sourceHash:wrong,page:1,quote},value:{amount:'100.00',currency:'ZAR',basis:'nightly'}}],tasks:[{id:'q',kind:'quote',factIds:['rate'],source:{attachmentId:'message:m',sourceHash:hash,page:1,quote:'Please quote.'}}],unresolvedAsks:[]};
 const adapter=new AzureLunaModelAdapter({baseURL:'https://synthetic.invalid/openai/v1',apiKey:'synthetic',route:{routeId:'synthetic-extraction',modelId:'gpt-6-luna',purpose:'extraction',protocol:'azure-foundry-responses'},cost:{version:'synthetic',effectiveAt:'2026-10-01T00:00:00Z',inputUsdPerMillion:1,outputUsdPerMillion:2},fetch:async(_url,init)=>{wire=JSON.parse(String(init?.body));return new Response(JSON.stringify({id:'synthetic',object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output),annotations:[]}]}],usage:{input_tokens:100,output_tokens:50,output_tokens_details:{reasoning_tokens:40}}}),{headers:{'content-type':'application/json'}});}});
 await expect(extractReservationistPlan({adapter,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal})).rejects.toThrow('Unbound document source');
 expect(wire.input[0].content).toContain('opaque identifiers');expect(wire.input[0].content).toContain('same sources entry');
 for(const fact of wire.text.format.schema.properties.facts.items.anyOf){expect(fact.properties.source.properties.sourceHash.enum).toEqual([hash]);expect(fact.properties.source.properties.attachmentId.enum).toEqual(['message:m']);}
 expect(wire.store).toBe(false);
});


it.each(['Please note a customer has made a payment.\nAmount R8 810.00','Payment made.\nAmount R8810.00'])('retains strict payment amount/status row entailment for actual notification shapes: %s',async text=>{
 await expect(extractSyntheticFact('payment_claim',{amount:'8810.00',currency:'ZAR',status:'claimed_paid'},text)).rejects.toThrow('entailed');
});

it('binds an explicit sole accommodation allocation without a customer-invented group ID',async()=>{
 const result=await extractSyntheticFact('room',{roomRef:'1',quantity:1,adults:1,childAges:[]},'Please quote 1 room for 1 official.',undefined,'quote');
 expect(result.result.facts[0].value).toEqual({roomRef:'1',quantity:1,adults:1,childAges:[]});
});
it('rejects ambiguous or contradictory sole accommodation allocation',async()=>{
 for(const text of ['Please quote 2 rooms for 1 official.','Please quote 1 room for 2 officials.','Please quote 1 room for 1 child.','Please quote Group B: 1 room for 1 official.'])await expect(extractSyntheticFact('room',{roomRef:'1',quantity:1,adults:1,childAges:[]},text)).rejects.toThrow('entailed');
});
it('binds one titled adult to the sole explicitly requested single room without inventing age',async()=>{
 const text='Please book 1 single room for Mr Alex Example.';
 const room=await extractSyntheticFact('room',{roomRef:'1',quantity:1,adults:1,childAges:[]},text);expect(room.result.facts[0].value).toMatchObject({adults:1});
 const guest=await extractSyntheticFact('guest',{firstName:'Alex',lastName:'Example',roomRef:'1',roomIndex:1},text);expect(guest.result.facts[0].value).not.toHaveProperty('age');
});

it('validates compact labeled arrival and departure with the same printed year',async()=>{
 const result=await extractSyntheticFact('dates',{arrival:'2026-10-05',departure:'2026-10-08',yearContext:2026},'Please book. In 05October Out 08October 2026.');
 expect(result.result.facts[0].value).toMatchObject({arrival:'2026-10-05',departure:'2026-10-08'});
});
it('rejects a missing year and mismatched compact arrival/departure',async()=>{
 for(const text of ['Please book. In 05October Out 08October.','Please book. In 06October Out 08October 2026.','Please book. In 08October Out 05October 2026.'])await expect(extractSyntheticFact('dates',{arrival:'2026-10-05',departure:'2026-10-08',yearContext:2026},text)).rejects.toThrow();
});

it('retains the requested dinner board instead of narrowing it to breakfast',async()=>{
 await expect(extractSyntheticFact('board','breakfast','Please quote Dinner, Bed & Breakfast.',undefined,'quote')).rejects.toThrow('entailed');
 expect((await extractSyntheticFact('board','Dinner, Bed & Breakfast','Please quote Dinner, Bed & Breakfast.',undefined,'quote')).result.facts[0].value).toBe('Dinner, Bed & Breakfast');
});

it('merges the same authored task prefix across media batches without duplicating a booking',async()=>{
 const text='Please book one room. The dates are supplied below.',sha=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:batch-prefix',sourceHash:sha,page:1};
 const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW9kAAAAASUVORK5CYII=','base64');
 const admissions=Array.from({length:9},(_,i)=>{const attachmentId='prefix-'+i,sourceHash=createHash('sha256').update(data).digest('hex');return{status:'admitted',metadata:{attachmentId,sourceHash,messageId:'batch-prefix',messageAt:'2026-10-01T00:00:00Z',mimeType:'image/png',sizeBytes:data.length,disclosure:'guest'},source:{attachmentId,sourceHash,disclosure:'guest',pages:null,pageCount:1},bytes:{body:data,sha256:sourceHash,contentType:'image/png'}};});
 let calls=0;const result=await extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[],tasks:[{id:'book',kind:'new_booking',factIds:[],source:{...source,quote:++calls===1?'Please book one room.':text,start:0,end:calls===1?21:text.length}}],unresolvedAsks:[]}})} as any,messages:[{id:'batch-prefix',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal});
 expect(result.tasks).toHaveLength(1);expect(result.tasks[0].source.quote).toBe(text);
});
it('refuses a forwarded guest assignment to the current sole adult room',async()=>{const text='Please quote 1 single room for Mr Alex Example.\nFrom: Earlier request\nMr Bob Earlier stayed last month.';await expect(extractSyntheticFact('guest',{firstName:'Bob',lastName:'Earlier',roomRef:'1',roomIndex:1},text,'Bob Earlier','quote')).rejects.toThrow('entailed');});
it('retains date exclusion before a newline in a compact labeled stay',async()=>{const text='Please quote.\nDo not use:\nIn 05October Out 08October 2026.';await expect(extractSyntheticFact('dates',{arrival:'2026-10-05',departure:'2026-10-08'},text,'In 05October Out 08October 2026','quote')).rejects.toThrow();});
it('keeps different question outputs separate across prefix media batches',async()=>{
 const text='Is parking available? Is breakfast included?',sourceHash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:prefix-safety',sourceHash,page:1};const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW9kAAAAASUVORK5CYII=','base64');const admissions=Array.from({length:9},(_,i)=>({status:'admitted',metadata:{attachmentId:'a'+i,sourceHash:createHash('sha256').update(data).digest('hex'),messageId:'prefix-safety',messageAt:'2026-10-01T00:00:00Z',mimeType:'image/png',sizeBytes:data.length,disclosure:'guest'},source:{attachmentId:'a'+i,sourceHash:createHash('sha256').update(data).digest('hex'),disclosure:'guest',pages:null,pageCount:1},bytes:{body:data,sha256:createHash('sha256').update(data).digest('hex'),contentType:'image/png'}}));let calls=0;const result=await extractReservationistPlan({adapter:{invoke:async()=>{const quote=++calls===1?'Is parking available?':text;return{output:{facts:[],tasks:[{id:'q',kind:'question',factIds:[],source:{...source,quote,start:0,end:quote.length}}],unresolvedAsks:[]}};}} as any,messages:[{id:'prefix-safety',at:'2026-10-01T00:00:00Z',text}],causalAt:'2026-10-01T00:00:00Z',admissions:admissions as any,signal:new AbortController().signal});expect(result.tasks).toHaveLength(2);
});

it('rejects inferred first and last order from an unlabeled slash-separated booking name',async()=>{await expect(extractSyntheticFact('guest',{firstName:'Taylor',lastName:'Sample'},'Please book for Sample/Taylor.')).rejects.toThrow('entailed');});

 describe('secondary hotel commercial questions keep original sources',()=>{
 it.each(['Please advise the provisional room hold duration.','Please explain the accommodation benefits.','Please refer the rate request to management.'])('offers only the original question shortcut: %s',async text=>{
  const invoke=vi.fn(async(request:any)=>{expect(request.systemPrompt).toContain('provisional holds');expect(request.systemPrompt).toContain('Availability for the same explicitly requested quotation is part of that quote');const candidate=JSON.parse(request.userPrompt).requestSpans.find((c:any)=>c.source.quote===text);expect(candidate).toBeDefined();return{output:{facts:[],tasks:[{id:'secondary',kind:'question',factIds:[],sourceCandidateId:candidate.id}],unresolvedAsks:[]}};});
  const result=await extractReservationistPlan({adapter:{invoke} as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],triggerMessageId:'m',causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});expect(result.tasks).toHaveLength(1);expect(result.tasks[0].kind).toBe('question');expect(result.tasks[0].source.quote).toBe(text);
 });
 });

it('uses explicitly written one in the same sole adult room convention without a numeric-default guess',async()=>{
 const text='Please quote one room for one adult ALEX EXAMPLE.',hash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:synthetic',sourceHash:hash,page:1,quote:text,start:0,end:text.length};
 const {result}=await extractSyntheticFact('room',{roomRef:'1',quantity:1,adults:1,childAges:[]},text,text,'quote');expect(result.facts[0].value).toEqual({roomRef:'1',quantity:1,adults:1,childAges:[]});
});
it.each(['Please quote one room for one adult with a child.','Please quote one room for one adult or two adults.','Please do not quote one room for one adult.','Please quote one room and another room for one adult.'])('does not make explicit one override conflicting scope: %s',async text=>{await expect(extractSyntheticFact('room',{roomRef:'1',quantity:1,adults:1,childAges:[]},text,text,'quote')).rejects.toThrow(/entailed/);});

describe('unique original citation binding after case-only model copy changes',()=>{
 async function run(text:string,quote:string,extra:any={},name={firstName:'Alex',lastName:'Example'}){const source={attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote,...extra};return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'g',kind:'guest',value:name,disclosure:'guest',source}],tasks:[{id:'q',kind:'quote',factIds:['g'],source:{attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length}}],unresolvedAsks:[]}})}as never,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});}
 it('rejects overlapping case-only original citation matches',async()=>{await expect(run('Please quote for ANA ANA ANA.','Ana Ana',{}, {firstName:'Ana',lastName:'Ana'})).rejects.toThrow('Ambiguous original text span');});
 it('returns the original spelling and offsets for one unique case-only citation',async()=>{const text='Please quote for ALEX EXAMPLE.',p=await run(text,'Alex Example');expect(p.facts[0]).toMatchObject({source:{quote:'ALEX EXAMPLE',start:17,end:29},value:{firstName:'ALEX',lastName:'EXAMPLE'}});});
 it.each([
 ['Please quote for ALEX EXAMPLE and Alex Example.','alex example',{}],
 ['Please quote for ALEX EXAMPLE 2.','Alex Example 3',{}],
 ['Please quote for ALEX  EXAMPLE.','Alex Example',{}],
 ['Please quote for ALEX EXAMPLÉ.','Alex Example',{}],
 ['Please quote for ALEX EXAMPLE.','Alex Example',{start:17,end:29}],
 ['Please quote; not for ALEX EXAMPLE.','Not for Alex Example',{}],
 ['Please quote for ALEX EXAMPLE.','Alex Example',{sourceHash:'a'.repeat(64)}],
 ['Please quote for ALEX EXAMPLE.','Alex Example',{attachmentId:'message:foreign'}],
 ])('rejects ambiguous, changed, explicit-offset or unauthorized copies: %s',async(text,quote,extra)=>{await expect(run(text,quote,extra)).rejects.toThrow();});
});
