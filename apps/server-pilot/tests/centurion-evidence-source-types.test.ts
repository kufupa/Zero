import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isCanonicalMailbox,
  normalizeOriginal,
  type EvidenceSourceInput,
  type EvidenceSources,
  type HeaderFieldCompleteness,
  type HeaderFields,
  type LinkerMessage,
  type MessageOccurrence,
} from '../scripts/centurion-evidence-source-types.js';

describe('original address normalization', () => {
  it('normalizes single mailboxes and comma lists without changing aliases or duplicates', () => {
    expect(normalizeOriginal('  Display Name <USER+Tag@EXAMPLE.TEST>  ')).toEqual(['user+tag@example.test']);
    expect(normalizeOriginal('"Last, First" <ONE@EXAMPLE.TEST>, two@example.test, two@example.test'))
      .toEqual(['one@example.test', 'two@example.test', 'two@example.test']);
    expect(normalizeOriginal('one@example.test,two@example.test')).toEqual(['one@example.test', 'two@example.test']);
    expect(normalizeOriginal('"guest@example.test" <guest@example.test>, other@example.test'))
      .toEqual(['guest@example.test', 'other@example.test']);
    expect(normalizeOriginal('"A \\"B\\"" <one@example.test>')).toEqual(['one@example.test']);
  });

  it('preserves quoted display names containing angle brackets', () => {
    expect(normalizeOriginal('"Guest <VIP>" <guest@example.test>, other@example.test'))
      .toEqual(['guest@example.test', 'other@example.test']);
  });

  it('rejects malformed or ambiguous input as a whole, never a partial list', () => {
    for (const value of [
      null, undefined, 1, [], '', '   ', 'not an address',
      'one@example.test, broken', 'one@example.test,', ',one@example.test',
      'Group: one@example.test;', 'Name; Other <one@example.test>',
      'Name <<one@example.test>>', 'Name <one@example.test', 'Name one@example.test>',
      '"Unclosed <one@example.test>',
      'one@@example.test', 'one @example.test', 'Name <one@example.test> trailing',
    ]) {
      expect(normalizeOriginal(value), String(value)).toBeNull();
    }
  });

  it('rejects definitely malformed mailboxes and preserves valid quoted and literal forms', () => {
    for (const value of ['guest@hotel:invalid', 'group:guest@example.test', 'guest@exa\x00mple.test',
      'guest@(invalid)', 'a..b@example.test', 'guest@.example.test', 'guest@example..test']) {
      expect(isCanonicalMailbox(value)).toBe(false);
      expect(normalizeOriginal(value)).toBeNull();
    }
    for (const value of ['x@y', 'guest+tag@example.test', '"quoted local"@example.test',
      '"a@b"@[IPv6:2001:db8::1]', 'guest@[127.0.0.1]']) {
      expect(isCanonicalMailbox(value)).toBe(true);
      expect(normalizeOriginal(value)).toEqual([value.toLowerCase()]);
    }
  });
});

describe('private source contract compatibility', () => {
  it('shares the linker and header shapes used by source occurrences', () => {
    const fields: HeaderFields = { messageIds: 'complete', inReplyTo: 'unknown', references: 'incomplete' };
    const message: LinkerMessage = {
      id: 'synthetic-occurrence',
      sourceIdentity: { source: 'synthetic-source', messageId: 'synthetic-id', verification: 'unresolved' },
      addressesByRole: { original_from: ['guest@example.test'], original_bcc: undefined },
      headerCompleteness: fields,
    };
    const occurrence: MessageOccurrence = {
      key: message.id,
      snapshot: { sourceId: 'synthetic-source', versionId: 'v1', snapshotId: 'snapshot' },
      sourceRowId: null,
      row: {},
      headers: { messageIds: [], inReplyTo: [], references: [] },
      headerFields: fields,
      linkerMessage: message,
      addressFields: { from: 'complete', to: 'complete', cc: 'unknown', bcc: 'incomplete' },
      originalAddressFields: { from: 'complete', to: 'complete', cc: 'unknown', bcc: 'incomplete' },
    };
    const input: EvidenceSourceInput = { snapshots: [], pdfInventories: [] };
    expectTypeOf<HeaderFields>().toEqualTypeOf<HeaderFieldCompleteness>();
    expectTypeOf<MessageOccurrence['linkerMessage']>().toEqualTypeOf<LinkerMessage>();
    expectTypeOf<EvidenceSources['linkerMessages']>().toEqualTypeOf<LinkerMessage[]>();
    expect(occurrence.linkerMessage.headerCompleteness).toEqual(fields);
    expect(input.snapshots).toEqual([]);
  });
});
