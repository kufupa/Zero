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
  const roomQuote = body.includes('adults only') ? '1 room for 2 adults only' : '1 room for 2 adults';
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
    expect(unknown?.status).toBe('needs_details');
    expect(unknown?.facts.rooms[0]?.source).toBeDefined();
    expect(unknown?.missing).toContain('Child occupancy is unknown; confirm no children or provide every child’s age.');
    expect(unknown?.draft).toBeUndefined();

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
  });
});
