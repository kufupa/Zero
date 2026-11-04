import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { workItem } from '../src/db/schema/work.js';
import { approveHmsWrite, formDigest, storeHmsSnapshot } from '../src/ai/hms-approval.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { hmsApprovalRouter } from '../src/trpc/routes/hms-approval.js';

const transportId = 'transport-centurion';
const workItemId = '48a2ac3d-b4c8-48f1-a17e-4a8f1f31b3a6';
const selected = '<Selected@Example.com>';
const source = { id: 'message-1', threadId: 'thread-1', direction: 'inbound',
  transportId, messageIdHeader: 'selected@example.com', subject: 'Voucher', textBody: 'Original mail', htmlBody: null };

function fixture() {
  const item = { id: workItemId, transportId, sourceMessageId: source.id, threadId: source.threadId,
    status: 'needs_you', state: { action: 'amend', arrival: '2027-09-14' } };
  let messages = [{ ...source }];
  const operations: string[] = [];
  const dialect = new PgDialect();
  const select = vi.fn(() => {
    let table: unknown;
    let params: unknown[] = [];
    const query = {
      from: (value: unknown) => { table = value; return query; },
      where: (value: SQL) => { params = dialect.sqlToQuery(value).params; return query; },
      limit: (n: number) => {
        const rows = table === workItem
          ? (params.includes(item.id) && params.includes(item.transportId) ? [item] : [])
          : table === message
            ? messages.filter((row) => params[1] === row.messageIdHeader
              ? row.transportId === params[0] && (params.length === 2 || (row.id === params[2] && row.threadId === params[3]))
              : row.id === params[0] && row.transportId === params[1] && row.threadId === params[2] && row.direction === params[3])
            : [];
        const result = Promise.resolve(rows.slice(0, n));
        return Object.assign(result, { for: async (mode: string) => {
          operations.push(`${table === workItem ? 'item' : 'message'}:${mode}`);
          return result;
        } });
      },
    };
    return query;
  });
  const update = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  const insert = vi.fn(() => { throw new Error('unexpected insert'); });
  const db = { select, update, insert,
    execute: vi.fn(async () => { operations.push('mailbox:lock'); }),
    transaction: async (callback: (tx: DB) => Promise<unknown>) => callback(db as unknown as DB),
  } as unknown as DB;
  const caller = () => hmsApprovalRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: 'staff', email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId: transportId, accessRole: 'owner', transportEmail: 'hotel@example.invalid' } as never);
  return { db, item, update, insert, operations, caller, setMessages: (next: typeof messages) => { messages = next; } };
}

afterEach(() => __setDbForTests(null));

describe('approval selected-email scope', () => {
  it('requires a selected email on every mounted approval procedure', async () => {
    const f = fixture();
    __setDbForTests({ db: f.db, conn: null as never });
    const caller = f.caller();
    const missing = { workItemId };
    for (const request of [
      () => caller.writeState(missing as never), () => caller.reread(missing as never),
      () => caller.approve({ ...missing, formDigest: 'a'.repeat(64) } as never),
      () => caller.review({ ...missing, runId: workItemId, decision: 'ok' } as never),
      () => caller.resolveNeedsCheck({ ...missing, note: 'checked' } as never),
      () => caller.evidence({ ...missing, eventId: workItemId } as never),
    ]) await expect(request()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.operations).toEqual([]);
  });

  it('rejects wrong, ambiguous, outbound, cross-thread and cross-mailbox sources before approval', async () => {
    for (const messages of [[], [{ ...source, id: 'message-other' }], [source, { ...source, id: 'duplicate' }],
      [{ ...source, direction: 'outbound' }], [{ ...source, threadId: 'thread-other' }],
      [{ ...source, transportId: 'another-mailbox' }]]) {
      const f = fixture();
      f.setMessages(messages);
      await expect(approveHmsWrite({ db: f.db, transportId, workItemId, actorUserId: 'staff',
        selectedInternetMessageId: selected, formDigest: 'wrong' })).rejects.toMatchObject({ refusal: 'source_mail_changed' });
      expect(f.operations).toEqual(['mailbox:lock', 'item:update', 'message:share']);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.insert).not.toHaveBeenCalled();
    }
  });

  it('canonicalizes the selected header and admits an exact inbound source despite another identical header', async () => {
    const f = fixture();
    f.setMessages([source, { ...source, id: 'duplicate' }]);
    const selectedSource = { messageId: source.id, threadId: source.threadId, sourceHash: staffQuoteSourceHash(source) };
    await expect(approveHmsWrite({ db: f.db, transportId, workItemId, actorUserId: 'staff',
      selectedInternetMessageId: selected, selectedSource, formDigest: 'wrong' })).rejects.toMatchObject({ refusal: 'form_outdated' });
    expect(f.operations).toEqual(['mailbox:lock', 'item:update', 'message:share']);
    expect(f.insert).not.toHaveBeenCalled();
    for (const changed of [
      { ...selectedSource, sourceHash: '0'.repeat(64) },
      { ...selectedSource, messageId: 'duplicate' },
      { ...selectedSource, threadId: 'other-thread' },
    ]) {
      const mismatch = fixture();
      mismatch.setMessages([source, { ...source, id: 'duplicate' }]);
      await expect(approveHmsWrite({ db: mismatch.db, transportId, workItemId, actorUserId: 'staff',
        selectedInternetMessageId: selected, selectedSource: changed, formDigest: 'wrong' }))
        .rejects.toMatchObject({ refusal: 'source_mail_changed' });
      expect(mismatch.insert).not.toHaveBeenCalled();
    }
  });

  it('rejects a changed selection on each mounted action before a side effect', async () => {
    const f = fixture();
    __setDbForTests({ db: f.db, conn: null as never });
    const caller = f.caller();
    const input = { workItemId, internetMessageId: '<other@example.com>' };
    for (const request of [
      () => caller.writeState(input), () => caller.reread(input),
      () => caller.approve({ ...input, formDigest: 'a'.repeat(64) }),
      () => caller.review({ ...input, runId: workItemId, decision: 'ok' }),
      () => caller.resolveNeedsCheck({ ...input, note: 'checked' }),
      () => caller.evidence({ ...input, eventId: workItemId }),
    ]) await expect(request()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'source_mail_changed' });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('refuses to store a read made for a form or source that changed during HMS lookup', async () => {
    const f = fixture();
    const expectedFormDigest = formDigest(f.item.state);
    await expect(storeHmsSnapshot({ db: f.db, transportId, workItemId, selectedInternetMessageId: selected,
      expectedFormDigest, readHmsState: async () => { f.item.state.arrival = '2027-09-15'; return {}; },
    })).rejects.toMatchObject({ refusal: 'form_outdated' });
    expect(f.update).not.toHaveBeenCalled();
    f.item.state.arrival = '2027-09-14';
    await expect(storeHmsSnapshot({ db: f.db, transportId, workItemId, selectedInternetMessageId: selected,
      expectedFormDigest, readHmsState: async () => { f.item.sourceMessageId = 'message-other'; return {}; },
    })).rejects.toMatchObject({ refusal: 'source_mail_changed' });
    expect(f.update).not.toHaveBeenCalled();
  });
});
