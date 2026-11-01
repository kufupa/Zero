import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildReservationistBookingSuggestion,
  reservationistBookingSuggestionGroupId,
} from '../src/ai/reservationist-booking-suggestion.js';
import { currentAuthoredGuestRequest } from '../src/ai/reservationist-execution.js';
import type { AttachmentAdmission } from '../src/ai/reservationist-attachment-input.js';
import type { ValidatedDocumentFact } from '../src/ai/reservationist-document-facts.js';
import type { ReservationistMessageView } from '../src/ai/reservationist-message-view.js';
import type { ReservationistRuntimeInput } from '../src/ai/reservationist-runtime.js';
import { renderReservationistMessage } from '../src/ai/reservationist-worker-input.js';

const triggerId = 'message-1';
const ownerRef = 'mailbox-1';
const threadId = 'thread-1';
const triggerAt = '2026-11-01T10:00:00.000Z';

function plan(
  body: string,
  extraFacts: Array<{ kind: string; value: unknown; quote: string }> = [],
  sourceViews?: ReservationistMessageView[],
  requestQuote = body,
) {
  const sourceHash = createHash('sha256').update(body).digest('hex');
  const sourceRef = `message:${triggerId}`;
  const sourceFor = (quote: string) => {
    const start = body.indexOf(quote);
    if (start < 0) throw new Error('test source quote missing');
    return { attachmentId: sourceRef, sourceHash, page: 1, quote, start, end: start + quote.length };
  };
  const requestStart = body.indexOf(requestQuote);
  if (requestStart < 0) throw new Error('test request quote missing');
  const request = { attachmentId: sourceRef, sourceHash, page: 1, quote: requestQuote, start: requestStart, end: requestStart + requestQuote.length };
  const roomQuote = body.includes('adults with no children') ? '1 room for 2 adults with no children' : body.includes('adults only') ? '1 room for 2 adults only' : '1 room for 2 adults';
  const facts: ValidatedDocumentFact[] = [
    {
      id: 'dates-1', kind: 'dates', value: { arrival: '2026-12-03', departure: '2026-12-05' },
      source: { ...sourceFor('2026-12-03 to 2026-12-05'), quote: '2026-12-03 to 2026-12-05' },
      disclosure: 'guest', verification: 'text_verified', authority: 'customer_claim',
    } as ValidatedDocumentFact,
    {
      id: 'room-1', kind: 'room', value: { roomRef: '1', quantity: 1, adults: 2, childAges: [] },
      source: { ...sourceFor(roomQuote), quote: roomQuote },
      disclosure: 'guest', verification: 'text_verified', authority: 'customer_claim',
    } as ValidatedDocumentFact,
    ...extraFacts.map((item, index) => ({
      id: `extra-${index + 1}`, kind: item.kind, value: item.value,
      source: { ...sourceFor(item.quote), quote: item.quote },
      disclosure: 'guest', verification: 'text_verified', authority: 'customer_claim',
    } as ValidatedDocumentFact)),
  ];
  const task = { id: 'task-1', kind: 'new_booking', factIds: facts.map((fact) => fact.id), source: request } as const;
  const runtime: ReservationistRuntimeInput = {
    version: 1, requestId: triggerId, propertyCode: 'HRCEN',
    trigger: { id: triggerId, at: triggerAt },
    messages: [{ id: triggerId, at: triggerAt, direction: 'inbound', text: body, ...(sourceViews ? { sourceViews } : {}) }],
    authorizationScope: { ownerRef, threadId }, authorizedArtifacts: [],
    clock: { causalAt: triggerAt, sourceAt: triggerAt, deadlineAt: Date.now() + 30_000 },
    capabilities: { pmsWrite: false, emailSend: false },
  };
  return { task, facts, runtime, attachmentAdmissions: [] as AttachmentAdmission[] };
}

