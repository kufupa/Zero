import {
  normalizeDocumentDecimal,
  validateDocumentPlan,
  guestDocumentFacts,
} from '../src/ai/reservationist-document-facts.js';
import { describe, expect, it } from 'vitest';
import { HTML_ALTERNATIVE_MARKER } from '../src/ai/reservationist-message-view.js';
const source = {
  attachmentId: 'a',
  sourceHash: 'a'.repeat(64),
  disclosure: 'guest' as const,
  pages: ['2 adults, 1 child age 7. Rate ZAR 1 234,50 nightly.'],
  pageCount: 1,
};
const span = {
  attachmentId: 'a',
  sourceHash: source.sourceHash,
  page: 1,
  quote: '2 adults, 1 child age 7',
  start: 0,
  end: '2 adults, 1 child age 7'.length,
};
const fact = {
  id: 'room',
  kind: 'room' as const,
  value: { roomRef: '1', adults: 2, childAges: [7] },
  disclosure: 'guest' as const,
  source: span,
};
describe('document facts', () => {
  it.each([
    'Please quote.\nKind regards\nGuest',
    'Please quote.\nKind regards\nOffice closed 01/12 to 03/12',
    'Please quote. Conference 01/12 to 03/12.\nKind regards\nGuest',
    'Please quote accommodation:\nConference 01/12 to 03/12.',
    'Do not quote accommodation:\n13/11 to 15/11.',
    'Do not quote accommodation 13/11 to 15/11.',
  ])('anchors yearless HTML dates to their complete authored alternative', (plain) => {
    const html = 'Please quote. Stay 12/11 to 14/11.';
    const text = `${plain}\n\n${HTML_ALTERNATIVE_MARKER}${html}`;
    const start = text.indexOf('Stay 12/11'), quote = 'Stay 12/11 to 14/11';
    const dateSource = { attachmentId: 'message:m', sourceHash: 'b'.repeat(64), disclosure: 'guest' as const,
      pages: [text], pageCount: 1, causalMessage: { at: '2026-10-31T12:00:00.000Z', direction: 'inbound' as const },
      sourceViews: [{ name: 'plain' as const, start: 0, end: plain.length },
        { name: 'html' as const, start: text.length - html.length, end: text.length }] };
    const dateSpan = { attachmentId: dateSource.attachmentId, sourceHash: dateSource.sourceHash, page: 1,
      quote, start, end: start + quote.length };
    const plan = { facts: [{ id: 'dates', kind: 'dates' as const, value: { arrival: '12/11', departure: '14/11' },
      disclosure: 'guest' as const, source: dateSpan }],
      tasks: [{ id: 'quote', kind: 'quote' as const, factIds: ['dates'], source: dateSpan }], unresolvedAsks: [] };
    expect(validateDocumentPlan(plan, [dateSource]).facts[0]!.value).toEqual({ arrival: '2026-11-12', departure: '2026-11-14' });
    expect(() => validateDocumentPlan(plan, [{ ...dateSource, sourceViews: [dateSource.sourceViews[0]!,
      { ...dateSource.sourceViews[1]!, end: text.length - 1 }] }])).toThrow('Invalid document source views');
  });
  it.each(['Please quote. Stay 13/11 to 15/11.\nKind regards\nGuest',
    'Please quote accommodation:\n13/11 to 15/11.',
    'Please quote accommodation:\nDates: 13/11 to 15/11.',
    'Please quote accommodation 13/11 to 15/11, no other rooms are needed.'])('rejects a conflicting single stay range in the other email alternative', (plain) => {
    const html='Please quote. Stay 12/11 to 14/11.';
    const text=`${plain}\n\n${HTML_ALTERNATIVE_MARKER}${html}`,quote='Stay 12/11 to 14/11',start=text.indexOf(quote);
    const dateSource={attachmentId:'message:m',sourceHash:'b'.repeat(64),disclosure:'guest' as const,pages:[text],pageCount:1,
      causalMessage:{at:'2026-10-31T12:00:00.000Z',direction:'inbound' as const},sourceViews:[{name:'plain' as const,start:0,end:plain.length},{name:'html' as const,start:text.length-html.length,end:text.length}]};
    const span={attachmentId:dateSource.attachmentId,sourceHash:dateSource.sourceHash,page:1,quote,start,end:start+quote.length};
    const plan={facts:[{id:'dates',kind:'dates' as const,value:{arrival:'12/11',departure:'14/11'},disclosure:'guest' as const,source:span}],tasks:[{id:'quote',kind:'quote' as const,factIds:['dates'],source:span}],unresolvedAsks:[]};
    expect(()=>validateDocumentPlan(plan,[dateSource])).toThrow('Conflicting alternate stay dates');
  });
  it('normalizes decimal strings exactly without conflating ADR and nightly', () => {
    expect(normalizeDocumentDecimal('1 234,50')).toBe(123450);
    expect(normalizeDocumentDecimal('1234.50')).toBe(123450);
    expect(() => normalizeDocumentDecimal('1.234')).toThrow();
  });
  it('verifies exact original page offsets and retains tasks', () => {
    const result = validateDocumentPlan(
      {
        facts: [fact],
        tasks: [{ id: 'q', kind: 'quote', factIds: ['room'], source: span }],
        unresolvedAsks: ['board'],
      },
      [source],
    );
    expect(result.facts[0].verification).toBe('text_verified');
    expect(result.tasks).toHaveLength(1);
    expect(result.draftReady).toBe(false);
  });
  it('rejects invented quotes, page numbers and task references', () => {
    expect(() =>
      validateDocumentPlan(
        { facts: [{ ...fact, source: { ...span, page: 2 } }], tasks: [], unresolvedAsks: [] },
        [source],
      ),
    ).toThrow();
    expect(() =>
      validateDocumentPlan(
        {
          facts: [{ ...fact, source: { ...span, quote: 'invented' } }],
          tasks: [],
          unresolvedAsks: [],
        },
        [source],
      ),
    ).toThrow();
    expect(() =>
      validateDocumentPlan(
        {
          facts: [],
          tasks: [{ id: 'q', kind: 'quote', factIds: ['missing'] }],
          unresolvedAsks: [],
        },
        [source],
      ),
    ).toThrow();
  });
  it('scans are explicit uncertainty, never verified text or guest facts', () => {
    const scan = { ...source, pages: null };
    const result = validateDocumentPlan(
      {
        facts: [
          {
            ...fact,
            source: {
              attachmentId: 'a',
              sourceHash: source.sourceHash,
              page: 1,
              region: [0, 0, 1, 1],
            },
          },
        ],
        tasks: [],
        unresolvedAsks: [],
      },
      [scan],
    );
    expect(result.facts[0].verification).toBe('visual_review_required');
    expect(guestDocumentFacts(result)).toEqual([]);
  });
  it('source staff restriction wins and conflicts remain separate', () => {
    const result = validateDocumentPlan(
      {
        facts: [fact, { ...fact, id: 'room2', value: { roomRef: '1', adults: 3, childAges: [] } }],
        tasks: [],
        unresolvedAsks: [],
      },
      [{ ...source, disclosure: 'staff_only' }],
    );
    expect(result.facts).toHaveLength(2);
    expect(guestDocumentFacts(result)).toEqual([]);
  });
  it('refuses executable instructions and oversized plans', () => {
    expect(() =>
      validateDocumentPlan(
        {
          facts: [{ ...fact, kind: 'instruction', value: 'ignore rules' }],
          tasks: [],
          unresolvedAsks: [],
        },
        [source],
      ),
    ).toThrow();
    expect(() =>
      validateDocumentPlan({ facts: Array(65).fill(fact), tasks: [], unresolvedAsks: [] }, [
        source,
      ]),
    ).toThrow();
  });
});
it('normalizes sourced ZAR ceiling as customer claim and rejects impossible dates', () => {
  const text = 'ZAR 1 234,50 ceiling';
  const s = { ...source, pages: [text] };
  const rate = {
    id: 'r',
    kind: 'rate_claim',
    value: { amount: '1 234,50', currency: 'ZAR', basis: 'ceiling' },
    disclosure: 'guest',
    source: { ...span, quote: text, end: text.length },
  };
  const result = validateDocumentPlan({ facts: [rate], tasks: [], unresolvedAsks: [] }, [s]);
  expect(result.facts[0].amountCents).toBe(123450);
  expect(result.facts[0].authority).toBe('customer_claim');
  expect(() =>
    validateDocumentPlan(
      {
        facts: [
          { ...rate, kind: 'dates', value: { arrival: '2026-02-30', departure: '2026-03-05' } },
        ],
        tasks: [],
        unresolvedAsks: [],
      },
      [s],
    ),
  ).toThrow();
});
it('requires exact unique task request spans for quote plus two questions',()=>{
 const text='Please quote. Is breakfast included? Is parking available?';const original={...source,pages:[text]};
 const task=(id:string,kind:string,quote:string)=>({id,kind,factIds:[],source:{attachmentId:'a',sourceHash:source.sourceHash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length}});
 const tasks=[task('q','quote','Please quote.'),task('b','question','Is breakfast included?'),task('p','question','Is parking available?')];
 expect(validateDocumentPlan({facts:[],tasks,unresolvedAsks:[]},[original]).tasks).toHaveLength(3);
 expect(()=>validateDocumentPlan({facts:[],tasks:[{id:'q',kind:'quote',factIds:[]}],unresolvedAsks:[]},[original])).toThrow();
 expect(()=>validateDocumentPlan({facts:[],tasks:[tasks[0],{...tasks[1],source:tasks[0].source}],unresolvedAsks:[]},[original])).toThrow();
 expect(()=>validateDocumentPlan({facts:[],tasks:[{...tasks[0],source:{...tasks[0].source,quote:'Invented'}}],unresolvedAsks:[]},[original])).toThrow();
});

