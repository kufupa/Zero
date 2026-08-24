import {
  parseAnalysisWorkspaceConfig,
  runCenturionThreadCorpusAnalysis,
  type AnalysisWorkspaceConfigV1,
  type AnalysisWorkspacePort,
  type AnalysisWorkspaceStateV1,
  type VerifiedReceivedAnalysisInput,
} from '../src/ops/centurion-thread-corpus-analysis-workspace.js';
import {
  CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
  preparePrivateAnalysis,
  type AnalystDecisionBundleV1,
  type PreparedPrivateAnalysisV1,
} from '../src/ops/centurion-thread-corpus-analysis.js';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  type PrivateThreadCorpusSnapshot,
} from '../scripts/export-thread-corpus.js';
import { createAnalyzeCenturionThreadCorpusCommand } from '../scripts/analyze-centurion-thread-corpus.js';
import type { WindowsPrivateAcl } from '../src/ops/centurion-thread-corpus-relay-receiver.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const TRANSFER_ID = '3479ca40-b5a1-4bb3-aef1-02fcbefc949c';
const CHECKOUT_ROOT = 'C:\\synthetic\\zero';
const RECEIVED_ROOT = `${CHECKOUT_ROOT}\\.private\\centurion-thread-corpus`;
const ANALYSIS_ROOT = `${CHECKOUT_ROOT}\\.private\\centurion-thread-analysis`;
const RECEIVED_PATH = `${RECEIVED_ROOT}\\${TRANSFER_ID}`;
const RECEIPT_SHA256 = 'a'.repeat(64);
const PRIVATE_BODY_MARKER = 'SYNTHETIC_ANALYSIS_WORKSPACE_BODY_MARKER';
const PRIVATE_ADDRESS_MARKER = 'workspace.sender@example.test';
const PRIVATE_HEADER_MARKER = 'SYNTHETIC_ANALYSIS_WORKSPACE_HEADER_MARKER';
const PRIVATE_PATH_MARKER = 'C:\\synthetic\\analysis-workspace-private-path';
const PRIVATE_ARTIFACT_MARKER = 'SYNTHETIC_ANALYSIS_WORKSPACE_ARTIFACT_MARKER';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function syntheticSnapshot(): PrivateThreadCorpusSnapshot {
  return buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'synthetic-analysis-workspace-snapshot-001',
      scope: {
        scopeKeys: ['centurion_transport', 'designated_reservationist_mailbox'],
        transportIds: ['synthetic-centurion-transport', 'synthetic-designated-transport'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: '2026-08-23T12:00:00.000Z',
      exporterVersion: 'synthetic-analysis-workspace-test-v1',
      unscopedQuarantineExcluded: 0,
    },
    formatted: formatLogicalMessages([
      {
        sourceRowId: 'synthetic-analysis-workspace-row',
        scopeMembership: ['centurion_transport', 'designated_reservationist_mailbox'],
        receivedAt: '2026-08-23T10:00:00.000Z',
        threadId: 'synthetic-analysis-workspace-thread',
        messageId: '<synthetic-analysis-workspace@example.test>',
        contentFingerprint: 'synthetic-analysis-workspace-content',
        provenanceFingerprint: 'synthetic-analysis-workspace-provenance',
        body: PRIVATE_BODY_MARKER,
        privateMessage: {
          subject: PRIVATE_BODY_MARKER,
          direction: 'inbound',
          addresses: {
            from: [PRIVATE_ADDRESS_MARKER],
            to: [],
            cc: [],
            bcc: [],
          },
          originalAddresses: {
            from: [PRIVATE_ADDRESS_MARKER],
            to: [],
            cc: [],
            bcc: [],
          },
          canonicalHeaders: {
            'x-synthetic-analysis-workspace': [PRIVATE_HEADER_MARKER],
          },
          sentAt: null,
          rawMime: {
            locator: `${PRIVATE_PATH_MARKER}\\message.eml`,
            status: 'available',
          },
          attachments: [],
          draftRevisionLinks: [],
          outboundDelivery: {
            queueState: 'unknown',
            deliveryStatus: 'smtp_accepted',
          },
          sourceMetadata: {
            transportId: 'synthetic-centurion-transport',
            ingestMailboxId: null,
            uidl: 'synthetic-analysis-workspace-uidl',
          },
        },
      },
    ]),
    hydration: {
      attachmentLocators: [],
      payloads: [
        {
          kind: 'raw_mime',
          sourceRowId: 'synthetic-analysis-workspace-row',
          status: 'available',
          content: textEncoder.encode(PRIVATE_ARTIFACT_MARKER),
        },
      ],
    },
  });
}

