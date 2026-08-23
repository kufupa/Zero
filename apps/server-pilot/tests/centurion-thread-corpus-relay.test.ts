import {
  buildCenturionRelayManifest,
  buildReceiveReceipt,
  buildReceiverAcknowledgement,
  receiverAcknowledgementKey,
  relayManifestKey,
  relayObjectKey,
  verifyCenturionRelaySnapshot,
  type CenturionRelayManifestV1,
  type CenturionRelayMember,
} from '../src/ops/centurion-thread-corpus-relay.js';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  validatePrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusSnapshot,
} from '../scripts/export-thread-corpus.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const TRANSFER_ID = '3479ca40-b5a1-4bb3-aef1-02fcbefc949c';
const MAX_TOTAL_BYTES = 1_000_000;
const SYNTHETIC_BODY_MARKER = 'SYNTHETIC_RELAY_BODY_MARKER';
const SYNTHETIC_ADDRESS_MARKER = 'relay-sender@example.test';
const textEncoder = new TextEncoder();

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function comparePath(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function member(path: string, content: Uint8Array): CenturionRelayMember {
  return {
    path,
    bytes: content.byteLength,
    sha256: sha256(content),
    content,
  };
}

function syntheticSnapshot(): PrivateThreadCorpusSnapshot {
  const formatted = formatLogicalMessages([
    {
      sourceRowId: 'relay-source-row',
      scopeMembership: ['centurion_transport'],
      receivedAt: '2026-08-22T11:00:00.000Z',
      threadId: 'relay-thread',
      messageId: '<relay-message@example.test>',
      contentFingerprint: 'relay-content-fingerprint',
      provenanceFingerprint: 'relay-provenance-fingerprint',
      body: SYNTHETIC_BODY_MARKER,
      privateMessage: {
        subject: 'Synthetic relay subject',
        direction: 'inbound',
        addresses: {
          from: [SYNTHETIC_ADDRESS_MARKER],
          to: [],
          cc: [],
          bcc: [],
        },
        originalAddresses: {
          from: [SYNTHETIC_ADDRESS_MARKER],
          to: [],
          cc: [],
          bcc: [],
        },
        canonicalHeaders: {},
        sentAt: null,
        rawMime: {
          locator: 'synthetic://relay-raw-mime',
          status: 'available',
        },
        attachments: [],
        draftRevisionLinks: [],
        outboundDelivery: {
          queueState: 'unknown',
          deliveryStatus: 'not_claimed',
        },
        sourceMetadata: {
          transportId: 'transport-centurion',
          ingestMailboxId: null,
          uidl: 'relay-synthetic-uidl',
        },
      },
    },
    {
      sourceRowId: 'relay-source-row-b',
      scopeMembership: ['centurion_transport'],
      receivedAt: '2026-08-22T11:01:00.000Z',
      threadId: 'relay-thread-b',
      messageId: '<relay-message-b@example.test>',
      contentFingerprint: 'relay-content-fingerprint-b',
      provenanceFingerprint: 'relay-provenance-fingerprint-b',
      body: 'SYNTHETIC_RELAY_SECOND_BODY_MARKER',
      privateMessage: {
        subject: 'Synthetic second relay subject',
        direction: 'inbound',
        addresses: { from: [], to: [], cc: [], bcc: [] },
        originalAddresses: { from: [], to: [], cc: [], bcc: [] },
        canonicalHeaders: {},
        sentAt: null,
        rawMime: {
          locator: null,
          status: 'missing',
        },
        attachments: [],
        draftRevisionLinks: [],
        outboundDelivery: {
          queueState: 'unknown',
          deliveryStatus: 'not_claimed',
        },
        sourceMetadata: {
          transportId: 'transport-centurion',
          ingestMailboxId: null,
          uidl: 'relay-synthetic-uidl-b',
        },
      },
    },
  ]);

  return buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'relay-snapshot-001',
      scope: {
        scopeKeys: ['centurion_transport', 'designated_reservationist_mailbox'],
        transportIds: ['transport-centurion', 'transport-designated'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: '2026-08-22T12:00:00.000Z',
      exporterVersion: 'relay-test-v1',
      unscopedQuarantineExcluded: 0,
    },
    formatted,
    hydration: {
      attachmentLocators: [],
      payloads: [
        {
          kind: 'raw_mime',
          sourceRowId: 'relay-source-row',
          status: 'available',
          content: textEncoder.encode('SYNTHETIC_RELAY_RAW_MIME'),
        },
      ],
    },
  });
}