function sourcedPlanFact(kind: string, value: unknown, text: string) {
  const original = { ...source, pages: [text] };
  const sourced = { id: 'f', kind, value, disclosure: 'guest', source: { ...span, quote: text, end: text.length } };
  return { original, candidate: { facts: [sourced], tasks: [], unresolvedAsks: [] } };
}

describe('booking source vocabulary', () => {
  it('retains guest identity, optional per-room assignment and explicit quantities as customer claims', () => {
    const text = 'Group A: 2 rooms, 1 adult each. Room 2: Alex Example, age 35, profile P-7.';
    const { original, candidate } = sourcedPlanFact('guest', { firstName: 'Alex', lastName: 'Example', roomRef: 'A', roomIndex: 2, age: 35, profileId: 'P-7' }, text);
    candidate.facts.push({ ...candidate.facts[0], id: 'rooms', kind: 'room', value: { roomRef: 'A', quantity: 2, adults: 1, childAges: [] } });
    const result = validateDocumentPlan(candidate, [original]);
    expect(result.facts[0]).toMatchObject({ value: { firstName: 'Alex', lastName: 'Example', roomRef: 'A', roomIndex: 2, age: 35, profileId: 'P-7' }, authority: 'customer_claim', verification: 'text_verified' });
    expect(result.facts[1].value).toMatchObject({ quantity: 2 });
  });
  it('keeps missing assignments and quantities missing rather than inventing defaults', () => {
    const { original, candidate } = sourcedPlanFact('guest', { firstName: 'Alex', lastName: 'Example' }, 'Alex Example');
    expect(validateDocumentPlan(candidate, [original]).facts[0].value).toEqual({ firstName: 'Alex', lastName: 'Example' });
    const unassignedIndex = sourcedPlanFact('guest', { firstName: 'Alex', lastName: 'Example', roomIndex: 2 }, 'Room 2: Alex Example');
    expect(validateDocumentPlan(unassignedIndex.candidate, [unassignedIndex.original]).facts[0].value).not.toHaveProperty('roomRef');
    const room = sourcedPlanFact('room', { roomRef: 'A', adults: 1, childAges: [] }, 'Group A: 1 adult');
    expect(validateDocumentPlan(room.candidate, [room.original]).facts[0].value).not.toHaveProperty('quantity');
  });
  it('rejects guest indices outside an explicit matching room quantity and invalid field bounds', () => {
    const { original, candidate } = sourcedPlanFact('guest', { firstName: 'Alex', lastName: 'Example', roomRef: 'A', roomIndex: 3 }, 'Group A: 2 rooms. Room 3: Alex Example');
    candidate.facts.push({ ...candidate.facts[0], id: 'rooms', kind: 'room', value: { roomRef: 'A', quantity: 2, adults: 1, childAges: [] } });
    expect(() => validateDocumentPlan(candidate, [original])).toThrow('quantity');
    for (const value of [{ firstName: '', lastName: 'Example' }, { firstName: 'Alex', lastName: 'Example', age: 121 }, { firstName: 'Alex', lastName: 'Example', roomIndex: 0 }]) {
      const bad = sourcedPlanFact('guest', value, 'Alex Example');
      expect(() => validateDocumentPlan(bad.candidate, [bad.original])).toThrow('bounded');
    }
  });
  it('retains reservation references and distinguishes a new booking from acceptance', () => {
    const text = 'Please book a new room; reservation reference R-42.';
    const { original, candidate } = sourcedPlanFact('reservation_reference', 'R-42', text);
    candidate.tasks.push({ id: 'book', kind: 'new_booking', factIds: ['f'], source: candidate.facts[0].source } as never);
    const result = validateDocumentPlan(candidate, [original]);
    expect(result.facts[0].value).toBe('R-42');
    expect(result.tasks[0].kind).toBe('new_booking');
  });
});