const CONFIG: AnalysisWorkspaceConfigV1 = {
  version: 'centurion-thread-corpus-analysis-workspace-config-v1',
  checkoutRoot: CHECKOUT_ROOT,
  receivedCorpusRoot: RECEIVED_ROOT,
  analysisRoot: ANALYSIS_ROOT,
  maxPacketBytes: 1_000_000,
  maxTotalPacketBytes: 1_000_000,
  maxDecisionBytes: 64 * 1024,
};

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function cloneState(state: AnalysisWorkspaceStateV1): AnalysisWorkspaceStateV1 {
  return { ...state };
}

function preparedFor(snapshot: PrivateThreadCorpusSnapshot): PreparedPrivateAnalysisV1 {
  const prepared = preparePrivateAnalysis(snapshot, {
    maxPacketBytes: CONFIG.maxPacketBytes,
    maxTotalPacketBytes: CONFIG.maxTotalPacketBytes,
  });
  if (!prepared) throw new Error('Expected synthetic analysis preparation');
  return prepared;
}

function snapshotDigestFor(snapshot: PrivateThreadCorpusSnapshot): string {
  return preparedFor(snapshot).manifest.snapshotDigest;
}

function expectedWorkspacePath(snapshotDigest: string): string {
  return path.win32.join(
    ANALYSIS_ROOT,
    'workspaces',
    sha256(`${snapshotDigest}\n${RECEIPT_SHA256}`),
  );
}

function privateWorkspacePath(root: string, relative: string): string {
  return path.win32.join(root, ...relative.split('/'));
}

function validDecisionBundle(prepared: PreparedPrivateAnalysisV1): AnalystDecisionBundleV1 {
  return {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    preparedManifestSha256: prepared.manifestSha256,
    decisions: prepared.packets.map((packet) =>
      packet.packetState === 'complete'
        ? {
            schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
            analysisItemId: packet.analysisItemId,
            workflow: 'reservation_new',
            risk: 'none',
            confidence: 'high',
            attention: 'routine',
          }
        : {
            schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
            analysisItemId: packet.analysisItemId,
            workflow: 'unknown',
            risk: 'human_review',
            confidence: 'low',
            attention: 'human_review',
          },
    ),
  };
}

class FakeWindowsPrivateAcl implements WindowsPrivateAcl {
  readonly calls: string[] = [];
  readonly identities = new Map<string, { stableIdentity: string; volumeId: string }>([
    [
      ANALYSIS_ROOT,
      {
        stableIdentity: 'safe-analysis-root-identity',
        volumeId: 'safe-volume-a',
      },
    ],
    [
      RECEIVED_PATH,
      {
        stableIdentity: 'safe-received-identity',
        volumeId: 'safe-volume-a',
      },
    ],
  ]);
  readonly rejectedPaths = new Set<string>();
  readonly deniedDirectories = new Set<string>();
  readonly deniedFiles = new Set<string>();

  async assertTrustedPath(
    pathValue: string,
  ): Promise<{ stableIdentity: string; volumeId: string } | null> {
    this.calls.push(`assert:${pathValue}`);
    if (this.rejectedPaths.has(pathValue)) return null;
    const direct = this.identities.get(pathValue);
    if (direct) return { ...direct };
    if (pathValue.startsWith(`${ANALYSIS_ROOT}\\`)) {
      return {
        stableIdentity: `safe-analysis-file-${sha256(pathValue).slice(0, 16)}`,
        volumeId: 'safe-volume-a',
      };
    }
    return null;
  }

  async lockDownDirectory(pathValue: string): Promise<boolean> {
    this.calls.push(`lock-directory:${pathValue}`);
    return !this.deniedDirectories.has(pathValue);
  }

  async lockDownFiles(paths: readonly string[]): Promise<boolean> {
    this.calls.push(`lock-files:${paths.join(',')}`);
    return !paths.some((pathValue) => this.deniedFiles.has(pathValue));
  }

  async promoteNoReplace(): Promise<boolean> {
    throw new Error('analysis workspace must not promote receive snapshots');
  }

