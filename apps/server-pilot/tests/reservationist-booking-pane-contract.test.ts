import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { readPreparedStaffTasks } from '../../mail/lib/quote-workflow/staff-quote-bind';
import { buildReservationistBookingSuggestion } from '../src/ai/reservationist-booking-suggestion.js';
import type { ValidatedDocumentFact } from '../src/ai/reservationist-document-facts.js';
import type { ReservationistRuntimeInput } from '../src/ai/reservationist-runtime.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { buildReservationistReviewSummary } from '../src/trpc/routes/drafts.js';

it('projects an unknown-child booking prefill through current-message review to the pane', async () => {
  const id = 'synthetic-mail', at = '2026-11-01T00:00:00.000Z';
  const body = 'Please book 1 room for 2 adults from 2027-12-03 to 2027-12-05.';
  const sourceHash = createHash('sha256').update(body).digest('hex');
  const staffHash = staffQuoteSourceHash({ id, subject: 'Booking', textBody: body, htmlBody: null });
  expect(staffHash).not.toBe(sourceHash);
  const source = (quote: string) => {
    const start = body.indexOf(quote);
    return { attachmentId: `message:${id}`, sourceHash, page: 1, quote, start, end: start + quote.length };
  };
  const facts = [
    { id: 'dates', kind: 'dates', value: { arrival: '2027-12-03', departure: '2027-12-05' },
      source: source('2027-12-03 to 2027-12-05'), disclosure: 'guest', verification: 'text_verified', authority: 'customer_claim' },
    { id: 'room', kind: 'room', value: { roomRef: '1', quantity: 1, adults: 2, childAges: [] },
      source: source('1 room for 2 adults'), disclosure: 'guest', verification: 'text_verified', authority: 'customer_claim' },
  ] as ValidatedDocumentFact[];
  const requestSource = source(body);
  const task = { id: 'booking', kind: 'new_booking', factIds: facts.map(fact => fact.id), source: requestSource } as const;
  const runtime: ReservationistRuntimeInput = {
    version: 1, requestId: id, propertyCode: 'HRCEN', trigger: { id, at },
    messages: [{ id, at, direction: 'inbound', text: body }],
    authorizationScope: { ownerRef: 'synthetic-mailbox', threadId: 'synthetic-thread' }, authorizedArtifacts: [],
    clock: { causalAt: at, sourceAt: at, deadlineAt: Date.now() + 30_000 },
    capabilities: { pmsWrite: false, emailSend: false },
  };
  const suggestion = await buildReservationistBookingSuggestion({ task, facts, runtime, attachmentAdmissions: [] });
  expect(suggestion?.status).toBe('prefill');
  const raw = { version: 1, readiness: 'needs_clarification', tasks: [{
    id: task.id, kind: task.kind, status: 'pending_pms_action', requestSource, bookingSuggestion: suggestion,
  }] };
  const projected = buildReservationistReviewSummary(raw, new Date(at), [], id, sourceHash, staffHash)!;
  const reviewSummary = { ...projected, tasks: projected.tasks.map(item => ({ ...item, runId: 'synthetic-run', handled: false })) };
  const envelope = { replyToMessageId: id, runId: 'synthetic-run', workItemId: 'synthetic-item', reviewSummary };
  const parsed = readPreparedStaffTasks(envelope);
  expect(parsed[0]).toMatchObject({ runId: 'synthetic-run', workItemId: 'synthetic-item', handled: false });
  expect(parsed[0]?.bookingSuggestion).toMatchObject({
    selectedMessageId: id, staffSourceHash: staffHash, source: { sourceHash },
    draft: { rooms: [{ request: { arrival: '2027-12-03', departure: '2027-12-05', adults: 2, childAges: null } }] },
  });
  const stale = buildReservationistReviewSummary(raw, new Date(at), [], id, 'f'.repeat(64), staffHash);
  expect(readPreparedStaffTasks({ ...envelope, reviewSummary: stale })[0]?.bookingSuggestion).toBeUndefined();
});
