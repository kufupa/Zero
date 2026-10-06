import { extractReservationistPlan } from '../src/ai/reservationist-extraction.js';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';

it.each(['combined', 'task_first'] as const)(
  'keeps room-options fact instructions distinct from quote guest context: %s',
  async (mode) => {
    const text =
      'Guest Name: Alex Example\nPlease quote.\nWhich room options are available?\nWhat breakfast options are offered?';
    const sourceHash = createHash('sha256').update(text).digest('hex');
    const source = (quote: string) => ({ attachmentId: 'message:m', sourceHash, page: 1, quote });
    const guest = {
      id: 'guest',
      kind: 'guest',
      disclosure: 'guest',
      source: source('Guest Name: Alex Example'),
      value: { firstName: 'Alex', lastName: 'Example' },
    };
    const tasks = [
      { id: 'quote', kind: 'quote', factIds: ['guest'], source: source('Please quote.') },
      {
        id: 'rooms',
        kind: 'question',
        factIds: [],
        source: source('Which room options are available?'),
      },
      {
        id: 'breakfast',
        kind: 'question',
        factIds: [],
        source: source('What breakfast options are offered?'),
      },
    ];
    let calls = 0;
    const invoke = vi.fn(async (request: any) => ({
      output:
        mode === 'combined'
          ? { facts: [guest], tasks, unresolvedAsks: [] }
          : ++calls === 1
            ? {
                facts: [],
                tasks: tasks.map((task) => ({ ...task, factIds: [] })),
                unresolvedAsks: [],
              }
            : {
                facts: [guest],
                assignments: tasks.map(({ id: taskId, factIds }) => ({ taskId, factIds })),
                unresolvedAsks: [],
              },
    }));
    const result = await extractReservationistPlan({
      adapter: { invoke, reserveCalls: vi.fn(async () => {}) } as never,
      mode: mode === 'combined' ? undefined : mode,
      messages: [{ id: 'm', at: '2026-10-04T08:00:00Z', text }],
      causalAt: '2026-10-04T08:00:00Z',
      admissions: [],
      signal: new AbortController().signal,
    });
    expect(result.tasks.map(({ id, factIds }) => ({ id, factIds }))).toEqual([
      { id: 'quote', factIds: ['guest'] },
      { id: 'rooms', factIds: [] },
      { id: 'breakfast', factIds: [] },
    ]);
    const factPrompt = invoke.mock.calls.at(-1)![0].systemPrompt;
    expect(factPrompt).toContain(
      'Room-options and breakfast-options questions may use only source-verified dates, room occupancy and board facts',
    );
    expect(factPrompt).toContain(
      'Never assign guest, party, rate_claim or payment_claim facts to those option questions',
    );
    expect(factPrompt).toContain('even when the same sentence also asks for quoted rates');
    expect(factPrompt).toContain(
      'Leave their factIds empty when those permitted facts are missing',
    );
    expect(factPrompt).toContain(
      'Keep the guest identity assigned to the separate quote or booking task',
    );
    expect(result.facts[0].source.quote).toBe('Guest Name: Alex Example');
  },
);

it.each(['combined','task_first']as const)('sends explicit price-plus-option splitting and original customer-party scope through the actual %s wire',async mode=>{
 const text='Please provide rates and advise what room options are available.\nKind regards,\nAlex Example\nExample Brand, caring for your vehicle.',hash=createHash('sha256').update(text).digest('hex'),source=(quote:string)=>({attachmentId:'message:m',sourceHash:hash,page:1,quote}),calls:any[]=[],tasks=[{id:'quote',kind:'quote',factIds:[],source:source('Please provide rates')},{id:'options',kind:'question',factIds:[],source:source('advise what room options are available.')}];
 const p=await extractReservationistPlan({mode,adapter:{reserveCalls:async()=>{},invoke:async(request:any)=>{calls.push(request);return{output:mode==='combined'||calls.length===1?{facts:[],tasks,unresolvedAsks:[]}:{facts:[],assignments:tasks.map(t=>({taskId:t.id,factIds:[]})),unresolvedAsks:[]}}}}as never,messages:[{id:'m',at:'2026-10-04T08:00:00Z',direction:'inbound',text}],triggerMessageId:'m',causalAt:'2026-10-04T08:00:00Z',admissions:[],signal:new AbortController().signal});
 expect(calls[0].systemPrompt).toContain('A price request plus an independently requested room-options or breakfast-options answer requires a quote task and a separate question task');expect(calls[0].systemPrompt).toContain('The enclosing-versus-contained source rule applies only to the same requested output');expect(calls.at(-1).systemPrompt).toContain('Signature, marketing, social-media and legal-footer organization names do not establish the requesting party');expect(calls.at(-1).systemPrompt).toContain('An explicitly named company or agency in the authored request, including an explicit on-behalf-of request, may supply customer party context');expect(calls.at(-1).systemPrompt).toContain('customer party context never proves native account match or rate eligibility');
 expect(p.tasks.map(t=>t.kind)).toEqual(['quote','question']);expect(p.facts).toEqual([]);expect(JSON.parse(calls[0].userPrompt).sources[0].pages).toEqual([text]);
});
