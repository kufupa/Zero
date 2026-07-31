import {
  DEFAULT_ROCKETSEED_RELAY_IP,
  hasTrustedTopReceivedHeader,
  resolveTrustedRocketseedRelayIp,
} from '../src/mail/ingest/rocketseed-relay.js';
import { describe, expect, it } from 'vitest';

const received = (line: string) => ({ key: 'received', line });

describe('Rocketseed immediate relay trust', () => {
  it('trusts exact default IP in topmost Received header', () => {
    expect(
      hasTrustedTopReceivedHeader([
        received(
          'Received: from synthetic-rocketseed.example.invalid ([172.24.0.8]) by ingest.example.invalid',
        ),
        received(
          'Received: from attacker.example.invalid ([203.0.113.9]) by synthetic-rocketseed.example.invalid',
        ),
      ]),
    ).toBe(true);
    expect(DEFAULT_ROCKETSEED_RELAY_IP).toBe('172.24.0.8');
  });

  it('rejects trusted IP copied into a lower spoofable Received header', () => {
    expect(
      hasTrustedTopReceivedHeader([
        received(
          'Received: from attacker.example.invalid ([203.0.113.9]) by ingest.example.invalid',
        ),
        received(
          'Received: from synthetic-rocketseed.example.invalid ([172.24.0.8]) by attacker.example.invalid',
        ),
      ]),
    ).toBe(false);
  });

  it.each([
    'Received: from 172.24.0.8 (attacker.example.invalid [203.0.113.9]) by ingest.example.invalid',
    'Received: from attacker.example.invalid ([203.0.113.9]) by 172.24.0.8',
  ])('rejects trusted IP outside immediate peer literal: %s', (line) => {
    expect(hasTrustedTopReceivedHeader([received(line)])).toBe(false);
  });

  it.each([
    [[]],
    [[received('Received: malformed relay without IP')]],
    [[received('Received: from attacker.example.invalid ([1172.24.0.80])')]],
  ])('rejects missing, malformed, or non-exact top Received %#', (headers) => {
    expect(hasTrustedTopReceivedHeader(headers)).toBe(false);
  });

  it('accepts only an exact IP literal override', () => {
    const headers = [
      received(
        'Received: from synthetic-rocketseed.example.invalid ([203.0.113.42]) by ingest.example.invalid',
      ),
    ];
    expect(hasTrustedTopReceivedHeader(headers, '203.0.113.42')).toBe(true);
    expect(hasTrustedTopReceivedHeader(headers, '203.0.113.0/24')).toBe(false);
    expect(hasTrustedTopReceivedHeader(headers, 'relay.example.invalid')).toBe(
      false,
    );
    expect(hasTrustedTopReceivedHeader(headers, ' 203.0.113.42 ')).toBe(false);
    expect(resolveTrustedRocketseedRelayIp('203.0.113.42')).toBe(
      '203.0.113.42',
    );
  });
});
