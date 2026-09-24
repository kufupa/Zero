import {
  THREAD_CONTEXT_MAX_BYTES,
  buildThreadContext,
  computeThreadStateVersion,
  extractLookupCandidates,
  filterExactReservationCandidates,
  selectConnectedLookupCandidate,
  normalizeMessageText,
  type LookupCandidate,
  type ThreadContextMessage,
} from '../src/ai/thread-context.js';
import { describe, expect, it, vi } from 'vitest';

function msg(
  partial: Partial<ThreadContextMessage> & Pick<ThreadContextMessage, 'id'>,
): ThreadContextMessage {
  return {
    transportId: 'transport-fixture',
    threadId: 'thread-fixture',
    direction: 'inbound',
    textBody: null,
    htmlBody: null,
    subject: null,
    receivedAt: new Date('2026-07-01T12:00:00.000Z'),
    sentAt: null,
    attachmentIds: [],
    ...partial,
  };
}

describe('hms thread context', () => {
  it('reads the labelled SynXis external confirmation, not a card-link UUID prefix', () => {
    const body =
      'The following reservation has been booked through SynXis CR.\nConfirmation Number/Cancellation Number: 7777SG001234 / \nReservation Details: https://example.invalid/reservation?rezGuidList=88887777-3651-4321-abcd-123456789abc';
    const candidates = filterExactReservationCandidates(extractLookupCandidates(body));
    expect(candidates).toEqual([
      { id: expect.any(String), kind: 'external_reference', value: '7777SG001234' },
    ]);
  });

  it('does not admit a bare UUID prefix as a reservation confirmation', () => {
    expect(
      filterExactReservationCandidates(
        extractLookupCandidates(
          'Reservation details: https://example.invalid/reservation?rezGuidList=88887777-3651-4321-abcd-123456789abc',
        ),
      ),
    ).toEqual([]);
    expect(
      filterExactReservationCandidates(extractLookupCandidates('Booking for guest (88887777-1).')),
    ).toEqual([{ id: expect.any(String), kind: 'confirmation', value: '88887777-1' }]);
  });

  it('requires the SynXis source marker and exact combined confirmation label', () => {
    expect(
      extractLookupCandidates('Confirmation Number/Cancellation Number: 7777SG001234 /'),
    ).toEqual([]);
    expect(
      extractLookupCandidates(
        'The following reservation has been booked through SynXis CR.\nReservation Comments: 7777SG001234',
      ),
    ).toEqual([]);
  });
  it('always includes trigger and newest messages before older history', async () => {
    const trigger = msg({
      id: 'msg-trigger',
      textBody: 'TRIGGER_BODY',
      receivedAt: new Date('2026-07-10T10:00:00.000Z'),
    });
    const newest = msg({
      id: 'msg-newest',
      direction: 'outbound',
      textBody: 'NEWEST_OUTBOUND',
      receivedAt: new Date('2026-07-10T11:00:00.000Z'),
      sentAt: new Date('2026-07-10T11:00:00.000Z'),
    });
    // Oversized older history — must drop before dropping trigger/newest.
    const olderHuge = msg({
      id: 'msg-old-huge',
      textBody: 'O'.repeat(THREAD_CONTEXT_MAX_BYTES),
      receivedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const olderSmall = msg({
      id: 'msg-old-small',
      textBody: 'old-small',
      receivedAt: new Date('2026-06-02T00:00:00.000Z'),
    });

    const ctx = await buildThreadContext({
      transportId: 'transport-fixture',
      threadId: 'thread-fixture',
      triggerMessageId: trigger.id,
      messages: [olderHuge, olderSmall, trigger, newest],
      latestDraftRevisionId: null,
    });

    expect(ctx.includedMessageIds).toContain('msg-trigger');
    expect(ctx.includedMessageIds).toContain('msg-newest');
    expect(ctx.includedMessageIds[0]).toBe('msg-newest');
    expect(ctx.normalizedText).toContain('TRIGGER_BODY');
    expect(ctx.normalizedText).toContain('NEWEST_OUTBOUND');
    expect(ctx.includedMessageIds).not.toContain('msg-old-huge');
    expect(Buffer.byteLength(ctx.normalizedText, 'utf8')).toBeLessThanOrEqual(
      THREAD_CONTEXT_MAX_BYTES,
    );
  });

  it('measures UTF-8 bytes rather than string length', async () => {
    // Each emoji is 4 UTF-8 bytes; string.length counts code units differently.
    const emoji = '😀';
    expect(emoji.length).toBe(2);
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);

    const trigger = msg({
      id: 'msg-emoji-trigger',
      textBody: 'T',
      receivedAt: new Date('2026-07-10T10:00:00.000Z'),
    });
    const newest = msg({
      id: 'msg-emoji-newest',
      textBody: 'N',
      receivedAt: new Date('2026-07-10T11:00:00.000Z'),
    });
    // Fill remaining budget with multi-byte chars so char-length check would wrongly fit.
    const fillerChars = Math.floor((THREAD_CONTEXT_MAX_BYTES - 64) / 4);
    const older = msg({
      id: 'msg-emoji-old',
      textBody: emoji.repeat(fillerChars + 200),
      receivedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const ctx = await buildThreadContext({
      transportId: 'transport-fixture',
      threadId: 'thread-fixture',
      triggerMessageId: trigger.id,
      messages: [older, trigger, newest],
      latestDraftRevisionId: null,
    });

    expect(ctx.includedMessageIds).toEqual(
      expect.arrayContaining(['msg-emoji-trigger', 'msg-emoji-newest']),
    );
    expect(ctx.includedMessageIds).not.toContain('msg-emoji-old');
    expect(Buffer.byteLength(ctx.normalizedText, 'utf8')).toBeLessThanOrEqual(
      THREAD_CONTEXT_MAX_BYTES,
    );
    // Multi-byte chars: UTF-8 bytes exceed budget while JS string.length may not.
    expect(Buffer.byteLength(older.textBody!, 'utf8')).toBeGreaterThan(THREAD_CONTEXT_MAX_BYTES);
    expect(older.textBody!.length).toBeLessThan(Buffer.byteLength(older.textBody!, 'utf8'));
  });

  it('collapses quoted replies and sanitizes HTML', () => {
    const html = [
      '<p>Guest request for confirmation CONF-88421</p>',
      '<blockquote><p>On Mon, staff wrote: prior private note with script</p>',
      '<script>alert(1)</script></blockquote>',
      '<img src="javascript:alert(1)" />',
    ].join('');

    const normalized = normalizeMessageText({
      textBody: null,
      htmlBody: html,
    });

    expect(normalized).toContain('CONF-88421');
    expect(normalized).toContain('quoted-toggle');
    expect(normalized.toLowerCase()).not.toContain('<script');
    expect(normalized).not.toMatch(/javascript:/i);
  });

  it('keeps all queries transport and thread scoped', async () => {
    const searchRelated = vi.fn(
      async (args: {
        transportId: string;
        threadId: string;
        query: string;
        maxResults: number;
      }) => {
        expect(args.transportId).toBe('transport-fixture');
        expect(args.threadId).toBe('thread-fixture');
        expect(args.maxResults).toBeLessThanOrEqual(20);
        return [{ messageId: 'msg-related-1', excerpt: 'CONF-88421 found in related mail' }];
      },
    );

    const trigger = msg({
      id: 'msg-trigger',
      textBody: 'Please check confirmation CONF-88421 for arrival.',
      receivedAt: new Date('2026-07-10T10:00:00.000Z'),
    });

    const ctx = await buildThreadContext({
      transportId: 'transport-fixture',
      threadId: 'thread-fixture',
      triggerMessageId: trigger.id,
      messages: [trigger],
      latestDraftRevisionId: null,
      searchRelated,
    });

    expect(searchRelated).toHaveBeenCalled();
    const call = searchRelated.mock.calls[0]![0];
    expect(call.transportId).toBe('transport-fixture');
    expect(call.threadId).toBe('thread-fixture');
    expect(call.maxResults).toBe(20);
    expect(ctx.transportId).toBe('transport-fixture');
    expect(ctx.threadId).toBe('thread-fixture');
  });

  it('extracts only thread-present confirmation/external refs', () => {
    const text = [
      'Confirmation CONF-88421 please.',
      'External reference EXT-99102 on voucher.',
      'Also mention random word hotel.',
    ].join('\n');

    const candidates = extractLookupCandidates(text);
    expect(candidates.some((c) => c.kind === 'confirmation' && c.value === 'CONF-88421')).toBe(
      true,
    );
    expect(candidates.some((c) => c.kind === 'external_reference' && c.value === 'EXT-99102')).toBe(
      true,
    );
    expect(
      candidates.every((c) => c.kind !== 'surname_dates' || (c.surname && c.arrivalDate)),
    ).toBe(true);
    expect(candidates.some((c) => 'value' in c && c.value === 'hotel')).toBe(false);
  });

  it('extracts exact candidates from subject and dedupes body duplicates', async () => {
    const trigger = msg({
      id: 'msg-subject',
      subject: 'Confirmation CONF-88421',
      textBody: 'Please check confirmation CONF-88421.',
    });
    const ctx = await buildThreadContext({
      transportId: trigger.transportId,
      threadId: trigger.threadId,
      triggerMessageId: trigger.id,
      messages: [trigger],
      latestDraftRevisionId: null,
    });
    expect(
      ctx.lookupCandidates.filter(
        (candidate) => candidate.kind === 'confirmation' && candidate.value === 'CONF-88421',
      ),
    ).toHaveLength(1);
  });

  it('keeps complete multi-hyphen bare exact tokens', () => {
    const candidates = extractLookupCandidates('Use CONF-ABC-123-Z and EXT-WHOLESALE-88-2.');
    expect(candidates.filter((c) => c.kind !== 'surname_dates').map((c) => c.value)).toEqual([
      'CONF-ABC-123-Z',
      'EXT-WHOLESALE-88-2',
    ]);
  });

  it('extracts Centurion n° confirmation-letter subjects', () => {
    const text = 'The Centurion Hotel_Confirmation Letter_Synthetic Guest (n°79798256-1)';
    const candidates = extractLookupCandidates(text);
    expect(candidates.some((c) => c.kind === 'confirmation' && c.value === '79798256-1')).toBe(
      true,
    );
    expect(candidates.some((c) => c.kind === 'confirmation' && c.value === 'LETTER')).toBe(false);
    const exact = filterExactReservationCandidates(candidates);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.value).toBe('79798256-1');
  });

  it('extracts an unlabelled numeric booking ref only from authored booking context', () => {
    const candidates = extractLookupCandidates(
      'Booking from 2026-08-20 to 2026-08-24 for the guest (79798256-1).',
    );
    expect(candidates).toEqual([
      expect.objectContaining({ kind: 'confirmation', value: '79798256-1' }),
    ]);
    expect(extractLookupCandidates('> Booking for the guest (79798256-1).')).toEqual([]);
    expect(extractLookupCandidates('Reference number 12345')).toEqual([]);
  });

  it('extracts explicit booking/reference labels from the supplied body', () => {
    const candidates = extractLookupCandidates(
      [
        'booking reference: 6197775252',
        'reference (please use this number in correspondence)*: 6082002',
      ].join('\n'),
    );
    expect(candidates).toEqual([
      expect.objectContaining({ kind: 'confirmation', value: '6197775252' }),
      expect.objectContaining({ kind: 'confirmation', value: '6082002' }),
    ]);
    expect(extractLookupCandidates('reference number: 12345')).toEqual([]);
    expect(extractLookupCandidates('reference date: 2026-08-20')).toEqual([]);
    expect(extractLookupCandidates('> booking reference: 6197775252')).toEqual([
      expect.objectContaining({ kind: 'confirmation', value: '6197775252' }),
    ]);
  });

  it('classifies an anchored LekkeSlaap booking reference as external and suppresses its generic duplicate', () => {
    expect(
      extractLookupCandidates(
        'LekkeSlaap booking reference number: LS-SYNTH-55\nBooking Reference: LS-SYNTH-55',
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'external_reference', value: 'LS-SYNTH-55' }),
    ]);
  });

  it('keeps generic booking references as confirmations without the explicit provider label', () => {
    expect(extractLookupCandidates('Booking Reference: LS-SYNTH-55')).toEqual([
      expect.objectContaining({ kind: 'confirmation', value: 'LS-SYNTH-55' }),
    ]);
  });

  it('extracts one conservative surname/date candidate from natural hotel request prose', () => {
    const candidates = extractLookupCandidates(
      '> 1. L.E Seloana\n> Check in 24 August, check out 28 August 2026',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        kind: 'surname_dates',
        surname: 'Seloana',
        arrivalDate: '2026-08-24',
        departureDate: '2026-08-28',
      }),
    ]);
    expect(
      extractLookupCandidates(
        '1. L.E Seloana\n2. J.K Mokoena\nCheck in 24 August, check out 28 August 2026',
      ).filter((candidate) => candidate.kind === 'surname_dates'),
    ).toHaveLength(2);
  });

  it('filterExact drops pure-alpha false positives but keeps explicit prefixes', () => {
    const mixed: LookupCandidate[] = [
      { id: 'junk', kind: 'confirmation', value: 'LETTER' },
      { id: 'ok', kind: 'confirmation', value: '79798256-1' },
      { id: 'prefixed', kind: 'confirmation', value: 'CONF-ABC' },
      { id: 'e', kind: 'external_reference', value: 'EXT-99102' },
    ];
    expect(filterExactReservationCandidates(mixed).map((c) => c.value)).toEqual([
      '79798256-1',
      'CONF-ABC',
      'EXT-99102',
    ]);
  });

  it('never exposes S3 keys or arbitrary surname search to model', async () => {
    const trigger = msg({
      id: 'msg-trigger',
      textBody: 'Guest Smith arriving 2026-08-01 departing 2026-08-03. Conf CONF-100.',
      attachmentIds: ['att-authorized-1'],
      receivedAt: new Date('2026-07-10T10:00:00.000Z'),
    });

    const ctx = await buildThreadContext({
      transportId: 'transport-fixture',
      threadId: 'thread-fixture',
      triggerMessageId: trigger.id,
      messages: [trigger],
      latestDraftRevisionId: null,
    });

    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toMatch(/s3[_/]?key/i);
    expect(serialized).not.toContain('raw/mime');
    expect(ctx.authorizedAttachmentIds).toEqual(['att-authorized-1']);
    // Surname only allowed with both stay dates — never bare surname search.
    const surname = ctx.lookupCandidates.filter((c) => c.kind === 'surname_dates');
    for (const c of surname) {
      expect(c.surname.length).toBeGreaterThan(0);
      expect(c.arrivalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const c of ctx.lookupCandidates) {
      expect(c).toHaveProperty('id');
      expect(typeof c.id).toBe('string');
    }
  });

  it('filterExactReservationCandidates drops surname_dates for live session', () => {
    const mixed: LookupCandidate[] = [
      { id: 'c', kind: 'confirmation', value: 'CONF-1' },
      { id: 'e', kind: 'external_reference', value: 'EXT-99102' },
      {
        id: 's',
        kind: 'surname_dates',
        surname: 'Synthetic',
        arrivalDate: '2099-01-01',
        departureDate: '2099-01-03',
      },
    ];
    expect(filterExactReservationCandidates(mixed)).toEqual([
      { id: 'c', kind: 'confirmation', value: 'CONF-1' },
      { id: 'e', kind: 'external_reference', value: 'EXT-99102' },
    ]);
  });

  it('admits one connected surname/date candidate when no exact reference exists', () => {
    const candidate: LookupCandidate = {
      id: 's',
      kind: 'surname_dates',
      surname: 'Synthetic',
      arrivalDate: '2099-01-01',
      departureDate: '2099-01-03',
    };
    expect(selectConnectedLookupCandidate([candidate])).toEqual(candidate);
    expect(
      selectConnectedLookupCandidate([
        candidate,
        {
          id: 's2',
          kind: 'surname_dates',
          surname: 'Other',
          arrivalDate: '2099-01-01',
          departureDate: '2099-01-03',
        },
      ]),
    ).toBeNull();
  });

  it('prefers one exact connected reference over incidental surname/date text', () => {
    const exact: LookupCandidate = { id: 'c', kind: 'confirmation', value: 'CONF-1' };
    const surname: LookupCandidate = {
      id: 's',
      kind: 'surname_dates',
      surname: 'Synthetic',
      arrivalDate: '2099-01-01',
      departureDate: '2099-01-03',
    };
    expect(selectConnectedLookupCandidate([surname, exact])).toEqual(exact);
  });

  it('changes threadStateVersion after inbound, outbound, or sent revision', () => {
    const baseMessages = [
      {
        id: 'msg-1',
        direction: 'inbound' as const,
        timestamp: '2026-07-01T10:00:00.000Z',
      },
    ];
    const v0 = computeThreadStateVersion({
      messages: baseMessages,
      latestDraftRevisionId: 'rev-1',
    });
    const vInbound = computeThreadStateVersion({
      messages: [
        ...baseMessages,
        {
          id: 'msg-2',
          direction: 'inbound',
          timestamp: '2026-07-01T11:00:00.000Z',
        },
      ],
      latestDraftRevisionId: 'rev-1',
    });
    const vOutbound = computeThreadStateVersion({
      messages: [
        ...baseMessages,
        {
          id: 'msg-3',
          direction: 'outbound',
          timestamp: '2026-07-01T12:00:00.000Z',
        },
      ],
      latestDraftRevisionId: 'rev-1',
    });
    const vRevision = computeThreadStateVersion({
      messages: baseMessages,
      latestDraftRevisionId: 'rev-2',
    });

    expect(v0).toMatch(/^[a-f0-9]{64}$/);
    expect(vInbound).not.toBe(v0);
    expect(vOutbound).not.toBe(v0);
    expect(vOutbound).not.toBe(vInbound);
    expect(vRevision).not.toBe(v0);
  });
});