describe('explicit document calendars', () => {
  it.each([
    ['12 October 2026', '14 Oct 2026'],
    ['October 12, 2026', 'Oct 14 2026'],
    ['12/10/2026', '14/10/2026'],
    ['2026-10-12', '2026-10-14'],
  ])('normalizes fully explicit %s without inferring calendar parts', (arrival, departure) => {
    const { original, candidate } = sourcedPlanFact('dates', { arrival, departure }, `Arrival ${arrival}; departure ${departure}`);
    expect(validateDocumentPlan(candidate, [original]).facts[0].value).toEqual({ arrival: '2026-10-12', departure: '2026-10-14' });
  });
  it('normalizes day/month only with an explicit yearContext in the same verified span', () => {
    const { original, candidate } = sourcedPlanFact('dates', { arrival: '12/10', departure: '14/10', yearContext: 2026 }, 'For 2026: arrival 12/10; departure 14/10');
    expect(validateDocumentPlan(candidate, [original]).facts[0].value).toEqual({ arrival: '2026-10-12', departure: '2026-10-14', yearContext: 2026 });
  });
  it.each([
    [{ arrival: '12/10', departure: '14/10' }, 'Arrival 12/10; departure 14/10'],
    [{ arrival: '12/10', departure: '14/10', yearContext: 2026 }, 'Arrival 12/10; departure 14/10'],
    [{ arrival: '12 October', departure: '14 October', yearContext: 2026 }, 'For 2026: 12 October to 14 October'],
    [{ arrival: '12', departure: '14', yearContext: 2026 }, 'For October 2026: 12 to 14'],
    [{ arrival: '12 October 2027', departure: '14 October 2027', yearContext: 2026 }, 'Arrival 12 October 2027 departure 14 October 2027; 2026'],
    [{ arrival: '30 February 2026', departure: '5 March 2026' }, '30 February 2026 to 5 March 2026'],
    [{ arrival: '2026-10-12', departure: '2026-10-14' }, 'Arrival 12 October 2027 departure 14 October 2027'],
  ])('rejects ambiguous or contradictory candidate dates %#', (value, text) => {
    const { original, candidate } = sourcedPlanFact('dates', value, text);
    expect(() => validateDocumentPlan(candidate, [original])).toThrow();
  });
  it('does not borrow a year from outside the verified source span', () => {
    const text = '2026\nArrival 12/10; departure 14/10';
    const { original, candidate } = sourcedPlanFact('dates', { arrival: '12/10', departure: '14/10', yearContext: 2026 }, text);
    candidate.facts[0].source = { ...candidate.facts[0].source, start: 5, quote: text.slice(5) };
    expect(() => validateDocumentPlan(candidate, [original])).toThrow();
  });
});

