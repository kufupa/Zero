import {
  evaluateRocketseedReturnedCopyTrust,
  type RocketseedReturnedCopyTrustInput,
} from '../src/mail/ingest/rocketseed-returned-copy.js';
import { describe, expect, it } from 'vitest';

const trustedReceivedPrefix = [
  {
    key: 'received',
    line: 'Received: from 172.24.0.10 by local-hop-a; Mon, 24 Aug 2026 12:00:00 +0000',
  },
  {
    key: 'received',
    line: 'Received: from localhost by local-hop-b; Mon, 24 Aug 2026 12:00:01 +0000',
  },
  {
    key: 'received',
    line: 'Received: from localhost by rocketseed-edge-a; Mon, 24 Aug 2026 12:00:02 +0000',
  },
  {
    key: 'received',
    line: 'Received: from 172.24.0.8 by rocketseed-edge-b; Mon, 24 Aug 2026 12:00:03 +0000',
  },
  {
    key: 'received',
    line: 'Received: from branding.legacyhotels.co.za by archive.local; Mon, 24 Aug 2026 12:00:04 +0000',
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
        line: 'Received: from local-hop-c by local-hop-d; Mon, 24 Aug 2026 12:00:03 +0000',
      },
      trustedReceivedPrefix[3]!,
      trustedReceivedPrefix[4]!,
    ];

    expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
      trusted: false,
      reason: 'received_topology_mismatch',
    });
  });

  it('rejects lookalike Received source identities', () => {
    const lookalikes = [
      [0, 'Received: from 172.24.0.100 by local-hop-a; Mon, 24 Aug 2026 12:00:00 +0000'],
      [1, 'Received: from localhost.evil.test by local-hop-b; Mon, 24 Aug 2026 12:00:01 +0000'],
      [3, 'Received: from 172.24.0.80 by rocketseed-edge-b; Mon, 24 Aug 2026 12:00:03 +0000'],
      [
        4,
        'Received: from branding.legacyhotels.co.za.evil by archive.local; Mon, 24 Aug 2026 12:00:04 +0000',
      ],
    ] as const;

    for (const [index, line] of lookalikes) {
      const input = validInput();
      input.parsed.rawHeaderLines = trustedReceivedPrefix.map((header, headerIndex) =>
        headerIndex === index ? { ...header, line } : header,
      );

      expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
        trusted: false,
        reason: 'received_topology_mismatch',
      });
    }
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

  it('rejects Received values without a by identity or date tail', () => {
    const missingByIdentity = validInput();
    missingByIdentity.parsed.rawHeaderLines = [
      {
        key: 'received',
        line: 'Received: from 172.24.0.10 by ; Mon, 24 Aug 2026 12:00:00 +0000',
      },
      ...trustedReceivedPrefix.slice(1),
    ];
    expect(evaluateRocketseedReturnedCopyTrust(missingByIdentity)).toEqual({
      trusted: false,
      reason: 'received_malformed',
    });

    const missingDateTail = validInput();
    missingDateTail.parsed.rawHeaderLines = [
      { key: 'received', line: 'Received: from 172.24.0.10 by local-hop-a;' },
      ...trustedReceivedPrefix.slice(1),
    ];
    expect(evaluateRocketseedReturnedCopyTrust(missingDateTail)).toEqual({
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

  it('rejects malformed or multi-address owner and sender values', () => {
    const invalidOwners = [
      'junk <centurion@legacyhotels.co.za> trailing',
      '<centurion@legacyhotels.co.za>, <other@legacyhotels.co.za>',
    ];
    for (const ownerHeaderValue of invalidOwners) {
      const input = validInput();
      input.parsed.ownerHeaderValue = ownerHeaderValue;

      expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
        trusted: false,
        reason: 'owner_mismatch',
      });
    }

    const invalidSenders = [
      'Centurion <centurion@legacyhotels.co.za> trailing',
      '<centurion@legacyhotels.co.za>, <other@legacyhotels.co.za>',
    ];
    for (const fromAddress of invalidSenders) {
      const input = validInput();
      input.parsed.fromAddress = fromAddress;

      expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
        trusted: false,
        reason: 'sender_mismatch',
      });
    }
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
        line: 'Received: from older-hop.example by archive.local; Mon, 24 Aug 2026 11:59:59 +0000',
      },
    ];

    expect(evaluateRocketseedReturnedCopyTrust(input)).toEqual({
      trusted: true,
    });
  });
});