  async fsyncReceipt(pathValue: string): Promise<boolean> {
    this.calls.push(`fsync:${pathValue}`);
    return !this.deniedFiles.has(pathValue);
  }
}

class FakeAnalysisWorkspacePort implements AnalysisWorkspacePort {
  readonly calls: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly states = new Map<string, AnalysisWorkspaceStateV1>();
  readonly stateWrites: AnalysisWorkspaceStateV1[] = [];
  readonly acl = new FakeWindowsPrivateAcl();
  readonly failingWrites = new Set<string>();
  readonly growingReads = new Set<string>();
  readonly deniedStateTransitions = new Set<AnalysisWorkspaceStateV1['state']>();
  platformResult = 'win32';
  configResult = JSON.stringify(CONFIG);
  inspectResult: { gitignored: boolean; stableIdentity: string; volumeId: string } | null = {
    gitignored: true,
    stableIdentity: 'safe-analysis-root-identity',
    volumeId: 'safe-volume-a',
  };
  received: VerifiedReceivedAnalysisInput;

  constructor(snapshot = syntheticSnapshot()) {
    this.received = {
      snapshot,
      snapshotDigest: snapshotDigestFor(snapshot),
      receiveReceiptSha256: RECEIPT_SHA256,
      canonicalPath: RECEIVED_PATH,
      stableIdentity: 'safe-received-identity',
      volumeId: 'safe-volume-a',
    };
  }

  platform(): string {
    this.calls.push('platform');
    return this.platformResult;
  }

  async readProtectedConfig(): Promise<string> {
    this.calls.push('config');
    return this.configResult;
  }

