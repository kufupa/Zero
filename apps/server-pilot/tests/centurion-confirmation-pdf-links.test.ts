import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkRecord, loadMessages } from '../scripts/centurion-confirmation-pdf-links.js';

describe('Centurion confirmation PDF links', () => {
  it('keeps confirmation candidates when both messages have no thread ID', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'centurion-links-unresolved-'));
    const corpus = path.join(directory, 'corpus.jsonl');
    try {
      writeFileSync(corpus, ['parent', 'candidate'].map((sourceRowId) => JSON.stringify({
        recordType: 'thread',
        threadId: null,
        messages: [{ sourceRows: [{ sourceRowId, body: 'Confirmation 123456', privateMessage: { canonicalHeaders: {} } }] }],
      })).join('\n'));
      const indexes = await loadMessages(corpus);
      const links = linkRecord({
        source: { attachment: { attachmentId: 'pdf-a' }, parentMessage: { messageDbId: 'parent' } },
        record: { links: {} },
        confirmationNumbers: [{ value: '123456', pageNumber: 1 }],
      }, indexes);
      expect(links.find((link) => link.messageDbId === 'parent')).toMatchObject({ tier: 1, reviewRequired: false });
      expect(links.find((link) => link.messageDbId === 'candidate')).toMatchObject({ tier: 2, reviewRequired: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('marks cross-thread confirmation matches for review while retaining exact thread and header links', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'centurion-links-'));
    const corpus = path.join(directory, 'corpus.jsonl');
    const thread = (threadId: string, sourceRows: unknown[]) => ({
      recordType: 'thread', threadId, messages: [{ sourceRows }],
    });
    try {
      writeFileSync(corpus, [
        thread('thread-a', [
          { sourceRowId: 'parent', messageId: '<parent@example.test>', privateMessage: { canonicalHeaders: { 'Message-ID': ['<parent@example.test>'] } } },
          { sourceRowId: 'same-thread', body: 'Confirmation 123456-1', privateMessage: { canonicalHeaders: {} } },
        ]),
        thread('thread-b', [
          { sourceRowId: 'candidate', body: 'Confirmation 123456-1', privateMessage: { canonicalHeaders: {} } },
          { sourceRowId: 'false-match', body: 'A123456-1B', privateMessage: { canonicalHeaders: {} } },
        ]),
        thread('thread-c', [
          { sourceRowId: 'header-link', privateMessage: { canonicalHeaders: { 'In-Reply-To': ['<parent@example.test>'] } } },
          { sourceRowId: 'header-case-link', privateMessage: { canonicalHeaders: { 'In-Reply-To': ['<PARENT@EXAMPLE.TEST>'] } } },
        ]),
      ].map((row) => JSON.stringify(row)).join('\n'));
      const indexes = await loadMessages(corpus);
      const item = {
        source: { attachment: { attachmentId: 'pdf-a' }, parentMessage: { messageDbId: 'parent' } },
        record: { links: {} },
        confirmationNumbers: [{ value: '123456-1', pageNumber: 1 }],
      };
      const links = linkRecord(item, indexes);
      expect(links).toHaveLength(5);
      expect(links.find((link) => link.messageDbId === 'parent')).toMatchObject({ tier: 1, reviewRequired: false });
      expect(links.find((link) => link.messageDbId === 'same-thread')).toMatchObject({ tier: 1, reviewRequired: false });
      expect(links.find((link) => link.messageDbId === 'header-link')).toMatchObject({ tier: 1, reviewRequired: false });
      expect(links.find((link) => link.messageDbId === 'header-case-link')).toMatchObject({ tier: 1, reviewRequired: false });
      expect(links.find((link) => link.messageDbId === 'candidate')).toMatchObject({ tier: 2, reviewRequired: true });
      expect(links.some((link) => link.messageDbId === 'false-match')).toBe(false);
      expect(item.record.links).toMatchObject({ confirmationNumberCandidateLinkedDbIds: ['candidate'] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
