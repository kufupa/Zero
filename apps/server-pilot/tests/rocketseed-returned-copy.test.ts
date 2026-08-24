import {
  evaluateRocketseedReturnedCopyTrust,
  type RocketseedReturnedCopyTrustInput,
} from '../src/mail/ingest/rocketseed-returned-copy.js';
import { describe, expect, it } from 'vitest';

const trustedReceivedPrefix = [
  {
    key: 'received',
    line: 'Received: from zimbra.local by local-hop-a;',
  },
  {
    key: 'received',
    line: 'Received: from local-hop-a by local-hop-b;',
  },
  {
    key: 'received',
    line: 'Received: from local-hop-b by rocketseed-edge-a;',
  },
  {
    key: 'received',
    line: 'Received: from rocketseed-edge-a by rocketseed-edge-b;',
  },
  {
    key: 'received',
    line: 'Received: from rocketseed-edge-b by archive.local;',
  },
];

function validInput(): RocketseedReturnedCopyTrustInput {
  return {
    activeTransportId: 'transport-centurion',
    expectedTransportId: 'transport-centurion',
    expectedTransportAddress: 'centurion@legacyhotels.co.za',
    hasEligibleLocalSentQueueRow: true,
    parsed: {
      ownerHeaderValue: '<CENTURION@LEGACYHOTELS.CO.ZA>',
      fromAddress: 'Centurion <CENTURION@LEGACYHOTELS.CO.ZA>',
      rawHeaderLines: trustedReceivedPrefix,
    },
  };
}

describe('evaluateRocketseedReturnedCopyTrust', () => {
  it('trusts observed route when local correlations hold', () => {
    expect(evaluateRocketseedReturnedCopyTrust(validInput())).toEqual({
      trusted: true,
    });
  });

  it('rejects Rocketseed copied into a lower Received header', () => {
    const input = validInput();
    input.parsed.rawHeaderLines = [
      trustedReceivedPrefix[0]!,
      trustedReceivedPrefix[1]!,
      trustedReceivedPrefix[2]!,
      {
        key: 'received',
        line: 'Received: from local-hop-c by local-hop-d;',
      },
      trustedReceivedPrefix[3]!,
      trustedReceivedPrefix[4]!,
    ];

    expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
      trusted: false,
      reason: 'received_topology_mismatch',
    });
  });

  it('fails closed for missing or folded Received values', () => {
    const missing = validInput();
    missing.parsed.rawHeaderLines = [];

    expect(evaluateRocketseedReturnedCopyTrust(missing)).toEqual({
      trusted: false,
      reason: 'received_missing',
    });

    const folded = validInput();
    folded.parsed.rawHeaderLines = [
      {
        key: 'received',
        line: 'Received: from zimbra.local\r\n by local-hop-a;',
      },
      ...trustedReceivedPrefix.slice(1),
    ];

    expect(evaluateRocketseedReturnedCopyTrust(folded)).toEqual({
      trusted: false,
      reason: 'received_malformed',
    });
  });

  it('rejects a parsed sender that differs from transport address', () => {
    const input = validInput();
    input.parsed.fromAddress = 'other@legacyhotels.co.za';

    expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
      trusted: false,
      reason: 'sender_mismatch',
    });
  });

  it('rejects wrong active transport or owner stamp', () => {
    const wrongTransport = validInput();
    wrongTransport.activeTransportId = 'transport-nava';

    expect(evaluateRocketseedReturnedCopyTrust(wrongTransport)).toEqual({
      trusted: false,
      reason: 'transport_identity_mismatch',
    });

    const wrongOwner = validInput();
    wrongOwner.parsed.ownerHeaderValue = 'nava@legacyhotels.co.za';

    expect(evaluateRocketseedReturnedCopyTrust(wrongOwner)).toEqual({
      trusted: false,
      reason: 'owner_mismatch',
    });

    const missingExpectedAddress = validInput();
    missingExpectedAddress.expectedTransportAddress = '';
    missingExpectedAddress.parsed.ownerHeaderValue = null;
    missingExpectedAddress.parsed.fromAddress = null;

    expect(evaluateRocketseedReturnedCopyTrust(missingExpectedAddress)).toEqual({
      trusted: false,
      reason: 'owner_mismatch',
    });
  });

  it('rejects absent eligible local sent-queue row', () => {
    const input = validInput();
    input.hasEligibleLocalSentQueueRow = false;

    expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
      trusted: false,
      reason: 'sent_queue_row_missing',
    });
  });

  it('keeps trust when older Received hops follow the trusted prefix', () => {
    const input = validInput();
    input.parsed.rawHeaderLines = [
      ...trustedReceivedPrefix,
      {
        key: 'received',
        line: 'Received: from older-hop.example by archive.local;',
      },
    ];

    expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
      trusted: true,
    });
  });
});