  async inspectCheckout(input: {
    checkoutRoot: string;
    receivedCorpusRoot: string;
    analysisRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null> {
    this.calls.push('inspect');
    expect(input).toEqual({
      checkoutRoot: CHECKOUT_ROOT,
      receivedCorpusRoot: RECEIVED_ROOT,
      analysisRoot: ANALYSIS_ROOT,
    });
    return this.inspectResult ? { ...this.inspectResult } : null;
  }

  async readVerifiedReceivedSnapshot(
    transferId: string,
  ): Promise<VerifiedReceivedAnalysisInput | null> {
    this.calls.push(`receive:${transferId}`);
    return transferId === TRANSFER_ID
      ? {
          ...this.received,
          snapshot: this.received.snapshot,
        }
      : null;
  }

  async createProtectedWorkspace(input: {
    snapshotDigest: string;
    receiveReceiptSha256: string;
    expectedVolumeId: string;
  }): Promise<{ path: string; stableIdentity: string; volumeId: string } | null> {
    this.calls.push(`workspace:${input.snapshotDigest}`);
    if (
      input.snapshotDigest !== this.received.snapshotDigest ||
      input.receiveReceiptSha256 !== this.received.receiveReceiptSha256 ||
      input.expectedVolumeId !== 'safe-volume-a'
    ) {
      return null;
    }
    const workspace = expectedWorkspacePath(input.snapshotDigest);
    this.acl.identities.set(workspace, {
      stableIdentity: 'safe-workspace-identity',
      volumeId: 'safe-volume-a',
    });
    return {
      path: workspace,
      stableIdentity: 'safe-workspace-identity',
      volumeId: 'safe-volume-a',
    };
  }

  async writeCreateNewProtected(pathValue: string, content: Uint8Array): Promise<boolean> {
    this.calls.push(`write:${pathValue}`);
    if (this.failingWrites.has(pathValue) || this.files.has(pathValue)) return false;
    this.files.set(pathValue, cloneBytes(content));
    return true;
  }

  async readBoundedProtected(pathValue: string, maxBytes: number): Promise<Uint8Array | null> {
    this.calls.push(`read:${pathValue}`);
    const content = this.files.get(pathValue);
    if (!content || content.byteLength > maxBytes || this.growingReads.has(pathValue)) return null;
    return cloneBytes(content);
  }

  async writeAtomicProtectedState(state: AnalysisWorkspaceStateV1): Promise<boolean> {
    this.calls.push(`state:${state.state}`);
    if (this.deniedStateTransitions.has(state.state)) return false;
    this.states.set(state.transferId, cloneState(state));
    this.stateWrites.push(cloneState(state));
    return true;
  }

  async readProtectedState(transferId: string): Promise<AnalysisWorkspaceStateV1 | null> {
    this.calls.push(`read-state:${transferId}`);
    const state = this.states.get(transferId);
    return state ? cloneState(state) : null;
  }

  seedDecision(bundle: AnalystDecisionBundleV1): string {
    const workspace = expectedWorkspacePath(this.received.snapshotDigest);
    const decisionPath = privateWorkspacePath(workspace, 'decision-bundle.v1.json');
    this.files.set(decisionPath, textEncoder.encode(JSON.stringify(bundle)));
    return decisionPath;
  }

  fileEnding(ending: string): string {
    const filePath = [...this.files.keys()].find((candidate) => candidate.endsWith(ending));
    if (!filePath) throw new Error(`Missing private test file: ${ending}`);
    return filePath;
  }
}

function createHarness(snapshot = syntheticSnapshot()): FakeAnalysisWorkspacePort {
  return new FakeAnalysisWorkspacePort(snapshot);
}

async function runCommand(
  port: FakeAnalysisWorkspacePort,
  args: readonly string[],
): Promise<{ code: number; stdout: string[] }> {
  const stdout: string[] = [];
  const command = createAnalyzeCenturionThreadCorpusCommand({
    args: () => args,
    workspace: port,
    writeStdout: (value) => stdout.push(value),
  });
  return { code: await command(), stdout };
}

function expectNoPrivateLeak(value: unknown): void {
  const output = JSON.stringify(value);
  for (const marker of [
    PRIVATE_BODY_MARKER,
    PRIVATE_ADDRESS_MARKER,
    PRIVATE_HEADER_MARKER,
    PRIVATE_PATH_MARKER,
    PRIVATE_ARTIFACT_MARKER,
    RECEIVED_PATH,
    ANALYSIS_ROOT,
  ]) {
    expect(output).not.toContain(marker);
  }
}

function parseTypeScript(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function collectNodes(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

describe('Centurion private analysis workspace command', () => {
  it('requires an exact command and UUID before any runtime port call', async () => {
    const port = createHarness();

    const result = await runCommand(port, [
      'prepare',
      '--transfer-id',
      'not-a-uuid',
      PRIVATE_PATH_MARKER,
    ]);

    expect(result).toEqual({
      code: 2,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.calls).toEqual([]);
    expect(port.acl.calls).toEqual([]);
    expectNoPrivateLeak(result);
  });

  it('blocks non-Windows before config, ACL, received snapshot, or filesystem ports', async () => {
    const port = createHarness();
    port.platformResult = 'linux';

    const result = await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID]);

    expect(result).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.calls).toEqual(['platform']);
    expect(port.acl.calls).toEqual([]);
    expectNoPrivateLeak(result);
  });

  it.each([
    ['zero packet limit', { ...CONFIG, maxPacketBytes: 0 }],
    ['unsafe total limit', { ...CONFIG, maxTotalPacketBytes: Number.MAX_SAFE_INTEGER }],
    ['unsafe decision limit', { ...CONFIG, maxDecisionBytes: Number.MAX_SAFE_INTEGER }],
    [
      'non-sibling received root',
      { ...CONFIG, receivedCorpusRoot: `${CHECKOUT_ROOT}\\.private\\untrusted-received-root` },
    ],
    [
      'non-sibling analysis root',
      { ...CONFIG, analysisRoot: `${CHECKOUT_ROOT}\\.private\\untrusted-analysis-root` },
    ],
  ])('blocks %s before ACL or received snapshot reads', async (_kind, config) => {
    const port = createHarness();
    port.configResult = JSON.stringify(config);

    const result = await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID]);

    expect(result).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.calls).toEqual(['platform', 'config']);
    expect(port.acl.calls).toEqual([]);
    expectNoPrivateLeak(result);
  });

  it('parses only exact Windows sibling config with bounded safe-integer limits', () => {
    expect(parseAnalysisWorkspaceConfig(JSON.stringify(CONFIG))).toEqual(CONFIG);
    expect(
      parseAnalysisWorkspaceConfig(
        JSON.stringify({
          ...CONFIG,
          extra: PRIVATE_BODY_MARKER,
        }),
      ),
    ).toBeNull();
    expect(
      parseAnalysisWorkspaceConfig(
        JSON.stringify({
          ...CONFIG,
          checkoutRoot: CHECKOUT_ROOT.replace('C:', 'D:'),
        }),
      ),
    ).toBeNull();
  });