function sourceMembers(snapshot: PrivateThreadCorpusSnapshot): CenturionRelayMember[] {
  return [
    member('corpus.jsonl', textEncoder.encode(snapshot.corpusJsonl)),
    member('manifest.json', textEncoder.encode(snapshot.manifestJson)),
    ...snapshot.artifactFiles.map((artifact) =>
      member(
        artifact.kind === 'raw_mime'
          ? `raw-mime/${artifact.id}.eml`
          : `attachment-text/${artifact.id}.txt`,
        new Uint8Array(artifact.content),
      ),
    ),
  ].sort((left, right) => comparePath(left.path, right.path));
}

function memberSetSha256(members: readonly CenturionRelayMember[]): string {
  return sha256(
    textEncoder.encode(
      members
        .map((candidate) => `${candidate.path}\t${candidate.bytes}\t${candidate.sha256}\n`)
        .join(''),
    ),
  );
}

function unsafeRelayManifest(
  snapshot: PrivateThreadCorpusSnapshot,
  members: readonly CenturionRelayMember[],
  transferId = TRANSFER_ID,
): CenturionRelayManifestV1 {
  const sourceManifest = members.find((candidate) => candidate.path === 'manifest.json');
  if (!sourceManifest) throw new Error('Synthetic manifest member missing');
  return {
    schemaVersion: 'centurion-thread-corpus-relay-v1',
    transferId,
    snapshotId: snapshot.context.snapshotId,
    sourceManifestSha256: sha256(sourceManifest.content),
    memberSetSha256: memberSetSha256(members),
    members: members.map(({ path, bytes, sha256: digest }) => ({
      path,
      bytes,
      sha256: digest,
    })),
  };
}

function replaceMember(
  members: readonly CenturionRelayMember[],
  path: string,
  replacement: CenturionRelayMember,
): CenturionRelayMember[] {
  return members.map((candidate) => (candidate.path === path ? replacement : candidate));
}

function expectBlocked(
  relayManifest: unknown,
  members: readonly CenturionRelayMember[],
  maxTotalBytes = MAX_TOTAL_BYTES,
): void {
  const result = verifyCenturionRelaySnapshot(relayManifest, members, maxTotalBytes);
  expect(result).toEqual({ outcome: 'blocked' });
  const safeOutput = JSON.stringify(result);
  expect(safeOutput).not.toContain(SYNTHETIC_BODY_MARKER);
  expect(safeOutput).not.toContain(SYNTHETIC_ADDRESS_MARKER);
}