it('rejects stay roles that contradict explicit arrival and departure labels', () => {
  const { original, candidate } = sourcedPlanFact('dates', { arrival: '2026-10-12', departure: '2026-10-14' }, 'Arrival 14 October 2026; departure 12 October 2026');
  expect(() => validateDocumentPlan(candidate, [original])).toThrow('entailed');
});
it('requires a standalone explicit year rather than digits inside another identifier', () => {
  const { original, candidate } = sourcedPlanFact('dates', { arrival: '12/10', departure: '14/10', yearContext: 2026 }, 'Ref AB2026: arrival 12/10; departure 14/10');
  expect(() => validateDocumentPlan(candidate, [original])).toThrow('yearContext');
});

it('keeps a day/month year unresolved when the same span contains conflicting years', () => {
  const { original, candidate } = sourcedPlanFact('dates', { arrival: '12/10', departure: '14/10', yearContext: 2026 }, 'Stay 2027: arrival 12/10 departure 14/10; printed 2026');
  expect(() => validateDocumentPlan(candidate, [original])).toThrow('yearContext');
});

it('rejects conflicting yearContext when only the arrival omits its year', () => {
  const { original, candidate } = sourcedPlanFact('dates', { arrival: '12/10', departure: '2026-10-14', yearContext: 2026 }, 'Stay 2027: arrival 12/10, departure 2026-10-14');
  expect(() => validateDocumentPlan(candidate, [original])).toThrow('yearContext');
});

