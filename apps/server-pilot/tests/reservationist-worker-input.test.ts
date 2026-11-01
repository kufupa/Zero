import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AMBIGUOUS_NUMBER_GROUPS } from '../src/ai/card-mask.js';
import { currentAuthoredGuestRequest } from '../src/ai/reservationist-execution.js';
import { extractReservationistPlan } from '../src/ai/reservationist-extraction.js';
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

  it('derives a yearless stay from the cited HTML view after a plain signoff, but not quoted history', async () => {
    const extractStay = (message: any, dateQuote: string, dateStart: number, taskQuote: string, taskStart: number) => {
      const sourceHash = createHash('sha256').update(message.text).digest('hex');
      const source = (quote: string, start: number) => ({ attachmentId: `message:${message.id}`, sourceHash, page: 1, quote, start, end: start + quote.length });
      return extractReservationistPlan({ adapter: { invoke: async () => ({ output: {
        facts: [{ id: 'stay', kind: 'dates', value: { arrival: '21 December', departure: '23 December' }, disclosure: 'guest', source: source(dateQuote, dateStart) }],
        tasks: [{ id: 'quote', kind: 'quote', factIds: ['stay'], source: source(taskQuote, taskStart) }], unresolvedAsks: [],
      } }) } as any, messages: [message], triggerMessageId: message.id, causalAt: message.at,
        admissions: [], signal: new AbortController().signal });
    };
    const at = new Date('2026-10-01T08:00:00.000Z');
    const htmlQuote = 'Please quote one room: Arrival 21 December; departure 23 December.';
    const { input } = await build([row('current', 4, {
      textBody: 'Please review my booking.\nKind regards\nGuest', htmlBody: `<p>${htmlQuote}</p>`, receivedAt: at, arrivedAt: at, createdAt: at,
    })]);
    const message = input.messages[0] as any, html = message.sourceViews.find((view: any) => view.name === 'html');
    const htmlStart = message.text.indexOf(htmlQuote, html.start);
    expect(message.text.indexOf('Kind regards')).toBeLessThan(html.start);
    expect(htmlStart).toBeGreaterThanOrEqual(html.start);
    const result = await extractStay(message, htmlQuote, htmlStart, htmlQuote, htmlStart);
    expect(result.facts[0]!.value).toMatchObject({ arrival: '2026-12-21', departure: '2026-12-23' });

    await expect(extractStay({ ...message, sourceViews: [{ ...message.sourceViews[0], start: 1 }, ...message.sourceViews.slice(1)] }, htmlQuote, htmlStart, htmlQuote, htmlStart))
      .rejects.toThrow('Invalid bounded causal extraction input');

    const plainQuote = 'Please rebook the same stay as previously quoted.';
    const oldDates = 'Arrival 21 December; departure 23 December';
    const { input: quotedInput } = await build([row('current', 4, {
      textBody: `${plainQuote}\nFrom: plain@example.invalid\nSubject: Prior stay\n\n${oldDates}`,
      htmlBody: `<p>Please confirm the earlier requested dates.</p><blockquote><p>From: html@example.invalid</p><p>Subject: Prior stay</p><p>${oldDates}</p></blockquote>`,
      receivedAt: at, arrivedAt: at, createdAt: at,
    })]);
    const quotedMessage = quotedInput.messages[0] as any, htmlHistory = quotedMessage.sourceViews.find((view: any) => view.name === 'html').quoted;
    const historyStart = quotedMessage.text.indexOf(oldDates, htmlHistory.start);
    const currentStart = quotedMessage.text.indexOf(plainQuote);
    await expect(extractStay(quotedMessage, oldDates, historyStart, plainQuote, currentStart))
      .rejects.toThrow('Yearless date source is quoted history');
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
    expect(views.map(view => message.text.slice(view.start, view.end))).toEqual([authored, '']);
    expect(message.text.match(/Please rebook the same stay as previously quoted\./g)).toHaveLength(1);
    expect(views.map(view => message.text.slice(view.quoted!.start, view.quoted!.end))).toEqual(expect.arrayContaining([
      expect.stringContaining('Arrival 21 December 2026'), expect.stringContaining('Arrival 22 December 2026'),
    ]));
    expect(validReservationistMessageViews(message.text, views)).toBe(true);
  });

  it('extracts one authored request when alternative quoted histories differ', async () => {
    const authored = 'Please send the tax certificate.';
    const { input } = await build([row('current', 4, {
      textBody: `${authored}\nFrom: plain@example.invalid\nSubject: Earlier\n\nPlain history.`,
      htmlBody: `<p>${authored}</p><blockquote><p>From: html@example.invalid</p><p>Subject: Earlier</p><p>HTML history.</p></blockquote>`,
    })]);
    const message = input.messages[0]!, sourceHash = createHash('sha256').update(message.text).digest('hex');
    const plan = await extractReservationistPlan({ adapter: { invoke: async () => ({ output: {
      facts: [], tasks: [{ id: 'certificate', kind: 'existing_document', factIds: [],
        source: { attachmentId: 'message:current', sourceHash, page: 1, quote: authored } }], unresolvedAsks: [],
    } }) } as any, messages: input.messages, triggerMessageId: 'current', causalAt: input.clock.causalAt,
      admissions: [], signal: new AbortController().signal });
    expect(plan.tasks).toMatchObject([{ id: 'certificate', source: { quote: authored, start: 0 } }]);
    expect(validReservationistMessageViews(message.text, message.sourceViews)).toBe(true);
  });

  it('keeps a shared request and an additional HTML request, without guessing across different contexts', async () => {
    const certificate = 'Please send the tax certificate.', checkin = 'Can we check in early?';
    const extract = async (plainPrefix = '', htmlPrefix = '', extra = '') => {
      const { input } = await build([row('current', 4, {
        textBody: `${plainPrefix}${certificate}\nKind regards`,
        htmlBody: `<p>${htmlPrefix}${certificate}</p><p>${checkin}</p><p>${extra}</p><p>Kind regards</p>`,
      })]);
      const message = input.messages[0]!, sourceHash = createHash('sha256').update(message.text).digest('hex');
      const tasks = [
        { id: 'certificate', kind: 'existing_document', factIds: [], source: { attachmentId: 'message:current', sourceHash, page: 1, quote: certificate } },
        { id: 'checkin', kind: 'question', factIds: [], source: { attachmentId: 'message:current', sourceHash, page: 1, quote: checkin } },
      ];
      let calls = 0;
      return extractReservationistPlan({ mode: 'task_first', adapter: {
        reserveCalls: async () => {},
        invoke: async () => ({ output: ++calls === 1
          ? { facts: [], tasks, unresolvedAsks: [] }
          : { facts: [], assignments: tasks.map(task => ({ taskId: task.id, factIds: [] })), unresolvedAsks: [] } }),
      } as any, messages: input.messages, triggerMessageId: 'current', causalAt: input.clock.causalAt,
        admissions: [], signal: new AbortController().signal });
    };
    const plan = await extract();
    expect(plan.tasks.map(task => task.id)).toEqual(['certificate', 'checkin']);
    expect(plan.tasks[0]!.source).toMatchObject({ quote: certificate, start: 0 });
    await expect(extract('Guest A: ', 'Guest B: ')).rejects.toThrow('Ambiguous original text span');
    await expect(extract('', '', 'Actually, do not send it.')).rejects.toThrow('Ambiguous original text span');
  });

  it('binds a shared stay fact across equivalent authored views', async () => {
    const stay = 'Please quote one room: Arrival 21 December; departure 23 December.';
    const checkin = 'Can we check in early?';
    const extract = async (plainPrefix = '', htmlPrefix = '', extra = '') => {
      const at = new Date('2026-10-01T08:00:00.000Z');
      const { input } = await build([row('current', 4, {
        textBody: `${plainPrefix}${stay}\nKind regards`,
        htmlBody: `<p>${htmlPrefix}${stay}</p><p>${checkin}</p><p>${extra}</p><p>Kind regards</p>`,
        receivedAt: at, arrivedAt: at, createdAt: at,
      })]);
      const message = input.messages[0]!, sourceHash = createHash('sha256').update(message.text).digest('hex');
      const source = (quote: string) => ({ attachmentId: 'message:current', sourceHash, page: 1, quote });
      return extractReservationistPlan({ adapter: { invoke: async () => ({ output: {
        facts: [{ id: 'stay', kind: 'dates', value: { arrival: '21 December', departure: '23 December' }, disclosure: 'guest', source: source(stay) }],
        tasks: [{ id: 'quote', kind: 'quote', factIds: ['stay'], source: source(stay) },
          { id: 'checkin', kind: 'question', factIds: [], source: source(checkin) }], unresolvedAsks: [],
      } }) } as any, messages: input.messages, triggerMessageId: 'current', causalAt: input.clock.causalAt,
        admissions: [], signal: new AbortController().signal });
    };
    const plan = await extract();
    expect(plan.facts[0]!.value).toMatchObject({ arrival: '2026-12-21', departure: '2026-12-23' });
    expect(plan.facts[0]!.source).toMatchObject({ quote: stay, start: 0 });
    await expect(extract('', '', 'I will need a taxi.')).resolves.toMatchObject({ facts: [{ id: 'stay' }] });
    await expect(extract('Guest A: ', 'Guest B: ')).rejects.toThrow('Ambiguous original text span');
  });

  it.each([false, true])('does not share a corrected fact (quoted history: %s)', async (history) => {
    const request = 'Please quote one room.', meal = 'Breakfast included.';
    const { input } = await build([row('current', 4, {
      textBody: `${request}\n${meal}\nKind regards${history ? `\nFrom: guest@example.invalid\nSubject: Prior\n\n${meal}` : ''}`,
      htmlBody: `<p>${request}</p><p>${meal}</p><p>Correction: breakfast is not included.</p><p>Kind regards</p>`,
    })]);
    const message = input.messages[0]!, sourceHash = createHash('sha256').update(message.text).digest('hex');
    const source = (quote: string) => ({ attachmentId: 'message:current', sourceHash, page: 1, quote });
    for (const selector of ['implicit', 'offset', 'view'] as const) {
      const start = message.text.indexOf(meal);
      await expect(extractReservationistPlan({ adapter: { invoke: async () => ({ output: {
        facts: [{ id: 'meal', kind: 'board', value: 'breakfast', disclosure: 'guest',
          source: { ...source(meal), ...(selector === 'offset' ? { start, end: start + meal.length } : {}),
            ...(selector === 'view' ? { view: 'plain' } : {}) } }],
        tasks: [{ id: 'quote', kind: 'quote', factIds: ['meal'], source: source(request) }], unresolvedAsks: [],
      } }) } as any, messages: input.messages, triggerMessageId: 'current', causalAt: input.clock.causalAt,
        admissions: [], signal: new AbortController().signal })).rejects.toThrow('Ambiguous original text span');
    }
  });

  it('retains an independent question about a shared meal fact', async () => {
    const request = 'Please quote one room.', meal = 'Breakfast included.', question = 'What time is breakfast?';
    const { input } = await build([row('current', 4, {
      textBody: `${request}\n${meal}\nKind regards`,
      htmlBody: `<p>${request}</p><p>${meal}</p><p>${question}</p><p>Kind regards</p>`,
    })]);
    const message = input.messages[0]!, sourceHash = createHash('sha256').update(message.text).digest('hex');
    const source = (quote: string) => ({ attachmentId: 'message:current', sourceHash, page: 1, quote });
    const plan = await extractReservationistPlan({ adapter: { invoke: async () => ({ output: {
      facts: [{ id: 'meal', kind: 'board', value: 'breakfast', disclosure: 'guest', source: source(meal) }],
      tasks: [{ id: 'quote', kind: 'quote', factIds: ['meal'], source: source(request) },
        { id: 'question', kind: 'question', factIds: [], source: source(question) }], unresolvedAsks: [],
    } }) } as any, messages: input.messages, triggerMessageId: 'current', causalAt: input.clock.causalAt,
      admissions: [], signal: new AbortController().signal });
    expect(plan.tasks.map(task => task.id)).toEqual(['quote', 'question']);
  });

  it('accepts matching corrected dates across views and rejects changed dates', async () => {
    const plain = 'Please quote the corrected stay from 21 December 2026 to 23 December 2026.';
    const extract = async (lastDay: number) => {
      const { input } = await build([row('current', 4, {
        textBody: plain, htmlBody: `<p>Please quote the amended stay from 21 December 2026 to ${lastDay} December 2026.</p>`,
      })]);
      const message = input.messages[0]!, sourceHash = createHash('sha256').update(message.text).digest('hex');
      const source = { attachmentId: 'message:current', sourceHash, page: 1, quote: plain, start: 0, end: plain.length };
      return extractReservationistPlan({ adapter: { invoke: async () => ({ output: {
        facts: [{ id: 'stay', kind: 'dates', value: { arrival: '21 December 2026', departure: '23 December 2026' }, disclosure: 'guest', source }],
        tasks: [{ id: 'quote', kind: 'quote', factIds: ['stay'], source }], unresolvedAsks: [],
      } }) } as any, messages: input.messages, triggerMessageId: 'current', causalAt: input.clock.causalAt,
        admissions: [], signal: new AbortController().signal });
    };
    await expect(extract(23)).resolves.toMatchObject({ facts: [{ id: 'stay', value: { arrival: '2026-12-21', departure: '2026-12-23' } }] });
    await expect(extract(24)).rejects.toThrow('Explicit same-stay correction requires source clarification');
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

  it('keeps an attached plan mentioned after the signoff while still filtering an unreferenced image CID', async () => {
    const plan = await build([row('current', 4, { textBody: 'Please quote one room.\nKind regards\nP.S. The attached floor plan shows the layout.\ncid:plan' })], [
      { id: 'plan', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'plan', disclosure: 'guest' },
    ]);
    expect(plan.ignoredSignatures).toBe(0);
    expect(plan.admissions.map((admission) => admission.metadata.attachmentId)).toEqual(['plan']);
    const logo = await build([row('current', 4, { textBody: 'Please quote one room.\nKind regards\nGuest\ncid:image' })], [
      { id: 'image', messageId: 'current', mimeType: 'image/png', sizeBytes: 1, sha256: null, isInline: true, contentId: 'image', disclosure: 'guest' },
    ]);
    expect(logo.ignoredSignatures).toBe(1);
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

  it('keeps an HTML heading-labelled business image without colon punctuation', async () => {
    const result = await build([row('current', 4, {
      textBody: null,
      htmlBody: '<p>Please quote one double room.</p><p>Kind regards</p>Guest<h2>Rates</h2><img src="cid:rates"><table><tr><td><p>Room A<br>Room B</p><p>Rate</p></td></tr></table>',
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

  it('routes missing identity and oversized attachments to staff without inventing a content hash', async () => {
    let admissions = 0;
    const admit: Build['admit'] = async (metadata) => {
      admissions++;
      return { status: 'manual_required', reason: 'test_manual_review', metadata, draftReady: false };
    };
    const file = { id: 'file', messageId: 'current', mimeType: 'text/plain', sizeBytes: 1, sha256: null, isInline: false, contentId: null, disclosure: 'guest' as const };
    for (const candidate of [file, { ...file, sha256: 'a'.repeat(64), sizeBytes: 21 * 1024 * 1024 }]) {
      const result = await build([row('current', 4)], [candidate], { admit, resolveSourceHash: async () => 'metadata-only' });
      expect(result.admissions[0]).toMatchObject({ status: 'manual_required', metadata: { sourceIdentity: 'metadata_only', attachmentId: 'file' } });
      expect(result.admissions[0]!.metadata.sourceHash).toBeUndefined();
    }
    expect(admissions).toBe(0);
  });

  it('counts hash-bound unread workbooks toward the aggregate attachment budget', async () => {
    const sizeBytes = 11 * 1024 * 1024;
    const workbook = (id: string, sha256: string) => ({
      id, messageId: 'current', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes, sha256, isInline: false, contentId: null, disclosure: 'guest' as const,
    });
    const result = await build([row('current', 4)], [workbook('first', 'a'.repeat(64)), workbook('second', 'b'.repeat(64))]);

    expect(result.admissions[0]).toMatchObject({ status: 'manual_required', metadata: { attachmentId: 'first', sourceHash: 'a'.repeat(64) } });
    expect(result.admissions[1]).toMatchObject({ status: 'manual_required', reason: 'attachment_total_resource_unavailable', metadata: { attachmentId: 'second', sourceIdentity: 'metadata_only' } });
    expect(result.admissions[1]!.metadata.sourceHash).toBeUndefined();
  });
});
