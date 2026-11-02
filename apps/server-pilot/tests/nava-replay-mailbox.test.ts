import { loadReplayEmail, selectedReplayEmail } from '../scripts/nava-replay-mailbox';
import type { APIRequestContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

const message = (id: string) => ({
  id, threadId: 'thread-1', direction: 'inbound', isDraft: false,
  messageId: `<${id}@example.test>`, subject: `Subject ${id}`,
  sender: { email: 'guest@example.test', name: 'Guest' },
  to: [{ email: 'staff@example.test' }], cc: [{ email: 'other@example.test' }],
  receivedOn: '2026-10-19T10:00:00Z', body: `Body ${id}`, processedHtml: `<p>${id}</p>`,
});
const input = () => ({
  threadId: 'thread-1', messageId: 'first', transportId: 'mailbox-1', fakeStoreId: 'fake-store',
  thread: { id: 'thread-1', transportId: 'mailbox-1', messages: [message('first'), message('latest')] },
});

describe('current mailbox selection for replay', () => {
  it('returns the exact requested inbound message, not the latest one', () => {
    expect(selectedReplayEmail(input())).toMatchObject({ entryId: 'first', storeId: 'fake-store',
      folderEntryId: 'fake-inbox', internetMessageId: '<first@example.test>', bodyText: 'Body first',
      to: 'staff@example.test', cc: 'other@example.test' });
  });

  it('refuses missing, duplicate, outbound, wrong-mailbox and incomplete messages', () => {
    const baseline = input();
    for (const change of [
      { messageId: 'absent' },
      { transportId: 'wrong' },
      { threadId: 'other' },
      { fakeStoreId: '' },
      { thread: { ...baseline.thread, messages: [message('first'), message('first')] } },
      { thread: { ...baseline.thread, messages: [{ ...message('first'), direction: 'outbound' }] } },
      { thread: { ...baseline.thread, messages: [{ ...message('first'), isDraft: true }] } },
      { thread: { ...baseline.thread, messages: [{ ...message('first'), messageId: '' }] } },
      { thread: { ...baseline.thread, messages: [{ ...message('first'), threadId: 'other' }] } },
    ]) expect(selectedReplayEmail({ ...baseline, ...change })).toBeNull();
  });
});

describe('authenticated mailbox replay read', () => {
  it('reads through the app with exact transport and thread, without following redirects', async () => {
    const baseline = input();
    const post = vi.fn().mockResolvedValueOnce({ ok: () => true,
      json: async () => [{ result: { data: { json: baseline.thread } } }] })
      .mockResolvedValueOnce({ ok: () => true, json: async () => [{ result: { data: { json: {
        status: 'ready', messageId: 'first', threadId: 'thread-1', sourceHash: 'hash',
      } } } }] });
    const result = await loadReplayEmail({ ...baseline, origin: 'https://pilot.example',
      request: { post } as unknown as APIRequestContext });
    expect(result?.entryId).toBe('first');
    expect(post).toHaveBeenCalledWith('https://pilot.example/api/trpc/mail.get?batch=1', {
      headers: { 'x-zero-active-transport': 'mailbox-1', 'content-type': 'application/json' },
      data: { 0: { json: { id: 'thread-1' } } }, timeout: 15_000, maxRedirects: 0,
    });
    expect(post).toHaveBeenCalledWith('https://pilot.example/api/trpc/workstation.staffQuoteSource?batch=1', {
      headers: { 'x-zero-active-transport': 'mailbox-1', 'content-type': 'application/json' },
      data: { 0: { json: { internetMessageId: '<first@example.test>' } } }, timeout: 15_000, maxRedirects: 0,
    });
  });

  it('refuses unsynced, ambiguous or different stored message identities', async () => {
    const baseline = input();
    for (const source of [null, { status: 'message_not_synced' },
      { status: 'ready', messageId: 'latest', threadId: 'thread-1' },
      { status: 'ready', messageId: 'first', threadId: 'other' }]) {
      const post = vi.fn().mockResolvedValueOnce({ ok: () => true,
        json: async () => [{ result: { data: { json: baseline.thread } } }] })
        .mockResolvedValueOnce(source === null ? { ok: () => false } : { ok: () => true,
          json: async () => [{ result: { data: { json: source } } }] });
      expect(await loadReplayEmail({ ...baseline, origin: 'https://pilot.example',
        request: { post } as unknown as APIRequestContext })).toBeNull();
    }
  });

  it('requires current voucher attachment metadata when requested', async () => {
    const baseline = input();
    const reply = (json: unknown) => ({ ok: () => true, json: async () => [{ result: { data: { json } } }] });
    const source = { status: 'ready', messageId: 'first', threadId: 'thread-1' };
    const file = { id: 'file-1', filename: 'voucher.pdf', mimeType: 'application/pdf', sizeBytes: 42 };
    for (const voucher of [
      { status: 'voucher', messageId: 'first', threadId: 'thread-1', file },
      { status: 'voucher', messageId: 'first', threadId: 'thread-1', file: null },
      { status: 'voucher', messageId: 'latest', threadId: 'thread-1', file },
      { status: 'voucher', messageId: 'first', threadId: 'thread-1', file: { ...file, sizeBytes: 0 } },
    ]) {
      const post = vi.fn().mockResolvedValueOnce(reply(baseline.thread)).mockResolvedValueOnce(reply(source)).mockResolvedValueOnce(reply(voucher));
      const result = await loadReplayEmail({ ...baseline, origin: 'https://pilot.example', requireVoucherAttachment: true,
        request: { post } as unknown as APIRequestContext });
      if (voucher.file === file && voucher.messageId === 'first') expect(result?.sourceAttachment).toEqual(file);
      else expect(result).toBeNull();
    }
  });

  it('refuses bad origins, response errors, redirects, and unrecognized payloads', async () => {
    const baseline = input();
    const post = vi.fn();
    const args = { ...baseline, origin: 'https://pilot.example', request: { post } as unknown as APIRequestContext };
    expect(await loadReplayEmail({ ...args, origin: 'not-a-url' })).toBeNull();
    expect(await loadReplayEmail({ ...args, origin: 'https://pilot.example/path' })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValueOnce({ ok: () => false });
    expect(await loadReplayEmail(args)).toBeNull();
    post.mockResolvedValueOnce({ ok: () => true, json: async () => ({ result: {} }) });
    expect(await loadReplayEmail(args)).toBeNull();
    post.mockRejectedValueOnce(new Error('network'));
    expect(await loadReplayEmail(args)).toBeNull();
  });
});