it('preserves legacy global board and strict explicit group board values',()=>{
 const text='Group A: Room Only R',original={...source,pages:[text]},span={attachmentId:'a',sourceHash:source.sourceHash,page:1,quote:text,start:0,end:text.length};
 const fact=(value:any)=>({id:'board',kind:'board',value,disclosure:'guest',source:span});
 expect(validateDocumentPlan({facts:[fact({board:'Room Only R',roomRef:'A'})],tasks:[],unresolvedAsks:[]},[original]).facts[0].value).toEqual({board:'Room Only R',roomRef:'A'});
 expect(validateDocumentPlan({facts:[fact('Room Only R')],tasks:[],unresolvedAsks:[]},[original]).facts[0].value).toBe('Room Only R');
 for(const value of [{board:'Room Only R'},{roomRef:'A'},{board:'Room Only R',roomRef:'A',authority:true}])expect(()=>validateDocumentPlan({facts:[fact(value)],tasks:[],unresolvedAsks:[]},[original])).toThrow();
});

it('retains an explicit channel system-sync request as its own sourced task', () => {
 const text='This booking is confirmed from channel allotment. Please\nensure you UPDATE your system.';
 const original={...source,pages:[text]};
 const request={...span,quote:text,start:0,end:text.length};
 const result=validateDocumentPlan({facts:[],tasks:[{id:'sync',kind:'channel_booking_sync',factIds:[],source:request}],unresolvedAsks:['reported guest and room details']},[original]);
 expect(result.tasks[0].kind).toBe('channel_booking_sync');
 expect(result.draftReady).toBe(false);
});
it.each(['New booking confirmed via channel manager.','Please advise the arrival time.','Please do not update your system.'])('does not turn notice or negated request into channel sync: %s', text => {
 const original={...source,pages:[text]},request={...span,quote:text,start:0,end:text.length};
 expect(()=>validateDocumentPlan({facts:[],tasks:[{id:'sync',kind:'channel_booking_sync',factIds:[],source:request}],unresolvedAsks:[]},[original])).toThrow();
});
it('does not narrow away original channel-sync negation', () => {
 const text='Do not update your system.',quote='update your system.';
 expect(()=>validateDocumentPlan({facts:[],tasks:[{id:'sync',kind:'channel_booking_sync',factIds:[],source:{...span,quote,start:text.indexOf(quote),end:text.length}}],unresolvedAsks:[]},[{...source,pages:[text]}])).toThrow();
});

