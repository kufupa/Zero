import {
  connectedCasePairedReplyMessageIdSha256Input,
  connectedCaseSchema,
  connectedCaseTriggerMessageId,
} from '../src/hms/connected-case-contract.js';
import { describe, expect, it } from 'vitest';

const incoming = {
  body: 'Confirmation: 33387876-1',
  subject: 'source subject',
  sender: 'staff@example.test',
  timestamp: '2026-09-17T10:00:00.000Z',
};

describe('connected case trigger provenance', () => {
  it('accepts a real incoming message ID without paired reply metadata', () => {
    const parsed = connectedCaseSchema.parse({
      schemaVersion: 'connected-read-case/v1',
      caseId: 'CORPUS-one',
      propertyCode: 'HRCEN',
      incoming: { ...incoming, messageId: 'incoming-message-id@example.test' },
    });

    expect(connectedCaseTriggerMessageId(parsed)).toBe('incoming-message-id@example.test');
    expect(connectedCasePairedReplyMessageIdSha256Input(parsed)).toBeNull();
  });

  it('retains legacy paired-reply fallback when incoming ID is absent', () => {
    const parsed = connectedCaseSchema.parse({
      schemaVersion: 'connected-read-case/v1',
      caseId: 'CORPUS-legacy',
      propertyCode: 'HRCEN',
      incoming,
      pairedReply: {
        messageId: 'hotel-reply-id@example.test',
        timestamp: '2026-09-17T10:01:00.000Z',
      },
    });

    expect(connectedCaseTriggerMessageId(parsed)).toBe('hotel-reply-id@example.test');
    expect(connectedCasePairedReplyMessageIdSha256Input(parsed)).toBe(
      'hotel-reply-id@example.test',
    );
  });

  it('fails closed when neither message provenance field exists', () => {
    expect(() =>
      connectedCaseSchema.parse({
        schemaVersion: 'connected-read-case/v1',
        caseId: 'CORPUS-invalid',
        propertyCode: 'HRCEN',
        incoming,
      }),
    ).toThrow(/incoming\.messageId|pairedReply/);
  });

  it('rejects paired reply metadata that predates the incoming message', () => {
    expect(() =>
      connectedCaseSchema.parse({
        schemaVersion: 'connected-read-case/v1',
        caseId: 'CORPUS-ordering',
        propertyCode: 'HRCEN',
        incoming,
        pairedReply: {
          messageId: 'hotel-reply-id@example.test',
          timestamp: '2026-09-17T09:59:59.000Z',
        },
      }),
    ).toThrow(/pairedReply.*incoming|chronological|follow/i);
  });
});
