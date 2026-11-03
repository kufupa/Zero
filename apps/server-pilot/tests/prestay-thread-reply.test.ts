import { describe, expect, it } from 'vitest';
import { planThreadWork } from '../src/ai/work-items.js';
import type { DB } from '../src/db/client.js';

const mailbox = 'reservations@legacyhotels.co.za';
const ask = 'Please send the catering menu.';
const at = new Date('2027-01-01T10:00:00Z');
const replyAt = new Date('2027-01-01T11:00:00Z');

function mail(id: string, direction: 'inbound' | 'outbound', time: Date) {
  return { id, direction, fromAddress: mailbox, subject: 'Pre Stay Confirmation No 123456',
    textBody: `Existing stay. ${ask}`, htmlBody: null, receivedAt: time, deliveredAt: null,
    sentAt: direction === 'outbound' ? time : null, createdAt: time, historyOnly: false,
    pop3Uidl: null, outlookSynced: false };
}

/** Each awaited builder represents a selected database result; no database is contacted. */
function fixture(hasReply: boolean): DB {
  const rows: unknown[][] = [[{
    id: 'work-1', kind: 'other', status: 'done', sourceMessageId: 'mail-1', sentAt: null,
    sentMessageId: null, state: {}, hmsOpen: false, rejectedReplyId: null, touched: false,
    lastStatusActor: 'system', lastStatusReason: 'staff_sent_other', origin: 'person',
    extractionPayload: { confirmationNumbers: ['123456'], needsAction: true, action: 'other_actionable', separateAsk: ask },
  }], [], [], [{ messageId: 'mail-1', kind: 'other' }], [{ email: mailbox }],
  [mail('mail-1', 'inbound', at), ...(hasReply ? [mail('reply-1', 'outbound', replyAt)] : [])], [{ from: mailbox }]];
  const query = () => {
    const result = rows.shift();
    if (!result) throw new Error('Unexpected database query');
    const chain: Promise<unknown[]> & Record<string, unknown> = Object.assign(Promise.resolve(result), {});
    for (const name of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'limit', 'for']) chain[name] = () => chain;
    return chain;
  };
  return { select: query, selectDistinct: query, selectDistinctOn: query } as unknown as DB;
}

describe('re-reading a self-sent pre-stay request', () => {
  const input = { transportId: 'transport-centurion', threadId: 'thread-1' };

  it('keeps an answered request closed and links the later staff reply', async () => {
    expect(await planThreadWork(fixture(true), input)).toEqual([
      { workItemId: 'work-1', kind: 'other', repoint: { sentAt: replyAt, sentMessageId: 'reply-1' } },
    ]);
  });

  it('reopens an unanswered request that was closed as staff-sent', async () => {
    expect(await planThreadWork(fixture(false), input)).toEqual([
      expect.objectContaining({ workItemId: 'work-1', to: 'needs_you', reason: 'requests_outstanding' }),
    ]);
  });
});