  it('creates immutable private packets and a bound prepared state before fixed safe output', async () => {
    const port = createHarness();

    const result = await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID]);
    const state = port.states.get(TRANSFER_ID);
    const packetPath = port.fileEnding('packets/packet-000000.v1.json'.replaceAll('/', '\\'));
    const manifestPath = port.fileEnding('prepared-manifest.v1.json');

    expect(result).toEqual({
      code: 0,
      stdout: ['{"outcome":"prepared"}\n'],
    });
    expect(state).toEqual({
      schemaVersion: 'centurion-thread-corpus-analysis-workspace-state-v1',
      transferId: TRANSFER_ID,
      snapshotDigest: port.received.snapshotDigest,
      receiveReceiptSha256: RECEIPT_SHA256,
      preparedManifestSha256: preparedFor(port.received.snapshot).manifestSha256,
      state: 'prepared',
      decisionBundleSha256: null,
      reportSha256: null,
    });
    expect(port.files.get(packetPath)).toBeDefined();
    expect(port.files.get(manifestPath)).toBeDefined();
    expect(port.files.keys()).not.toContain(RECEIVED_PATH);
    expect(
      port.acl.calls.some((call) => call.startsWith('lock-files:') && call.includes(packetPath)),
    ).toBe(true);
    expect(port.stateWrites.map((entry) => entry.state)).toEqual(['prepared']);
    expectNoPrivateLeak({
      stdout: result.stdout,
      state,
      report: port.files.get(manifestPath),
    });
  });

  it.each([
    [
      'unignored analysis root',
      (port: FakeAnalysisWorkspacePort) =>
        (port.inspectResult = { ...port.inspectResult!, gitignored: false }),
    ],
    [
      'received volume mismatch',
      (port: FakeAnalysisWorkspacePort) =>
        (port.received = { ...port.received, volumeId: 'safe-volume-b' }),
    ],
    [
      'untrusted receive receipt',
      (port: FakeAnalysisWorkspacePort) =>
        (port.received = { ...port.received, receiveReceiptSha256: 'not-a-sha256' }),
    ],
    [
      'received stable-identity mismatch',
      (port: FakeAnalysisWorkspacePort) =>
        port.acl.identities.set(RECEIVED_PATH, {
          stableIdentity: 'changed-received-identity',
          volumeId: 'safe-volume-a',
        }),
    ],
    [
      'workspace ACL failure',
      (port: FakeAnalysisWorkspacePort) => port.acl.deniedDirectories.add(ANALYSIS_ROOT),
    ],
  ])('blocks %s without creating packets', async (_kind, arrange) => {
    const port = createHarness();
    arrange(port);

    const result = await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID]);

    expect(result).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.states.get(TRANSFER_ID)).toBeUndefined();
    expect([...port.files.keys()].filter((filePath) => filePath.includes('packets'))).toEqual([]);
    expectNoPrivateLeak(result);
  });

  it.each([
    [
      'tampered V2 snapshot',
      (port: FakeAnalysisWorkspacePort) =>
        (port.received = {
          ...port.received,
          snapshot: {
            ...port.received.snapshot,
            corpusJsonl: port.received.snapshot.corpusJsonl.replace(
              PRIVATE_BODY_MARKER,
              `${PRIVATE_BODY_MARKER}-tampered`,
            ),
          },
        }),
    ],
    [
      'packet create-new collision',
      (port: FakeAnalysisWorkspacePort) => {
        const workspace = expectedWorkspacePath(port.received.snapshotDigest);
        port.files.set(
          privateWorkspacePath(workspace, 'packets/packet-000000.v1.json'),
          textEncoder.encode('SAFE_COLLISION'),
        );
      },
    ],
    [
      'packet file ACL failure',
      (port: FakeAnalysisWorkspacePort) =>
        port.acl.deniedFiles.add(
          privateWorkspacePath(
            expectedWorkspacePath(port.received.snapshotDigest),
            'packets/packet-000000.v1.json',
          ),
        ),
    ],
  ])('blocks %s before durable prepared state', async (_kind, arrange) => {
    const port = createHarness();
    arrange(port);

    const result = await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID]);

    expect(result).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.states.get(TRANSFER_ID)).toBeUndefined();
    expectNoPrivateLeak(result);
  });

  it('retries prepare only when receipt, snapshot, manifest, and packets bind identically', async () => {
    const port = createHarness();

    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toMatchObject({
      code: 0,
    });
    const writesAfterPrepare = port.calls.filter((call) => call.startsWith('write:')).length;
    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toEqual({
      code: 0,
      stdout: ['{"outcome":"prepared"}\n'],
    });
    expect(port.calls.filter((call) => call.startsWith('write:'))).toHaveLength(writesAfterPrepare);

    port.received = {
      ...port.received,
      snapshotDigest: 'b'.repeat(64),
    };
    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
  });

  it('writes decision_written before private report then reconciled with fixed safe output', async () => {
    const port = createHarness();
    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toMatchObject({
      code: 0,
    });
    const decisionPath = port.seedDecision(
      validDecisionBundle(preparedFor(port.received.snapshot)),
    );

    const result = await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID]);
    const state = port.states.get(TRANSFER_ID);
    const reportPath = port.fileEnding('aggregate-report.v1.json');

    expect(result).toEqual({
      code: 0,
      stdout: ['{"outcome":"reconciled"}\n'],
    });
    expect(port.stateWrites.map((entry) => entry.state)).toEqual([
      'prepared',
      'decision_written',
      'reconciled',
    ]);
    expect(state).toMatchObject({
      state: 'reconciled',
      snapshotDigest: port.received.snapshotDigest,
      receiveReceiptSha256: RECEIPT_SHA256,
      preparedManifestSha256: preparedFor(port.received.snapshot).manifestSha256,
      decisionBundleSha256: sha256(port.files.get(decisionPath)!),
      reportSha256: sha256(port.files.get(reportPath)!),
    });
    expect(port.acl.calls).toContain(`lock-files:${decisionPath}`);
    expectNoPrivateLeak({
      stdout: result.stdout,
      state,
      report: textDecoder.decode(port.files.get(reportPath)!),
    });
  });

  it.each([
    [
      'malformed decision',
      (port: FakeAnalysisWorkspacePort) => {
        const workspace = expectedWorkspacePath(port.received.snapshotDigest);
        port.files.set(
          privateWorkspacePath(workspace, 'decision-bundle.v1.json'),
          textEncoder.encode('{'),
        );
      },
    ],
    [
      'oversized decision',
      (port: FakeAnalysisWorkspacePort) => {
        const workspace = expectedWorkspacePath(port.received.snapshotDigest);
        port.files.set(
          privateWorkspacePath(workspace, 'decision-bundle.v1.json'),
          new Uint8Array(CONFIG.maxDecisionBytes + 1),
        );
      },
    ],
    [
      'growing decision',
      (port: FakeAnalysisWorkspacePort) => {
        const decisionPath = port.seedDecision(
          validDecisionBundle(preparedFor(port.received.snapshot)),
        );
        port.growingReads.add(decisionPath);
      },
    ],
    [
      'decision manifest mismatch',
      (port: FakeAnalysisWorkspacePort) => {
        const bundle = validDecisionBundle(preparedFor(port.received.snapshot));
        port.seedDecision({
          ...bundle,
          preparedManifestSha256: '0'.repeat(64),
        });
      },
    ],
    [
      'decision reconciliation failure',
      (port: FakeAnalysisWorkspacePort) => {
        const bundle = validDecisionBundle(preparedFor(port.received.snapshot));
        port.seedDecision({
          ...bundle,
          decisions: bundle.decisions.map((decision) => ({
            ...decision,
            analysisItemId: 'f'.repeat(64),
          })),
        });
      },
    ],
  ])('blocks %s without leaving decision_written state', async (_kind, arrange) => {
    const port = createHarness();
    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toMatchObject({
      code: 0,
    });
    arrange(port);

    const result = await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID]);

    expect(result).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.states.get(TRANSFER_ID)?.state).toBe('prepared');
    expectNoPrivateLeak({
      result,
      state: port.states.get(TRANSFER_ID),
    });
  });

  it('blocks a tampered prepared manifest before reading analyst decisions', async () => {
    const port = createHarness();
    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toMatchObject({
      code: 0,
    });
    const manifestPath = port.fileEnding('prepared-manifest.v1.json');
    port.files.set(manifestPath, textEncoder.encode('{"safe":"but-mismatched"}'));
    port.seedDecision(validDecisionBundle(preparedFor(port.received.snapshot)));

    const result = await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID]);

    expect(result).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.calls.some((call) => call.endsWith('decision-bundle.v1.json'))).toBe(false);
  });

  it('recovers from crash boundaries only by revalidating prior durable bindings', async () => {
    const port = createHarness();
    expect(await runCommand(port, ['prepare', '--transfer-id', TRANSFER_ID])).toMatchObject({
      code: 0,
    });
    const bundle = validDecisionBundle(preparedFor(port.received.snapshot));
    const workspace = expectedWorkspacePath(port.received.snapshotDigest);
    const reportPath = privateWorkspacePath(workspace, 'aggregate-report.v1.json');
    port.seedDecision(bundle);
    port.failingWrites.add(reportPath);

    expect(await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID])).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.states.get(TRANSFER_ID)?.state).toBe('decision_written');
    port.failingWrites.delete(reportPath);
    port.deniedStateTransitions.add('reconciled');

    expect(await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID])).toEqual({
      code: 3,
      stdout: ['{"outcome":"blocked"}\n'],
    });
    expect(port.states.get(TRANSFER_ID)?.state).toBe('decision_written');
    expect(port.files.has(reportPath)).toBe(true);
    port.deniedStateTransitions.delete('reconciled');

    expect(await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID])).toEqual({
      code: 0,
      stdout: ['{"outcome":"reconciled"}\n'],
    });
    expect(port.states.get(TRANSFER_ID)?.state).toBe('reconciled');
    expect(await runCommand(port, ['reconcile', '--transfer-id', TRANSFER_ID])).toEqual({
      code: 0,
      stdout: ['{"outcome":"reconciled"}\n'],
    });
  });

  it('keeps workspace engine independently fail-closed for invalid direct input', async () => {
    const port = createHarness();

    await expect(
      runCenturionThreadCorpusAnalysis({
        command: 'prepare',
        transferId: 'not-a-uuid',
        port,
      }),
    ).resolves.toEqual({ outcome: 'blocked' });
    expect(port.calls).toEqual([]);
    expect(port.acl.calls).toEqual([]);
  });
});