describe('Centurion thread corpus relay', () => {
  it('builds a sorted relay manifest and verifies a V2 snapshot after a round trip', () => {
    const snapshot = syntheticSnapshot();
    validatePrivateThreadCorpusSnapshot(snapshot);
    const members = sourceMembers(snapshot);

    const { manifest, manifestJson } = buildCenturionRelayManifest(
      TRANSFER_ID,
      members,
      MAX_TOTAL_BYTES,
    );

    expect(manifest.members.map((candidate) => candidate.path)).toEqual(
      members.map((candidate) => candidate.path),
    );
    expect(manifestJson).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(
      verifyCenturionRelaySnapshot(JSON.parse(manifestJson), members, MAX_TOTAL_BYTES),
    ).toEqual({
      outcome: 'verified',
      snapshotId: snapshot.context.snapshotId,
      sourceManifestSha256: manifest.sourceManifestSha256,
      memberSetSha256: manifest.memberSetSha256,
    });

    const safeOutput = JSON.stringify({ manifest, manifestJson });
    expect(safeOutput).not.toContain(SYNTHETIC_BODY_MARKER);
    expect(safeOutput).not.toContain(SYNTHETIC_ADDRESS_MARKER);
  });

  it('blocks duplicate, missing, extra, noncanonical, and unsafe source member paths', () => {
    const snapshot = syntheticSnapshot();
    const members = sourceMembers(snapshot);
    const artifact = members.find((candidate) => candidate.path.startsWith('raw-mime/'));
    expect(artifact).toBeDefined();

    const variants = [
      [...members, { ...artifact!, content: new Uint8Array(artifact!.content) }],
      members.filter((candidate) => candidate.path !== artifact!.path),
      [...members, member('unexpected.txt', textEncoder.encode('SYNTHETIC_UNKNOWN_MEMBER'))],
      [...members].reverse(),
      [
        ...members,
        member(
          'raw-mime/../0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.eml',
          textEncoder.encode('SYNTHETIC_TRAVERSAL'),
        ),
      ],
      [
        ...members,
        member(
          'raw-mime\\0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.eml',
          textEncoder.encode('SYNTHETIC_BACKSLASH'),
        ),
      ],
      [...members, member('relay-manifest.v1.json', textEncoder.encode('SYNTHETIC_RESERVED'))],
      [...members, member('receiver-ack.v1.json', textEncoder.encode('SYNTHETIC_RESERVED'))],
    ];

    for (const candidateMembers of variants) {
      expectBlocked(unsafeRelayManifest(snapshot, candidateMembers), candidateMembers);
    }
  });

  it('rejects malformed transfer and member metadata plus total-size overflow', () => {
    const snapshot = syntheticSnapshot();
    const members = sourceMembers(snapshot);
    const artifact = members.find((candidate) => candidate.path.startsWith('raw-mime/'));
    expect(artifact).toBeDefined();

    expect(() => buildCenturionRelayManifest('not-a-uuid', members, MAX_TOTAL_BYTES)).toThrow(
      'Invalid Centurion relay input',
    );
    expect(() =>
      buildCenturionRelayManifest(TRANSFER_ID, [...members].reverse(), MAX_TOTAL_BYTES),
    ).toThrow('Invalid Centurion relay input');

    const malformedDigest = replaceMember(members, artifact!.path, {
      ...artifact!,
      sha256: 'not-a-sha256',
    });
    const malformedBytes = replaceMember(members, artifact!.path, {
      ...artifact!,
      bytes: -1,
    });

    expectBlocked(unsafeRelayManifest(snapshot, members, 'not-a-uuid'), members);
    expectBlocked(unsafeRelayManifest(snapshot, malformedDigest), malformedDigest);
    expectBlocked(unsafeRelayManifest(snapshot, malformedBytes), malformedBytes);
    expectBlocked(unsafeRelayManifest(snapshot, members), members, 1);
  });

  it('blocks altered member bytes, sizes, hashes, and malformed relay manifests', () => {
    const snapshot = syntheticSnapshot();
    const members = sourceMembers(snapshot);
    const artifact = members.find((candidate) => candidate.path.startsWith('raw-mime/'));
    expect(artifact).toBeDefined();
    const alteredContent = new Uint8Array(artifact!.content);
    alteredContent[0] = alteredContent[0]! ^ 0xff;

    const alteredBytes = replaceMember(members, artifact!.path, {
      ...artifact!,
      content: alteredContent,
    });
    const alteredSize = replaceMember(members, artifact!.path, {
      ...artifact!,
      bytes: artifact!.bytes + 1,
    });
    const alteredHash = replaceMember(members, artifact!.path, {
      ...artifact!,
      sha256: '0'.repeat(64),
    });
    const manifest = unsafeRelayManifest(snapshot, members);

    expectBlocked(unsafeRelayManifest(snapshot, alteredBytes), alteredBytes);
    expectBlocked(unsafeRelayManifest(snapshot, alteredSize), alteredSize);
    expectBlocked(unsafeRelayManifest(snapshot, alteredHash), alteredHash);
    expectBlocked({ ...manifest, unexpected: 'SYNTHETIC_EXTRA_FIELD' }, members);
    expectBlocked(
      {
        ...manifest,
        members: undefined,
      },
      members,
    );
  });

  it('blocks V2 manifest, JSONL ordering, and artifact inventory tampering', () => {
    const snapshot = syntheticSnapshot();
    const members = sourceMembers(snapshot);
    const manifestMember = members.find((candidate) => candidate.path === 'manifest.json');
    const corpusMember = members.find((candidate) => candidate.path === 'corpus.jsonl');
    const artifact = members.find((candidate) => candidate.path.startsWith('raw-mime/'));
    expect(manifestMember).toBeDefined();
    expect(corpusMember).toBeDefined();
    expect(artifact).toBeDefined();

    const alteredManifestContent = textEncoder.encode(
      new TextDecoder()
        .decode(manifestMember!.content)
        .replace(/"localObjectSha256": "[a-f0-9]{64}"/, `"localObjectSha256": "${'0'.repeat(64)}"`),
    );
    const corpusLines = new TextDecoder().decode(corpusMember!.content).trimEnd().split('\n');
    const reorderedCorpusContent = textEncoder.encode(
      `${[corpusLines[0]!, ...corpusLines.slice(1).reverse()].join('\n')}\n`,
    );
    const alteredArtifactContent = textEncoder.encode('SYNTHETIC_RELAY_TAMPERED_ARTIFACT');

    const alteredManifest = replaceMember(
      members,
      manifestMember!.path,
      member(manifestMember!.path, alteredManifestContent),
    );
    const reorderedCorpus = replaceMember(
      members,
      corpusMember!.path,
      member(corpusMember!.path, reorderedCorpusContent),
    );
    const alteredArtifact = replaceMember(
      members,
      artifact!.path,
      member(artifact!.path, alteredArtifactContent),
    );

    expectBlocked(unsafeRelayManifest(snapshot, alteredManifest), alteredManifest);
    expectBlocked(unsafeRelayManifest(snapshot, reorderedCorpus), reorderedCorpus);
    expectBlocked(unsafeRelayManifest(snapshot, alteredArtifact), alteredArtifact);
  });

  it('builds only literal-root keys and canonical PII-free receipt and acknowledgement JSON', () => {
    const snapshot = syntheticSnapshot();
    const members = sourceMembers(snapshot);
    const { manifest, manifestJson } = buildCenturionRelayManifest(
      TRANSFER_ID,
      members,
      MAX_TOTAL_BYTES,
    );
    const relayManifestSha256 = sha256(textEncoder.encode(manifestJson));
    const receiptInput = {
      transferId: TRANSFER_ID,
      snapshotId: snapshot.context.snapshotId,
      sourceManifestSha256: manifest.sourceManifestSha256,
      relayManifestSha256,
      memberSetSha256: manifest.memberSetSha256,
    };

    expect(relayObjectKey('private-relay', TRANSFER_ID, 'corpus.jsonl')).toBe(
      `private-relay/${TRANSFER_ID}/corpus.jsonl`,
    );
    expect(relayManifestKey('private-relay', TRANSFER_ID)).toBe(
      `private-relay/${TRANSFER_ID}/relay-manifest.v1.json`,
    );
    expect(receiverAcknowledgementKey('private-relay', TRANSFER_ID)).toBe(
      `private-relay/${TRANSFER_ID}/receiver-ack.v1.json`,
    );
    expect(() => relayObjectKey('private/../relay', TRANSFER_ID, 'corpus.jsonl')).toThrow(
      'Invalid Centurion relay input',
    );
    expect(() => relayObjectKey('private-relay', TRANSFER_ID, 'receiver-ack.v1.json')).toThrow(
      'Invalid Centurion relay input',
    );

    const receiptJson = buildReceiveReceipt(receiptInput);
    const receipt = {
      schemaVersion: 'centurion-thread-corpus-relay-receipt-v1',
      ...receiptInput,
    };
    expect(receiptJson).toBe(`${JSON.stringify(receipt, null, 2)}\n`);
    expect(Object.keys(JSON.parse(receiptJson))).toEqual([
      'schemaVersion',
      'transferId',
      'snapshotId',
      'sourceManifestSha256',
      'relayManifestSha256',
      'memberSetSha256',
    ]);

    const acknowledgementInput = {
      ...receiptInput,
      receiveReceiptSha256: sha256(textEncoder.encode(receiptJson)),
    };
    const acknowledgementJson = buildReceiverAcknowledgement(acknowledgementInput);
    const acknowledgement = {
      schemaVersion: 'centurion-thread-corpus-relay-ack-v1',
      ...acknowledgementInput,
    };
    expect(acknowledgementJson).toBe(`${JSON.stringify(acknowledgement, null, 2)}\n`);
    expect(Object.keys(JSON.parse(acknowledgementJson))).toEqual([
      'schemaVersion',
      'transferId',
      'snapshotId',
      'sourceManifestSha256',
      'relayManifestSha256',
      'memberSetSha256',
      'receiveReceiptSha256',
    ]);

    expect(() =>
      buildReceiveReceipt({
        ...receiptInput,
        sourceManifestSha256: 'not-a-sha256',
      }),
    ).toThrow('Invalid Centurion relay input');
    expect(() =>
      buildReceiverAcknowledgement({
        ...acknowledgementInput,
        receiveReceiptSha256: 'not-a-sha256',
      }),
    ).toThrow('Invalid Centurion relay input');

    const safeOutput = JSON.stringify({ receiptJson, acknowledgementJson });
    expect(safeOutput).not.toContain(SYNTHETIC_BODY_MARKER);
    expect(safeOutput).not.toContain(SYNTHETIC_ADDRESS_MARKER);
  });
});
