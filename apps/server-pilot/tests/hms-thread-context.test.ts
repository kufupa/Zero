import { describe, expect, it, vi } from 'vitest';
import {
  THREAD_CONTEXT_MAX_BYTES,
  buildThreadContext,
  computeThreadStateVersion,
  extractLookupCandidates,
  normalizeMessageText,
  type ThreadContextMessage,
} from '../src/ai/thread-context.js';

function msg(partial: Partial<ThreadContextMessage> & Pick<ThreadContextMessage, 'id'>): ThreadContextMessage {
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
    const searchRelated = vi.fn(async (args: {
      transportId: string;
      threadId: string;
      query: string;
      maxResults: number;
    }) => {
      expect(args.transportId).toBe('transport-fixture');
      expect(args.threadId).toBe('thread-fixture');
      expect(args.maxResults).toBeLessThanOrEqual(20);
      return [{ messageId: 'msg-related-1', excerpt: 'CONF-88421 found in related mail' }];
    });

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
    expect(
      candidates.some((c) => c.kind === 'external_reference' && c.value === 'EXT-99102'),
    ).toBe(true);
    expect(candidates.every((c) => c.kind !== 'surname_dates' || (c.surname && c.arrivalDate))).toBe(
      true,
    );
    expect(candidates.some((c) => 'value' in c && c.value === 'hotel')).toBe(false);
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