describe('reservationist booking suggestion', () => {
  it('keeps unknown children distinct from explicitly child-free occupancy and uses a stable request-scoped group id', async () => {
    const unknown = await buildReservationistBookingSuggestion(plan(
      'Please book 1 room for 2 adults from 2026-12-03 to 2026-12-05.',
    ));
    expect(unknown?.status).toBe('prefill');
    expect(unknown?.facts.rooms[0]?.source).toBeDefined();
    expect(unknown?.missing).toContain('Child occupancy is unknown; confirm no children or provide every child’s age.');
    expect(unknown?.draft?.rooms).toHaveLength(1);
    expect(unknown?.draft?.rooms[0]?.request.childAges).toBeNull();

    const explicitZeroPlan = plan('Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05.');
    const explicitZero = await buildReservationistBookingSuggestion(explicitZeroPlan);
    const reread = await buildReservationistBookingSuggestion(explicitZeroPlan);
    expect(explicitZero?.status).toBe('prefill');
    expect(explicitZero?.draft?.rooms[0]?.request.childAges).toEqual([]);
    expect(explicitZero?.draft?.rooms).toHaveLength(1);
    expect(explicitZero?.groupId).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(explicitZero?.groupId).toBe(reread?.groupId);
    expect(reservationistBookingSuggestionGroupId(explicitZero!.source)).toBe(explicitZero?.groupId);
  });

  it('does not turn no infants into a zero-children assumption', async () => {
    const quote = '1 room for 2 adults with no infants';
    const input = plan(`Please book ${quote} from 2026-12-03 to 2026-12-05.`);
    input.facts = input.facts.map(fact => fact.kind === 'room'
      ? { ...fact, source: { ...fact.source, quote, end: fact.source.start! + quote.length } }
      : fact);
    const result = await buildReservationistBookingSuggestion(input);
    expect(result?.status).toBe('prefill');
    expect(result?.draft?.rooms[0]?.request.childAges).toBeNull();
    expect(result?.missing).toContain('Child occupancy is unknown; confirm no children or provide every child’s age.');
  });

  it('does not collapse the same room label from separate rooming lists', async () => {
    const input = plan('Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05.');
    const template = input.facts.find(fact => fact.kind === 'room')!;
    const quote = 'Room 1: 2 adults only';
    const sourceHash = createHash('sha256').update(quote).digest('hex');
    const ids = ['list-1', 'list-2'];
    input.facts = [input.facts[0]!, ...ids.map(attachmentId => ({
      ...template, id: attachmentId,
      source: { attachmentId, sourceHash, page: 1, start: 0, end: quote.length, quote },
    }))];
    input.attachmentAdmissions = ids.map(attachmentId => ({
      status: 'admitted', reason: 'text', relation: 'current', draftReady: false,
      metadata: { attachmentId, messageId: triggerId, ownerRef, threadId, sourceHash, disclosure: 'guest' },
      source: { attachmentId, sourceHash, disclosure: 'guest', pages: [quote], pageCount: 1 },
    } as AttachmentAdmission));
    const result = await buildReservationistBookingSuggestion(input);
    expect(result?.status).toBe('needs_details');
    expect(result?.missing).toContain('Room allocations conflict; staff must resolve them before preparing a booking.');
  });

  it('keeps an untyped party as a picker candidate and suppresses direct-individual defaults', async () => {
    const body = 'Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05 for ACME Travel.';
    const result = await buildReservationistBookingSuggestion(plan(body, [
      { kind: 'party', value: 'ACME Travel', quote: 'ACME Travel' },
    ]));
    const request = result?.draft?.rooms[0]?.request;
    expect(result?.partyNames).toEqual(['ACME Travel']);
    const partySource = result?.facts.parties[0]?.source;
    expect(partySource).toMatchObject({ sourceRef: 'message:message-1', start: body.indexOf('ACME Travel') });
    expect(body.slice(partySource!.start, partySource!.end)).toBe('ACME Travel');
    expect(result?.status).toBe('prefill');
    expect(request?.agency).toBeUndefined();
    expect(request?.organization).toBeUndefined();
    expect(request?.track).toBeUndefined();
    expect(request?.sourceOfBusiness).toBeUndefined();
    expect(request?.guaranteeType).toBeUndefined();
    expect(result?.missing).toContain('Staff must classify/select the named party or explicitly choose no linked party before preview.');
  });

  it('keeps multiple distinct party names in staff review instead of choosing one', async () => {
    const body = 'Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05 for ACME Travel or Beta Tours.';
    const result = await buildReservationistBookingSuggestion(plan(body, [
      { kind: 'party', value: 'ACME Travel', quote: 'ACME Travel' },
      { kind: 'party', value: 'Beta Tours', quote: 'Beta Tours' },
    ]));

    expect(result?.partyNames).toEqual(['ACME Travel', 'Beta Tours']);
    expect(result?.status).toBe('needs_details');
    expect(result?.draft).toBeUndefined();
    expect(result?.missing).toContain('Multiple party names are present; staff must resolve which party applies before preparing a booking.');
  });

  it('preserves the source-verified boundary of a compound surname', async () => {
    const body = 'Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05 for Mary Van der Merwe.';
    const result = await buildReservationistBookingSuggestion(plan(body, [{kind:'guest',value:{firstName:'Mary',lastName:'Van der Merwe',roomRef:'1',roomIndex:1},quote:'Mary Van der Merwe'}]));
    expect(result?.draft?.rooms[0]?.request).toMatchObject({firstName:'Mary',lastName:'Van der Merwe'});
  });

  it('uses an adult name, never a known child, for the booking guest', async () => {
    const body='Please book 1 room for 2 adults and Jane Sample age 7 from 2026-12-03 to 2026-12-05 with Alex Example.';
    const child={kind:'guest',value:{firstName:'Jane',lastName:'Sample',age:7,roomRef:'1'},quote:'Jane Sample age 7'};
    const adult={kind:'guest',value:{firstName:'Alex',lastName:'Example',roomRef:'1'},quote:'Alex Example'};
    const run=async(facts:Array<{kind:string;value:unknown;quote:string}>)=>{const input=plan(body,facts);input.facts=input.facts.map(fact=>fact.kind==='room'?{...fact,value:{...fact.value,childAges:[7]}}:fact);return buildReservationistBookingSuggestion(input);};
    const onlyChild=await run([child]);
    expect(onlyChild?.status).toBe('prefill');
    expect(onlyChild?.draft?.rooms[0]?.request.firstName).not.toBe('Jane');
    expect((await run([child,adult]))?.draft?.rooms[0]?.request).toMatchObject({firstName:'Alex',lastName:'Example'});
  });

  it.each([['RO','room_only'],['B&B','bb'],['dinner and breakfast','dinner_bb']] as const)('maps supported meal label %s', async (label,expected) => {
    const body = `Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05 with ${label}.`;
    const result = await buildReservationistBookingSuggestion(plan(body,[{kind:'board',value:label,quote:label}]));
    expect(result?.draft?.rooms[0]?.board).toBe(expected);
  });

  it('surfaces conflicting or unsupported meal choices for staff', async () => {
    const body = 'Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05 with BB or DBB.';
    const result = await buildReservationistBookingSuggestion(plan(body,[{kind:'board',value:'BB',quote:'BB'},{kind:'board',value:'DBB',quote:'DBB'}]));
    expect(result?.draft?.rooms[0]?.board).toBe('unknown');
    expect(result?.missing).toContain('Meal preferences conflict or are unsupported; staff must check the requested board.');
  });

  it('checks an HTML booking task against its own authored view, not plain text or quoted tails', async () => {
    const request = 'Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05.';
    const rendered = renderReservationistMessage({
      textBody: 'Do not reply to this email\n\nFrom: Previous guest\nSubject: Older request\nPlease do not create a booking.',
      htmlBody: `${request}\n\nFrom: Earlier correspondent\nSubject: Previous request\nPlease do not create a booking.`,
    });
    const htmlView = rendered.sourceViews?.find((view) => view.name === 'html');
    expect(htmlView?.quoted?.start).toBeGreaterThan(htmlView?.end ?? 0);
    const current = plan(rendered.text, [], rendered.sourceViews, request);
    expect(currentAuthoredGuestRequest(current.task, current.runtime)).toBe(true);
    const result = await buildReservationistBookingSuggestion(current);

    expect(result?.status).toBe('prefill');
    expect(result?.source.start).toBe(htmlView?.start);
    expect(result?.draft?.rooms).toHaveLength(1);

    const conflictRequest = 'Please book this room, 1 room for 2 adults only from 2026-12-03 to 2026-12-05.';
    const conflicting = renderReservationistMessage({ textBody: 'Do not book this room', htmlBody: conflictRequest });
    const conflict = plan(conflicting.text, [], conflicting.sourceViews, conflictRequest);
    expect(currentAuthoredGuestRequest(conflict.task, conflict.runtime)).toBe(false);

    const laterRefusal = renderReservationistMessage({ textBody: 'Do not book that room. Do not book this room.', htmlBody: conflictRequest });
    const laterConflict = plan(laterRefusal.text, [], laterRefusal.sourceViews, conflictRequest);
    expect(currentAuthoredGuestRequest(laterConflict.task, laterConflict.runtime)).toBe(false);

    const indefiniteRequest = 'Please book a room, 1 room for 2 adults only from 2026-12-03 to 2026-12-05.';
    const indefinite = renderReservationistMessage({ textBody: 'Do not book a room.', htmlBody: indefiniteRequest });
    const indefiniteConflict = plan(indefinite.text, [], indefinite.sourceViews, indefiniteRequest);
    expect(currentAuthoredGuestRequest(indefiniteConflict.task, indefiniteConflict.runtime)).toBe(false);

    const deferred = renderReservationistMessage({ textBody: 'Please book this room, but not yet.', htmlBody: conflictRequest });
    const deferredConflict = plan(deferred.text, [], deferred.sourceViews, conflictRequest);
    expect(currentAuthoredGuestRequest(deferredConflict.task, deferredConflict.runtime)).toBe(false);
  });

  it('does not prepare a booking the guest postponed', () => {
    const body = 'Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05, but not yet.';
    const current = plan(body);
    expect(currentAuthoredGuestRequest(current.task, current.runtime)).toBe(false);
    const missingName = plan('Please book 1 room for 2 adults only from 2026-12-03 to 2026-12-05, but the guest name is not yet available.');
    expect(currentAuthoredGuestRequest(missingName.task, missingName.runtime)).toBe(true);
  });

  it('uses current postscript stay facts but not the signature as a guest', async () => {
    const request = 'Please book my stay.';
    const body = `${request}\nKind regards\nAlice Signature\nP.S. 1 room for 2 adults only from 2026-12-03 to 2026-12-05.`;
    const current = plan(body, [], undefined, request);
    expect((await buildReservationistBookingSuggestion(current))?.status).toBe('prefill');
    const signature = plan(body, [{ kind: 'guest', value: { firstName: 'Alice', lastName: 'Signature' }, quote: 'Alice Signature' }], undefined, request);
    expect((await buildReservationistBookingSuggestion(signature))?.facts.guests).toEqual([]);
  });

  it('accepts another room without breakfast when the alternatives agree', async () => {
    const request = 'Please book another room without breakfast, 1 room for 2 adults only from 2026-12-03 to 2026-12-05.';
    const rendered = renderReservationistMessage({ textBody: request, htmlBody: `${request}\nKind regards\nGuest` });
    const current = plan(rendered.text, [], rendered.sourceViews, request);
    expect(currentAuthoredGuestRequest(current.task, current.runtime)).toBe(true);
    expect((await buildReservationistBookingSuggestion(current))?.status).toBe('prefill');
  });

  it('accepts a multipart booking specifying no children', async () => {
    const request='Please book 1 room for 2 adults with no children from 2026-12-03 to 2026-12-05.';
    const rendered=renderReservationistMessage({textBody:request,htmlBody:`${request}\nKind regards\nGuest`});
    const current=plan(rendered.text,[],rendered.sourceViews,request);
    expect(currentAuthoredGuestRequest(current.task,current.runtime)).toBe(true);
    expect((await buildReservationistBookingSuggestion(current))?.draft?.rooms[0]?.request.childAges).toEqual([]);
  });
});