it('binds an explicit shared-month date range without guessing missing calendar parts',()=>{
 const text='11- 16 October 2026',source={attachmentId:'range',sourceHash:'a'.repeat(64),pages:[text],pageCount:1,disclosure:'guest' as const},fact={id:'dates',kind:'dates',disclosure:'guest',source:{attachmentId:source.attachmentId,sourceHash:source.sourceHash,page:1,quote:text,start:0,end:text.length},value:{arrival:'2026-10-11',departure:'2026-10-16'}};
 const candidate={facts:[fact],tasks:[],unresolvedAsks:[]};expect(validateDocumentPlan(candidate,[source]).facts[0].value).toEqual(fact.value);
 expect(()=>validateDocumentPlan({...candidate,facts:[{...fact,value:{arrival:'2026-10-10',departure:'2026-10-16'}}]},[source])).toThrow('entailed');
 for(const missing of ['11-16 October','11-16 2026','31-2 October 2026']){const src={...source,pages:[missing]},f={...fact,source:{...fact.source,quote:missing,end:missing.length}};expect(()=>validateDocumentPlan({facts:[f],tasks:[],unresolvedAsks:[]},[src])).toThrow();}
});

it('normalizes explicit labeled day-month-year dash dates and rejects reversed roles',()=>{
 const text='Arrival Date:11-10-2026 Departure Date:16-10-2026',source={attachmentId:'dash',sourceHash:'a'.repeat(64),pages:[text],pageCount:1,disclosure:'guest' as const},fact={id:'dates',kind:'dates',disclosure:'guest',source:{attachmentId:source.attachmentId,sourceHash:source.sourceHash,page:1,quote:text,start:0,end:text.length},value:{arrival:'2026-10-11',departure:'2026-10-16'}};
 expect(validateDocumentPlan({facts:[fact],tasks:[],unresolvedAsks:[]},[source]).facts[0].value).toEqual(fact.value);
 expect(()=>validateDocumentPlan({facts:[{...fact,value:{arrival:'2026-10-16',departure:'2026-10-11'}}],tasks:[],unresolvedAsks:[]},[source])).toThrow();
 const missing='Arrival Date:11-10 Departure Date:16-10',f={...fact,source:{...fact.source,quote:missing,end:missing.length}};
 expect(()=>validateDocumentPlan({facts:[f],tasks:[],unresolvedAsks:[]},[{...source,pages:[missing]}])).toThrow();
});

it('does not replace explicit date roles with a conflicting shared range in the same bound source',()=>{
 const text='Arrival 12 October 2026 departure 17 October 2026, not 11-16 October 2026.',source={attachmentId:'range-conflict',sourceHash:'a'.repeat(64),pages:[text],pageCount:1,disclosure:'guest' as const},fact={id:'dates',kind:'dates',disclosure:'guest',source:{attachmentId:source.attachmentId,sourceHash:source.sourceHash,page:1,quote:text,start:0,end:text.length},value:{arrival:'2026-10-11',departure:'2026-10-16'}};
 expect(()=>validateDocumentPlan({facts:[fact],tasks:[],unresolvedAsks:[]},[source])).toThrow();
});