describe('Centurion analysis workspace source boundaries', () => {
  it('contains no cloud, database, model, browser, mailbox, category, dynamic execution, or raw logging capabilities', () => {
    const workspacePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-analysis-workspace.ts', import.meta.url),
    );
    const scriptPath = fileURLToPath(
      new URL('../scripts/analyze-centurion-thread-corpus.ts', import.meta.url),
    );
    const workspace = parseTypeScript(workspacePath);
    const script = parseTypeScript(scriptPath);
    const source = `${workspace.text}\n${script.text}`;
    const imports = [workspace, script].flatMap((file) =>
      collectNodes(file, ts.isImportDeclaration).flatMap((node) => {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return [];
        return [node.moduleSpecifier.text];
      }),
    );
    const forbiddenImports = [
      '@aws-sdk/',
      'bedrock',
      'database',
      'drizzle',
      'mastra',
      'playwright',
      'postgres',
      'puppeteer',
      'ssm',
    ];

    expect(
      imports.filter((moduleName) =>
        forbiddenImports.some((forbidden) => moduleName.toLowerCase().includes(forbidden)),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(/\b(?:AWS|Bedrock|Mastra|mailbox|category)\b/i);
    expect(source).not.toMatch(/\b(?:eval|Function)\b/);
    expect(source).not.toContain('import(');
    expect(source).not.toContain('console.');
    expect(source).not.toContain('process.stderr');
    expect(source).not.toContain('powershell.exe');
    expect(source).not.toContain('spawn(');
    const gitChecks = collectNodes(
      workspace,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'spawnSync',
    ) as ts.CallExpression[];
    expect(gitChecks).toHaveLength(1);
    const gitCheck = gitChecks[0];
    if (!gitCheck || !ts.isStringLiteral(gitCheck.arguments[0])) {
      throw new Error('Expected fixed git ignore check');
    }
    expect(gitCheck.arguments[0].text).toBe('git');
    expect(source).toContain('shell: false');
    expect(source).toContain("stdio: 'ignore'");
    expect(source).toContain('createWindowsPrivateAcl');
  });
});
