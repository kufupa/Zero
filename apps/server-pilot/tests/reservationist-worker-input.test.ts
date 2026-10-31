import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_NUMBER_GROUPS } from '../src/ai/card-mask.js';
import { buildReservationistWorkerInput, type ReservationistWorkerMessage } from '../src/ai/reservationist-worker-input.js';
import { validReservationistMessageViews, HTML_ALTERNATIVE_MARKER } from '../src/ai/reservationist-message-view.js';

const base = Date.now() - 600_000;
const at = (minutes: number) => new Date(base + minutes * 60_000);
const row = (id: string, minutes: number, overrides: Partial<ReservationistWorkerMessage> = {}): ReservationistWorkerMessage => ({
  id, transportId: 'mailbox', threadId: 'thread', direction: 'inbound', disclosure: 'guest',
  textBody: id, htmlBody: null, subject: null, receivedAt: at(minutes), sentAt: null,
  arrivedAt: at(minutes), createdAt: at(minutes), ...overrides,
});
type Build = Parameters<typeof buildReservationistWorkerInput>[0];
const manualReview: Build['admit'] = async (metadata) => ({
  status: 'manual_required', reason: 'test_manual_review', metadata, draftReady: false,
});
const build = (messages: Build['messages'], attachments: Build['attachments'] = [], overrides: Partial<Pick<Build, 'admit' | 'resolveSourceHash'>> = {}) =>
  buildReservationistWorkerInput({
    transportId: 'mailbox', threadId: 'thread', triggerMessageId: 'current', requestId: 'request', propertyCode: 'HRCEN',
    messages, attachments, sourceAt: new Date().toISOString(), deadlineAt: Date.now() + 60_000,
    signal: new AbortController().signal, admit: overrides.admit ?? manualReview,
    ...(overrides.resolveSourceHash ? { resolveSourceHash: overrides.resolveSourceHash } : {}),
  });

describe('reservationist worker input', () => {
  it('masks the subject and retains plain and HTML source views', async () => {
    const { input } = await build([row('current', 4, {
      textBody: 'Please quote. Card 4111 1111 1111 1111',
      htmlBody: '<p>Please quote the stay from 12/11.</p><p>Card 4111 1111 1111 1111</p>',
      subject: 'Rooms: 4111 1111 1111 1111',
    })]);
    const message = input.messages[0]!;
    expect(message.subject).toContain(AMBIGUOUS_NUMBER_GROUPS);
    expect(message.text).toContain('[card ••••1111]');
    expect(message.text).toContain(HTML_ALTERNATIVE_MARKER);
    expect(validReservationistMessageViews(message.text, message.sourceViews)).toBe(true);
    expect(input.capabilities).toEqual({ pmsWrite: false, emailSend: false });
  });

  it('uses mailbox arrival for chronological context and excludes later messages and files', async () => {
    const result = await build([
      row('first', 1, { textBody: 'Earlier guest request' }),
      row('staff', 2, { direction: 'outbound', disclosure: 'staff_only', textBody: 'Staff replied.' }),
      row('current', 4, { textBody: 'Please proceed.' }),
      row('late', 0, { arrivedAt: at(5), createdAt: at(5), receivedAt: at(0), textBody: 'Arrived after the request.' }),
    ], [
      { id: 'earlier-file', messageId: 'first', mimeType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: false, contentId: null, disclosure: 'guest' },
      { id: 'late-file', messageId: 'late', mimeType: 'text/plain', sizeBytes: 1, sha256: 'b'.repeat(64), isInline: false, contentId: null, disclosure: 'guest' },
    ]);
    expect(result.input.messages.map((message) => message.id)).toEqual(['first', 'staff', 'current']);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['earlier-file']);
    expect(result.input.authorizedArtifacts).toHaveLength(1);
  });

  it('filters a proven signature image but keeps one referenced by the current subject', async () => {
    const harmless = await build([row('current', 4, { textBody: 'Please quote two rooms.\nKind regards\nGuest\ncid:logo' })], [
      { id: 'logo', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: null, isInline: true, contentId: 'logo', disclosure: 'guest' },
    ]);
    expect(harmless.ignoredSignatures).toBe(1);
    expect(harmless.admissions).toEqual([]);

    const referenced = await build([
      row('prior', 1, { textBody: 'Hello\nKind regards\ncid:logo' }),
      row('current', 4, { textBody: 'Please proceed.', subject: 'Use that logo for the rooming list' }),
    ], [{ id: 'logo', messageId: 'prior', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'logo', disclosure: 'guest' }]);
    expect(referenced.ignoredSignatures).toBe(0);
    expect(referenced.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['logo']);
  });

  it('keeps an inline image requested only by the HTML alternative', async () => {
    const result = await build([
      row('prior', 1, { textBody: 'Hello\nKind regards\ncid:logo' }),
      row('current', 4, {
        textBody: 'Please proceed.',
        htmlBody: '<p>Please use the image below for rooming.</p><p>Kind regards</p><img src="cid:logo">',
      }),
    ], [{ id: 'logo', messageId: 'prior', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'logo', disclosure: 'guest' }]);
    expect(result.ignoredSignatures).toBe(0);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['logo']);
  });

  it('refuses missing or non-hash attachment identity before admission', async () => {
    let admissions = 0;
    const admit: Build['admit'] = async (metadata) => {
      admissions++;
      return { status: 'manual_required', reason: 'test_manual_review', metadata, draftReady: false };
    };
    const file = { id: 'file', messageId: 'current', mimeType: 'text/plain', sizeBytes: 1, sha256: null, isInline: false, contentId: null, disclosure: 'guest' as const };
    await expect(build([row('current', 4)], [file], { admit })).rejects.toThrow('worker_intake_attachment_identity_invalid');
    await expect(build([row('current', 4)], [file], { admit, resolveSourceHash: async () => 'metadata-only' }))
      .rejects.toThrow('worker_intake_attachment_identity_invalid');
    expect(admissions).toBe(0);
  });
});
