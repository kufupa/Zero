import { describe, expect, it } from 'vitest';
import { parseChannelPayloadBody } from '../src/mail/channel-payload-tool.js';

describe('body-only channel payload tool', () => {
  it('parses supplied forwarded body without artifact access', () => {
    const result = parseChannelPayloadBody({
      body: [
        '----- forwarded message -----',
        'WebBeds',
        'Booking Reference: WB-123',
        'Check-in: 2026-09-20',
        'Check-out: 2026-09-22',
        'Guest Name: Test Guest',
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      channel: 'webbeds',
      externalRef: 'WB-123',
      stayDates: { arrival: '2026-09-20', departure: '2026-09-22' },
    });
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed on unrecognized body; no artifactRef accepted', () => {
    const result = parseChannelPayloadBody({ body: 'not a channel message' });
    expect(result.status).toBe('manual_required');
    expect(result.data).toBeNull();
    expect(() => parseChannelPayloadBody({ artifactRef: 'mail-1' } as never)).toThrow();
  });
});
