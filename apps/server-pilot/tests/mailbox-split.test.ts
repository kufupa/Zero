import {
  canonicalMailboxMessageKey,
  resolveMailboxPromotionRoute,
  summarizeMailboxSplitDryRun,
} from '../src/mail/ingest/mailbox-split.js';
import { describe, expect, it } from 'vitest';

const centurion = {
  id: 'transport-centurion',
  email: 'centurion@example.test',
  isActive: true,
  sendFromConfig: { aliases: ['centurion-alias@example.test'] },
};
const davinci = {
  id: 'transport-davinci-shared',
  email: 'davinci@example.test',
  isActive: false,
};

describe('mailbox split routing', () => {
  it('routes configured recipients inbound and configured senders outbound', () => {
    expect(
      resolveMailboxPromotionRoute(
        { fromAddress: 'guest@example.test', toAddresses: ['centurion-alias@example.test'] },
        [centurion],
      ),
    ).toEqual({ kind: 'routed', transportId: centurion.id, direction: 'inbound' });

    expect(
      resolveMailboxPromotionRoute(
        { fromAddress: 'centurion@example.test', toAddresses: ['guest@example.test'] },
        [centurion],
      ),
    ).toEqual({ kind: 'routed', transportId: centurion.id, direction: 'outbound' });
  });

  it('treats self-addressed mailbox loopback as inbound', () => {
    expect(
      resolveMailboxPromotionRoute(
        { fromAddress: 'centurion@example.test', toAddresses: ['centurion@example.test'] },
        [centurion],
      ),
    ).toEqual({ kind: 'routed', transportId: centurion.id, direction: 'inbound' });
  });

  it('fails closed when one message belongs to multiple configured mailboxes', () => {
    expect(
      resolveMailboxPromotionRoute(
        {
          fromAddress: 'centurion@example.test',
          toAddresses: ['davinci@example.test', 'guest@example.test'],
        },
        [centurion, { ...davinci, isActive: true }],
      ),
    ).toEqual({
      kind: 'ambiguous',
      routes: [
        { transportId: 'transport-centurion', direction: 'outbound' },
        { transportId: 'transport-davinci-shared', direction: 'inbound' },
      ],
    });
  });

  it('keeps inactive mailbox routes out unless preview explicitly includes them', () => {
    const signals = { fromAddress: 'guest@example.test', toAddresses: ['davinci@example.test'] };
    expect(resolveMailboxPromotionRoute(signals, [davinci])).toEqual({ kind: 'unmatched' });
    expect(resolveMailboxPromotionRoute(signals, [davinci], { includeInactive: true })).toEqual({
      kind: 'routed',
      transportId: davinci.id,
      direction: 'inbound',
    });
  });
});

describe('mailbox split dry-run summary', () => {
  it('uses normalized Message-ID then exact raw-content hash as the dedup key', () => {
    expect(canonicalMailboxMessageKey('<A.B@Example.test>', Buffer.from('one'))).toBe(
      'message-id:a.b@example.test',
    );
    expect(canonicalMailboxMessageKey(null, Buffer.from('same bytes'))).toBe(
      canonicalMailboxMessageKey(undefined, Buffer.from('same bytes')),
    );
    expect(canonicalMailboxMessageKey(null, Buffer.from('same bytes'))).not.toBe(
      canonicalMailboxMessageKey(null, Buffer.from('different bytes')),
    );
  });

  it('reports active candidates, inactive previews and duplicate counts without mail data', () => {
    const sameMessage = '<shared@example.test>';
    const summary = summarizeMailboxSplitDryRun(
      [
        {
          raw: Buffer.from('copy 1'),
          messageId: sameMessage,
          signals: { fromAddress: 'guest@example.test', toAddresses: ['centurion@example.test'] },
        },
        {
          raw: Buffer.from('copy 2'),
          messageId: sameMessage,
          signals: { fromAddress: 'guest@example.test', toAddresses: ['centurion@example.test'] },
        },
        {
          raw: Buffer.from('copy 3'),
          messageId: sameMessage,
          signals: { fromAddress: 'guest@example.test', toAddresses: ['davinci@example.test'] },
        },
      ],
      [centurion, davinci],
    );

    expect(summary).toMatchObject({
      scanned: 3,
      uniqueMessages: 1,
      duplicateCopies: 2,
      crossMailboxDuplicateKeys: 1,
      ambiguousRows: 0,
      unmatchedRows: 0,
      mailboxes: [
        {
          transportId: centurion.id,
          active: true,
          inboundCandidates: 2,
          wouldPromote: 2,
          uniqueCanonicalMessages: 1,
          duplicateCopies: 1,
        },
        {
          transportId: davinci.id,
          active: false,
          inboundCandidates: 1,
          wouldPromote: 0,
          wouldPromoteIfActivated: 1,
          uniqueCanonicalMessages: 0,
          duplicateCopies: 0,
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain(sameMessage);
    expect(JSON.stringify(summary)).not.toContain('guest@example.test');
  });
});
