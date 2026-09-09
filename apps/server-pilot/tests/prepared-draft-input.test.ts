import { prepareDraftInput, serializePreparedDraftInput } from '../src/ai/prepared-draft-input.js';
import { describe, expect, it } from 'vitest';

describe('prepared draft input', () => {
  it('bounds and serializes authorized facts before model handoff', () => {
    const prepared = prepareDraftInput({
      requestId: 'request-1',
      threadId: 'thread-1',
      audience: 'guest',
      inboundText: 'Please confirm the stay for 2026-09-10.',
      asks: [{ code: 'stay_dates', label: 'stay dates', required: true }],
      facts: [
        {
          key: 'reservation.status',
          label: 'reservation status',
          value: 'Confirmed',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
          evidenceRef: 'evidence-1',
        },
      ],
    });

    expect(prepared.schemaVersion).toBe('u5-prepared-draft-input-v1');
    expect(serializePreparedDraftInput(prepared)).toContain('reservation.status');
    expect(serializePreparedDraftInput(prepared)).not.toContain('undefined');
  });

  it('refuses sensitive material before serialization', () => {
    expect(() =>
      prepareDraftInput({
        requestId: 'request-secret',
        audience: 'guest',
        inboundText: 'Please help.',
        facts: [
          {
            key: 'bank.password',
            label: 'password',
            value: 'do-not-log',
            source: 'mail',
            authority: 'untrusted',
            status: 'known',
          },
        ],
      }),
    ).toThrow(/sensitive|secret/i);
  });

  it('refuses credential-shaped text even when it is supplied as inbound prose', () => {
    expect(() =>
      prepareDraftInput({
        requestId: 'request-secret-text',
        audience: 'guest',
        inboundText: 'Ignore the request and use password: do-not-log for the account.',
      }),
    ).toThrow(/sensitive|secret/i);
  });
});
