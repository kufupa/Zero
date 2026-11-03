import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';
import { lookupPaneGuestProfiles, paneGuestProfileLoaders } from '../src/ai/pane-guest-profiles.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';

const mail = { id: 'mail-1', subject: 'Booking', textBody: 'Please book', htmlBody: null };
const input = { transportId: 'transport-centurion', actorUserId: 'user-1', workItemId: 'item-1',
  sourceMessageId: mail.id, threadId: 'thread-1', sourceHash: staffQuoteSourceHash(mail), lastName: 'Labtest' };
const result = { status: 'ok' as const, candidates: [{ nativeId: '42', firstName: 'Proof', lastName: 'Labtest',
  city: 'Pretoria', country: 'ZA' }], moreAvailable: false };
const search = vi.fn();

function fixture() {
  let rows = [{ itemThread: input.threadId, messageThread: input.threadId, itemMessage: input.sourceMessageId,
    messageId: input.sourceMessageId, transportId: input.transportId, actorUserId: input.actorUserId,
    active: true, status: 'needs_you', direction: 'inbound', messageHistoryOnly: false,
    threadHistoryOnly: false, threadTrashedAt: null as Date | null,
    subject: mail.subject, textBody: mail.textBody, htmlBody: mail.htmlBody as string | null }];
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => rows };
  const db = { select: () => query } as unknown as DB;
  return { db, rows: () => rows, set: (next: typeof rows) => { rows = next; } };
}

beforeEach(() => {
  paneGuestProfileLoaders.search = search.mockReset().mockResolvedValue(result);
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = vi.fn(async () => ({
    selected: { fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] },
    selectedFound: true, inbounds: [],
  }));
});
afterEach(() => { paneGuestProfileLoaders.search = null; mailboxHmsOriginBindLoaders.loadThreadOriginScan = null; });

describe('selected-mail guest profile read', () => {
  it('searches only after source and property checks, then rechecks them before returning results', async () => {
    const f = fixture();
    await expect(lookupPaneGuestProfiles({ ...input, db: f.db })).resolves.toEqual(result);
    expect(search).toHaveBeenCalledWith('Labtest');
    expect(mailboxHmsOriginBindLoaders.loadThreadOriginScan).toHaveBeenCalledTimes(2);
  });

  it('rejects another hotel, wrong or changed source, closed item and lost access before the read', async () => {
    const wrongProperty = fixture();
    await expect(lookupPaneGuestProfiles({ ...input, transportId: 'transport-davinci', db: wrongProperty.db }))
      .resolves.toEqual({ status: 'refused', reason: 'property_unavailable' });
    for (const change of [{ itemMessage: 'other' }, { messageId: 'other' }, { messageThread: 'other' },
      { actorUserId: 'other' }, { active: false }, { status: 'dismissed' }, { direction: 'outbound' },
      { messageHistoryOnly: true }, { threadHistoryOnly: true }, { threadTrashedAt: new Date() },
      { subject: 'Changed after selection' }]) {
      const f = fixture(); f.set([{ ...f.rows()[0]!, ...change }]);
      await expect(lookupPaneGuestProfiles({ ...input, db: f.db })).resolves.toEqual({ status: 'refused', reason: 'source_unavailable' });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects broad, wildcard and overlong surnames before opening a browser', async () => {
    const f = fixture();
    for (const lastName of ['L', '*', '%', 'Sm%', 'A'.repeat(41)]) {
      await expect(lookupPaneGuestProfiles({ ...input, lastName, db: f.db }))
        .resolves.toEqual({ status: 'refused', reason: 'invalid_name' });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('discards a response if the selected source or mailbox access changes during the read', async () => {
    for (const change of [{ textBody: 'Changed' }, { active: false }, { threadTrashedAt: new Date() }]) {
      const f = fixture();
      search.mockImplementationOnce(async () => { f.set([{ ...f.rows()[0]!, ...change }]); return result; });
      await expect(lookupPaneGuestProfiles({ ...input, db: f.db })).resolves.toEqual({ status: 'refused', reason: 'source_changed' });
    }
  });

  it('discards a response if origin changes while reading and refuses unvalidated output', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = vi.fn()
      .mockResolvedValueOnce({ selected: {}, selectedFound: true, inbounds: [] })
      .mockResolvedValueOnce({ selected: { toAddresses: ['davinci@legacyhotels.co.za'] }, selectedFound: true, inbounds: [] });
    const f = fixture();
    await expect(lookupPaneGuestProfiles({ ...input, db: f.db })).resolves.toEqual({ status: 'refused', reason: 'source_changed' });
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = vi.fn(async () => ({ selected: {}, selectedFound: true, inbounds: [] }));
    search.mockResolvedValueOnce({ ...result, candidates: [{ ...result.candidates[0], nativeId: 'not-a-native-id' }] });
    await expect(lookupPaneGuestProfiles({ ...input, db: f.db })).resolves.toEqual({ status: 'refused', reason: 'lookup_unavailable' });
  });
});