describe('explicit two-month stay range with a printed shared year', () => {
 function range(text: string, quote: string, arrival = '2026-09-28', departure = '2026-09-30') {
  const original = { attachmentId: 'shared-year-range', sourceHash: 'a'.repeat(64), pages: [text], pageCount: 1, disclosure: 'guest' as const };
  const start = text.indexOf(quote);
  const candidate = { facts: [{ id: 'dates', kind: 'dates', disclosure: 'guest', source: { attachmentId: original.attachmentId, sourceHash: original.sourceHash, page: 1, quote, start, end: start + quote.length }, value: { arrival, departure, yearContext: 2026 } }], tasks: [], unresolvedAsks: [] };
  return { original, candidate };
 }
 it.each([
  ['28\nSeptember to 30 September 2026', '2026-09-28', '2026-09-30'],
  ['28 to 30 September 2026', '2026-09-28', '2026-09-30'],
  ['28 September to 2 October 2026', '2026-09-28', '2026-10-02'],
  ['28 September 2026 to 2 October 2026', '2026-09-28', '2026-10-02'],
 ])('binds all printed calendar parts without a source-clock year: %s', (quote, arrival, departure) => {
  const { original, candidate } = range(`My upcoming stay is ${quote}.`, quote, arrival, departure);
  expect(validateDocumentPlan(candidate, [original]).facts[0].value).toEqual({ arrival, departure, yearContext: 2026 });
 });
 it.each([
  ['28 September to 30 September', '2026-09-28', '2026-09-30'],
  ['28 September to 30 2026', '2026-09-28', '2026-09-30'],
  ['30 September to 28 September 2026', '2026-09-28', '2026-09-30'],
  ['28 December to 2 January 2026', '2026-12-28', '2026-01-02'],
  ['31 September to 2 October 2026', '2026-09-30', '2026-10-02'],
  ['28 September 2027 to 30 September 2026', '2026-09-28', '2026-09-30'],
  ['28 September to 30 September 2026', '2026-09-27', '2026-09-30'],
 ])('rejects missing, reversed, conflicting or changed parts: %s', (quote, arrival, departure) => {
  const { original, candidate } = range(quote, quote, arrival, departure);
  expect(() => validateDocumentPlan(candidate, [original])).toThrow();
 });
 it.each(['Do not quote\n', 'Not\n', 'Without ', 'Previous stay: ', 'For another property, ', 'For a different hotel: ', 'Excluding ', 'If approved, ', 'Unless verified, '])('does not narrow away original exclusion: %s', prefix => {
  const quote = '28\nSeptember to 30 September 2026';
  const { original, candidate } = range(`${prefix}${quote}.`, quote);
  expect(() => validateDocumentPlan(candidate, [original])).toThrow();
 });
 it('rejects a conflicting labeled stay in the same original sentence when the model narrows the range', () => {
  const quote = '28 September to 30 September 2026';
  const { original, candidate } = range(`Arrival 27 September 2026 departure 1 October 2026, requested ${quote}.`, quote);
  expect(() => validateDocumentPlan(candidate, [original])).toThrow();
 });
 it('rejects multiple original ranges in the same sentence', () => {
  const quote = '28 September to 30 September 2026';
  const { original, candidate } = range(`${quote} or 1 October to 3 October 2026.`, quote);
  expect(() => validateDocumentPlan(candidate, [original])).toThrow();
 });
});

it('binds an explicit subgroup arrival within its printed overall stay range',()=>{
 const text='25 guests arriving on 11 October 2026\nAccommodation required from 10 to 16 October 2026, inclusive of breakfast and dinner';
 const original={attachmentId:'a',sourceHash:'a'.repeat(64),pages:[text],pageCount:1,disclosure:'guest' as const},source={attachmentId:'a',sourceHash:'a'.repeat(64),page:1,quote:text,start:0,end:text.length};
 const result=validateDocumentPlan({facts:[{id:'stay',kind:'dates',disclosure:'guest',source,value:{arrival:'11 October 2026',departure:'16 October 2026'}}],tasks:[{id:'q',kind:'quote',source,factIds:['stay']}],unresolvedAsks:[]},[original]);expect(result.facts[0].value).toMatchObject({arrival:'2026-10-11',departure:'2026-10-16'});
});

it.each(['Not 25 guests arriving on 11 October 2026','25 guests arriving on 17 October 2026','25 guests arriving on 11 October 2026\n10 guests arriving on 12 October 2026'])('rejects an excluded, out-of-range or ambiguous subgroup arrival: %s',lead=>{
 const text=lead+'\nAccommodation required from 10 to 16 October 2026',source={attachmentId:'a',sourceHash:'a'.repeat(64),page:1,quote:text,start:0,end:text.length};
 expect(()=>validateDocumentPlan({facts:[{id:'stay',kind:'dates',disclosure:'guest',source,value:{arrival:'11 October 2026',departure:'16 October 2026'}}],tasks:[{id:'q',kind:'quote',source,factIds:['stay']}],unresolvedAsks:[]},[{attachmentId:'a',sourceHash:'a'.repeat(64),pages:[text],pageCount:1,disclosure:'guest'}])).toThrow();
});
