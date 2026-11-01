import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AMBIGUOUS_NUMBER_GROUPS } from '../src/ai/card-mask.js';
import { currentAuthoredGuestRequest } from '../src/ai/reservationist-execution.js';
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
  it('keeps an HTML reply written after a quoted block in the authored request', async () => {
    const { input } = await build([row('current', 4, { textBody: null,
      htmlBody: '<blockquote><p>Earlier message</p></blockquote><p>Please send the tax certificate.</p><blockquote><p>Older context</p></blockquote>' })]);
    const message = input.messages[0]!, quote = 'Please send the tax certificate.', start = message.text.indexOf(quote);
    expect(start).toBeLessThan(message.text.indexOf('From: quoted history'));
    expect(message.text).toContain('Earlier message');
    expect(message.text).toContain('Older context');
    const task = {id:'certificate',kind:'existing_document',factIds:[],source:{attachmentId:'message:current',sourceHash:createHash('sha256').update(message.text).digest('hex'),page:1,quote,start,end:start+quote.length}};
    expect(currentAuthoredGuestRequest(task as any,input)).toBe(true);
  });
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

  it('binds quoted history to its own plain or HTML alternative', async () => {
    const { input } = await build([row('current', 4, {
      textBody: 'Please rebook the same stay as previously quoted.\nFrom: plain@example.invalid\nSubject: Prior stay\n\nArrival 21 December 2026; departure 23 December 2026',
      htmlBody: '<p>Please confirm the earlier requested dates.</p><blockquote><p>From: html@example.invalid</p><p>Subject: Alternate prior stay</p><p>Arrival 22 December 2026; departure 24 December 2026</p></blockquote>',
    })]);
    const message = input.messages[0]!, [plain, html] = message.sourceViews ?? [];
    expect(plain?.quoted).toBeDefined();
    expect(html?.quoted).toBeDefined();
    expect(message.text.slice(plain!.quoted!.start, plain!.quoted!.end)).toContain('Arrival 21 December 2026');
    expect(message.text.slice(html!.quoted!.start, html!.quoted!.end)).toContain('Arrival 22 December 2026');
    expect(validReservationistMessageViews(message.text, message.sourceViews)).toBe(true);
  });

  it('shares identical quoted history between differing authored views without duplicating it', async () => {
    const { input } = await build([row('current', 4, {
      textBody: 'Please review the earlier request.\nFrom: guest@example.invalid\nSubject: Prior stay\n\nPlease quote one room for one adult.',
      htmlBody: '<p>Please quote the earlier request.</p><p>From: guest@example.invalid</p><p>Subject: Prior stay</p><p>Please quote one room for one adult.</p>',
    })]);
    const message = input.messages[0]!, [plain, html] = message.sourceViews ?? [];
    expect(plain?.quoted).toBeDefined();
    expect(html?.quoted).toEqual(plain?.quoted);
    expect(message.text.match(/Please quote one room for one adult\./g)).toHaveLength(1);
    expect(validReservationistMessageViews(message.text, message.sourceViews)).toBe(true);
  });

  it('retains separate quoted ranges when plain and HTML authored bodies match', async () => {
    const authored = 'Please rebook the same stay as previously quoted.';
    const { input } = await build([row('current', 4, {
      textBody: `${authored}\nFrom: plain@example.invalid\nSubject: Prior stay\n\nArrival 21 December 2026; departure 23 December 2026`,
      htmlBody: `<p>${authored}</p><blockquote><p>From: html@example.invalid</p><p>Subject: Alternate prior stay</p><p>Arrival 22 December 2026; departure 24 December 2026</p></blockquote>`,
    })]);
    const message = input.messages[0]!, views = message.sourceViews ?? [];
    expect(views).toHaveLength(2);
    expect(views.map(view => message.text.slice(view.start, view.end))).toEqual([authored, authored]);
    expect(views.map(view => message.text.slice(view.quoted!.start, view.quoted!.end))).toEqual(expect.arrayContaining([
      expect.stringContaining('Arrival 21 December 2026'), expect.stringContaining('Arrival 22 December 2026'),
    ]));
    expect(validReservationistMessageViews(message.text, views)).toBe(true);
  });

  it('keeps HTML room rows when the plain alternative flattens them', async () => {
    const { input } = await build([row('current', 4, {
      textBody: 'Room 1: 1 adult Room 2: 2 adults',
      htmlBody: '<table><tr><td>Room 1: 1 adult</td></tr><tr><td>Room 2: 2 adults</td></tr></table>',
    })]);
    const message = input.messages[0]!;
    expect(message.text).toContain(HTML_ALTERNATIVE_MARKER);
    expect(message.text).toMatch(/Room 1: 1 adult[ \t]*\n+Room 2: 2 adults/);
    expect(message.sourceViews).toHaveLength(2);
  });

  it('uses mailbox arrival for chronological context and excludes later messages and files', async () => {
    const result = await build([
      row('first', 1, { textBody: 'Earlier guest request' }),
      row('staff', 2, { direction: 'outbound', disclosure: 'staff_only', sentAt: at(2), textBody: 'Staff replied.' }),
      row('current', 4, { textBody: 'Please proceed.' }),
      row('late', 0, { arrivedAt: at(5), createdAt: at(5), receivedAt: at(0), textBody: 'Arrived after the request.' }),
    ], [
      { id: 'earlier-file', messageId: 'first', mimeType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: false, contentId: null, disclosure: 'guest' },
      { id: 'late-file', messageId: 'late', mimeType: 'text/plain', sizeBytes: 1, sha256: 'b'.repeat(64), isInline: false, contentId: null, disclosure: 'guest' },
    ]);
    expect(result.input.messages.map((message) => message.id)).toEqual(['first', 'staff', 'current']);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['earlier-file']);
    expect(result.input.authorizedArtifacts).toHaveLength(1);
    await expect(build([row('current', 4, { arrivedAt: null })])).rejects.toThrow('worker_intake_clock_invalid');
  });

  it('uses sent time for outbound context and excludes queued or later sends', async () => {
    const { input } = await build([
      row('queued', 1, { direction: 'outbound', disclosure: 'staff_only', sentAt: null, receivedAt: at(1), textBody: 'Queued, not sent.' }),
      row('sent-before', 4, { direction: 'outbound', disclosure: 'staff_only', sentAt: at(2), receivedAt: at(5), arrivedAt: at(5), createdAt: at(1), textBody: 'Actually sent before the guest request.' }),
      row('sent-after', 1, { direction: 'outbound', disclosure: 'staff_only', sentAt: at(5), receivedAt: at(1), arrivedAt: at(1), createdAt: at(1), textBody: 'Actually sent after the guest request.' }),
      row('current', 4, { textBody: 'Current guest request.' }),
    ]);
    expect(input.messages.map((message) => message.id)).toEqual(['sent-before', 'current']);
    expect(input.messages[0]!.at).toBe(at(2).toISOString());
  });

  it('uses observed POP3 arrival, not a backdated email Date header', async () => {
    const { input } = await build([
      row('imported-before', 1, { direction: 'outbound', pop3Uidl: 'before', sentAt: null }),
      row('imported-after', 5, { direction: 'outbound', pop3Uidl: 'after', sentAt: at(1) }),
      row('returned-native-after', 1, { direction: 'outbound', pop3Uidl: 'returned', arrivedAt: at(1), createdAt: at(1), sentAt: at(5) }),
      row('outlook-sent-before', 5, { direction: 'outbound', pop3Uidl: 'synced', sourceProvenance: { canonicalContentVersion: '1' }, sentAt: at(2) }),
      row('current', 4),
    ]);
    expect(input.messages.map((message) => message.id)).toEqual(['imported-before', 'outlook-sent-before', 'current']);
    expect(input.messages[0]!.at).toBe(at(1).toISOString());
  });

  it('includes earlier timestamp ties without ordering them, but refuses trigger-time ties', async () => {
    const earlierAt = at(1);
    const { input } = await build([
      row('earlier-b', 1, { arrivedAt: earlierAt }),
      row('earlier-a', 1, { arrivedAt: earlierAt }),
      row('current', 4),
    ]);
    const tied = input.messages.filter((message) => message.id.startsWith('earlier-'));
    expect(tied.map((message) => message.id).sort()).toEqual(['earlier-a', 'earlier-b']);
    expect(tied.map((message) => message.at)).toEqual([earlierAt.toISOString(), earlierAt.toISOString()]);
    await expect(build([row('same-time', 4), row('current', 4)])).rejects.toThrow('worker_intake_order_ambiguous');
  });

  it('filters a proven signature image but keeps one referenced by the current subject', async () => {
    const harmless = await build([row('current', 4, { textBody: 'Please quote two rooms.\nKind regards\nGuest\nTel: 12345\nEmail: info@example.invalid\nWebsite: example.invalid\nhttps://hotel.example.invalid\ncid:logo' })], [
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

  it('filters a signature CID in HTML when the plain alternative omits it', async () => {
    const result = await build([row('current', 4, {
      textBody: 'Please quote two rooms.\nKind regards\nGuest',
      htmlBody: '<p>Please quote two rooms.</p><p>Kind regards</p><p>Guest</p><img src="cid:logo" alt="Company Logo">',
    })], [{ id: 'logo', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: null, isInline: true, contentId: 'logo', disclosure: 'guest' }]);
    expect(result.ignoredSignatures).toBe(1);
    expect(result.admissions).toEqual([]);

    const referencedByPlain = await build([row('current', 4, {
      textBody: 'Please use the image below for rooming.\nKind regards\nGuest',
      htmlBody: '<p>Please quote two rooms.</p><p>Kind regards</p><p>Guest</p><img src="cid:logo" alt="Company Logo">',
    })], [{ id: 'logo', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'logo', disclosure: 'guest' }]);
    expect(referencedByPlain.ignoredSignatures).toBe(0);
    expect(referencedByPlain.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['logo']);
  });

  it('keeps a business image labelled Rates after the signoff', async () => {
    const result = await build([row('current', 4, {
      textBody: 'Please quote one double room.\nKind regards,\nRates:\ncid:rates',
    })], [{ id: 'rates', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'rates', disclosure: 'guest' }]);
    expect(result.ignoredSignatures).toBe(0);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['rates']);
  });

  it('keeps colon-captioned business images after signoff', async () => {
    const image = { id: 'offer', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'offer', disclosure: 'guest' as const };
    for (const caption of ['Quote:', 'Rooming list:']) {
      const result = await build([row('current', 4, { textBody: `Please quote one room.\nKind regards\n${caption}\ncid:offer` })], [image]);
      expect(result.ignoredSignatures).toBe(0);
      expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['offer']);
    }
  });

  it('keeps quoted Gmail HTML images after the sender signoff', async () => {
    const result = await build([row('current', 4, {
      textBody: 'Please quote one room.\nKind regards\nGuest',
      htmlBody: '<p>Please quote one room.</p><p>Kind regards</p><p>Guest</p><div class="gmail_quote"><img src="cid:offer"></div>',
    })], [{ id: 'offer', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'offer', disclosure: 'guest' }]);
    expect(result.ignoredSignatures).toBe(0);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['offer']);
  });

  it('keeps an HTML heading-labelled business image after the signoff', async () => {
    const result = await build([row('current', 4, {
      textBody: null,
      htmlBody: '<p>Please quote one double room.</p><p>Kind regards</p>Guest<h2>Rates:</h2><img src="cid:rates"><table><tr><td><p>Room A<br>Room B</p><p>Rate</p></td></tr></table>',
    })], [{ id: 'rates', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'rates', disclosure: 'guest' }]);
    expect(result.ignoredSignatures).toBe(0);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['rates']);
    expect(result.input.messages[0]!.text).toMatch(/Room A\n+Room B\n+Rate/);
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

  it('keeps an earlier inline screenshot requested by a later message', async () => {
    const result = await build([
      row('prior', 1, { textBody: 'Hello\nKind regards\ncid:receipt' }),
      row('current', 4, { textBody: 'Please check the payment screenshot and confirm the booking.' }),
    ], [{ id: 'receipt', messageId: 'prior', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'receipt', disclosure: 'guest' }]);
    expect(result.ignoredSignatures).toBe(0);
    expect(result.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['receipt']);
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
