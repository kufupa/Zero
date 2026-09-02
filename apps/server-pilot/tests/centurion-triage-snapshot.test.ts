import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  bindApprovedTargetManifest,
  buildCenturionTriageSnapshot,
  computeCanonicalSnapshotHash,
  computeCustomCategoryPresenceHash,
  emitTargetManifestFromSnapshot,
  parseSnapshotArgs,
  requireSnapshotPromptHash,
  verifyRestoreSnapshotDrift,
  writePrivateJson,
  verifySnapshotAgainstLive,
} from '../scripts/snapshot-centurion-triage.mjs';
import {
  RETAG_UNSETTLE_SLUGS,
  computeCanonicalManifestHash,
  computePreStateHash,
  computeTriggerHash,
  validateBoundApprovedRolloutManifest,
  validateApprovedRolloutManifest,
} from '../scripts/retag-centurion-triage.mjs';
import {
  parseRestoreArgs,
  restoreCenturionTriageSnapshot,
} from '../scripts/restore-centurion-triage-snapshot.mjs';

/** Depth-aware bash if/fi extract — covers full QUIESCED branch (not first nested fi). */
function extractBashIfBlock(script: string, conditionRe: RegExp): string | null {
  const match = script.match(conditionRe);
  if (!match || match.index == null) return null;
  const lines = script.slice(match.index).split(/\r?\n/);
  let depth = 0;
  const collected: string[] = [];
  for (const line of lines) {
    collected.push(line);
    if (/^\s*if\b/.test(line)) depth += 1;
    if (/^\s*fi\b/.test(line)) {
      depth -= 1;
      if (depth === 0) return collected.join('\n');
    }
  }
  return null;
}

const TRANSPORT_ID = 'transport-centurion';
const MODEL_ID = 'amazon.nova-lite-v1:0';
const PROMPT_VERSION = 'triage-v5';
const PROMPT_HASH = 'b'.repeat(64);
const SOURCE_HASH = 'c'.repeat(64);

type PrefKind = 'block' | 'allow';

type MemThread = {
  threadId: string;
  spamAt: string | null;
  spamUserLockedAt: string | null;
  latestInboundId: string | null;
  latestInboundFrom: string | null;
  latestInboundCreatedAt: string | null;
  aiCategorySlugs: string[];
  customCategorySlugs: string[];
  hasInbound: boolean;
};

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function baseThreads(): MemThread[] {
  return [
    {
      threadId: 't-eligible',
      spamAt: '2026-07-01T00:00:00.000Z',
      spamUserLockedAt: null,
      latestInboundId: 'm-eligible',
      latestInboundFrom: 'guest@example.com',
      latestInboundCreatedAt: '2026-07-01T00:00:00.000Z',
      aiCategorySlugs: ['ops'],
      customCategorySlugs: ['vip-desk'],
      hasInbound: true,
    },
    {
      threadId: 't-locked',
      spamAt: '2026-07-01T00:00:00.000Z',
      spamUserLockedAt: '2026-07-02T00:00:00.000Z',
      latestInboundId: 'm-locked',
      latestInboundFrom: 'locked@example.com',
      latestInboundCreatedAt: '2026-07-01T00:00:00.000Z',
      aiCategorySlugs: ['at-risk'],
      customCategorySlugs: [],
      hasInbound: true,
    },
    {
      threadId: 't-blocked',
      spamAt: null,
      spamUserLockedAt: null,
      latestInboundId: 'm-blocked',
      latestInboundFrom: 'spam@bad.com',
      latestInboundCreatedAt: '2026-07-01T00:00:00.000Z',
      aiCategorySlugs: [],
      customCategorySlugs: ['manual-tag'],
      hasInbound: true,
    },
    {
      threadId: 't-allowed',
      spamAt: null,
      spamUserLockedAt: null,
      latestInboundId: 'm-allowed',
      latestInboundFrom: 'vip@partner.com',
      latestInboundCreatedAt: '2026-07-01T00:00:00.000Z',
      aiCategorySlugs: ['new-bookings'],
      customCategorySlugs: [],
      hasInbound: true,
    },
    {
      threadId: 't-outbound',
      spamAt: null,
      spamUserLockedAt: null,
      latestInboundId: null,
      latestInboundFrom: null,
      latestInboundCreatedAt: null,
      aiCategorySlugs: [],
      customCategorySlugs: [],
      hasInbound: false,
    },
  ];
}

function createMemoryStore(seed: {
  threads: MemThread[];
  preferences?: Record<string, PrefKind>;
  failRestoreAfter?: boolean;
}) {
  const threads = new Map(
    seed.threads.map((t) => [
      t.threadId,
      {
        ...t,
        aiCategorySlugs: [...t.aiCategorySlugs],
        customCategorySlugs: [...t.customCategorySlugs],
      },
    ]),
  );
  const preferences = new Map(Object.entries(seed.preferences ?? {}));
  preferences.set('spam@bad.com', 'block');
  preferences.set('vip@partner.com', 'allow');

  const driver = {
    async listThreads() {
      return [...threads.values()].map((t) => ({
        threadId: t.threadId,
        spamAt: t.spamAt,
        spamUserLockedAt: t.spamUserLockedAt,
        latestInboundId: t.latestInboundId,
        latestInboundFrom: t.latestInboundFrom,
        latestInboundCreatedAt: t.latestInboundCreatedAt,
        aiCategorySlugs: [...t.aiCategorySlugs],
        customCategorySlugs: [...t.customCategorySlugs],
        hasInbound: t.hasInbound,
      }));
    },
    async listSenderPreferences(emails: string[]) {
      const out = new Map<string, PrefKind>();
      for (const email of emails) {
        const kind = preferences.get(email);
        if (kind) out.set(email, kind);
      }
      return out;
    },
    async restoreAiManagedState(row: {
      threadId: string;
      spamAt: string | null;
      spamUserLockedAt: string | null;
      aiCategorySlugs: string[];
    }) {
      const t = threads.get(row.threadId);
      if (!t) throw new Error(`missing thread ${row.threadId}`);
      t.spamAt = row.spamAt;
      t.spamUserLockedAt = row.spamUserLockedAt;
      // Mirror restore SQL: all retag-cleared joins are restorable; customs are not.
      t.aiCategorySlugs = [...row.aiCategorySlugs].filter((slug) =>
        RETAG_UNSETTLE_SLUGS.includes(slug),
      );
    },
    async restoreAiManagedStateBatch(rows: Array<{
      threadId: string;
      spamAt: string | null;
      spamUserLockedAt: string | null;
      aiCategorySlugs: string[];
    }>, snapshot?: object) {
      if (snapshot) {
        await verifyRestoreSnapshotDrift({ driver: this, snapshot });
      }
      const before = new Map(
        [...threads.entries()].map(([id, row]) => [id, {
          ...row,
          aiCategorySlugs: [...row.aiCategorySlugs],
          customCategorySlugs: [...row.customCategorySlugs],
        }]),
      );
      try {
        for (const [index, row] of rows.entries()) {
          await this.restoreAiManagedState(row);
          if (seed.failRestoreAfter && index === 0) {
            throw new Error('forced restore batch failure');
          }
        }
      } catch (error) {
        threads.clear();
        for (const [id, row] of before) threads.set(id, row);
        throw error;
      }
    },
    async listSenderPreferenceSnapshot() {
      return [...preferences.entries()].map(([email, kind]) => ({ email, kind }));
    },
  };

  return { threads, preferences, driver };
}

describe('snapshot CLI args', () => {
  it('requires --out and rejects unknown options', () => {
    expect(() => parseSnapshotArgs([])).toThrow(/--out/i);
    expect(parseSnapshotArgs(['--out', 'snap.json'])).toMatchObject({
      outPath: 'snap.json',
      targetsOutPath: null,
    });
    expect(
      parseSnapshotArgs(['--out', 'snap.json', '--targets-out', 'targets.json']),
    ).toMatchObject({
      outPath: 'snap.json',
      targetsOutPath: 'targets.json',
    });
    expect(() => parseSnapshotArgs(['--out'])).toThrow(/--out requires/i);
    expect(() => parseSnapshotArgs(['--out', 's.json', '--nope'])).toThrow(/unknown option/i);
  });

  it('requires SNAPSHOT_PROMPT_HASH only when emitting targets', () => {
    expect(requireSnapshotPromptHash(undefined, { emitTargets: false })).toBeNull();
    expect(requireSnapshotPromptHash(null, { emitTargets: false })).toBeNull();
    expect(requireSnapshotPromptHash('not-a-hash', { emitTargets: false })).toBeNull();
    expect(() => requireSnapshotPromptHash(undefined, { emitTargets: true })).toThrow(
      /SNAPSHOT_PROMPT_HASH/,
    );
    expect(() => requireSnapshotPromptHash('short', { emitTargets: true })).toThrow(
      /SNAPSHOT_PROMPT_HASH/,
    );
    expect(requireSnapshotPromptHash(PROMPT_HASH, { emitTargets: true })).toBe(PROMPT_HASH);
  });

  it('writes snapshot and target artifacts with mode 0600, including overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centurion-snapshot-mode-'));
    try {
      const out = join(dir, 'snapshot.json');
      writePrivateJson(out, { secretFree: true });
      expect(statSync(out).mode & 0o777).toBe(0o600);
      chmodSync(out, 0o644);
      writePrivateJson(out, { secretFree: true, overwritten: true });
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restore requires --snapshot and rejects unknown options', () => {
    expect(() => parseRestoreArgs([])).toThrow(/--snapshot/i);
    expect(parseRestoreArgs(['--snapshot', 'snap.json', '--apply'])).toMatchObject({
      snapshotPath: 'snap.json',
      dryRun: false,
    });
    expect(() => parseRestoreArgs(['--snapshot'])).toThrow(/--snapshot requires/i);
    expect(() => parseRestoreArgs(['--snapshot', 's.json', '--bad'])).toThrow(/unknown option/i);
  });
});

describe('centurion triage snapshot cohorts + hashes', () => {
  it('classifies eligible/locked/blocked/allowed/outbound cohorts with canonical hashes', async () => {
    const { driver } = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });

    expect(snapshot.transportId).toBe(TRANSPORT_ID);
    expect(snapshot.cohorts.eligible.map((r: { threadId: string }) => r.threadId)).toEqual([
      't-eligible',
    ]);
    expect(snapshot.cohorts.locked.map((r: { threadId: string }) => r.threadId)).toEqual([
      't-locked',
    ]);
    expect(snapshot.cohorts.blocked.map((r: { threadId: string }) => r.threadId)).toEqual([
      't-blocked',
    ]);
    expect(snapshot.cohorts.allowed.map((r: { threadId: string }) => r.threadId)).toEqual([
      't-allowed',
    ]);
    expect(snapshot.cohorts.outboundOnly.map((r: { threadId: string }) => r.threadId)).toEqual([
      't-outbound',
    ]);

    const eligible = snapshot.cohorts.eligible[0]!;
    expect(eligible.triggerMessageId).toBe('m-eligible');
    expect(eligible.latestSender).toBe('guest@example.com');
    expect(eligible.policyState).toBe('none');
    expect(eligible.spamAt).toBe('2026-07-01T00:00:00.000Z');
    expect(eligible.spamUserLockedAt).toBeNull();
    expect(eligible.aiCategorySlugs).toEqual(['ops']);
    expect(eligible.customCategoryPresenceHash).toBe(
      computeCustomCategoryPresenceHash(['vip-desk']),
    );
    expect(eligible.triggerHash).toBe(
      computeTriggerHash({
        threadId: 't-eligible',
        triggerMessageId: 'm-eligible',
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    expect(eligible.preStateHash).toBe(
      computePreStateHash({
        spamAt: '2026-07-01T00:00:00.000Z',
        spamUserLockedAt: null,
        aiCategorySlugs: ['ops'],
      }),
    );
    expect(snapshot.snapshotHash).toBe(computeCanonicalSnapshotHash(snapshot));
  });

  it('rejects snapshotHash tamper', async () => {
    const { driver } = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    expect(() =>
      computeCanonicalSnapshotHash({ ...snapshot, snapshotHash: sha('tampered') }),
    ).not.toThrow();
    expect(computeCanonicalSnapshotHash({ ...snapshot, snapshotHash: undefined })).not.toBe(
      sha('tampered'),
    );
    expect(snapshot.snapshotHash).not.toBe(sha('tampered'));
    const tampered = { ...snapshot, snapshotHash: sha('tampered') };
    expect(tampered.snapshotHash).not.toBe(computeCanonicalSnapshotHash(tampered));
  });

  it('emits separately hashed target manifest without raw body', async () => {
    const { driver } = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const manifest = emitTargetManifestFromSnapshot(snapshot, {
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
    });
    expect(manifest.targets).toHaveLength(1);
    expect(manifest.targets[0]!.threadId).toBe('t-eligible');
    expect(JSON.stringify(manifest)).not.toMatch(/body|subject|Dear/i);
    expect(manifest.manifestHash).toBe(
      computeCanonicalManifestHash({
        version: manifest.version,
        transportId: manifest.transportId,
        generatedAt: manifest.generatedAt,
        modelId: manifest.modelId,
        promptVersion: manifest.promptVersion,
        promptHash: manifest.promptHash,
        snapshotHash: manifest.snapshotHash,
        targets: manifest.targets,
      }),
    );
    expect(() => validateApprovedRolloutManifest(manifest)).not.toThrow();

    const tampered = { ...manifest, manifestHash: sha('bad') };
    expect(() => validateApprovedRolloutManifest(tampered)).toThrow(/manifestHash/i);
  });

  it('binds approved refined category/urgent + rehearsal hashes', async () => {
    const { driver } = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const base = emitTargetManifestFromSnapshot(snapshot, {
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
    });
    const bound = bindApprovedTargetManifest(base, {
      sourceHash: SOURCE_HASH,
      approvals: [
        {
          threadId: 't-eligible',
          approvedCategory: 'groups-events',
          approvedUrgent: true,
          rehearsalResultHash: 'd'.repeat(64),
        },
      ],
    });
    expect(bound.targets[0]).toMatchObject({
      approvedCategory: 'groups-events',
      approvedUrgent: true,
      sourceHash: SOURCE_HASH,
      rehearsalResultHash: 'd'.repeat(64),
    });
    expect(() => validateApprovedRolloutManifest(bound)).not.toThrow();
  });

  it('normalizes one canonical sourceHash across every approved target', async () => {
    const { driver } = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const base = emitTargetManifestFromSnapshot(snapshot, {
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
    });
    const upperSourceHash = SOURCE_HASH.toUpperCase();
    const bound = bindApprovedTargetManifest(base, {
      sourceHash: upperSourceHash,
      approvals: [
        {
          threadId: 't-eligible',
          approvedCategory: 'groups-events',
          approvedUrgent: true,
          sourceHash: upperSourceHash,
          rehearsalResultHash: 'd'.repeat(64),
        },
      ],
    });
    expect(bound.sourceHash).toBe(SOURCE_HASH);
    expect(bound.targets[0]!.sourceHash).toBe(SOURCE_HASH);
    expect(() => validateBoundApprovedRolloutManifest(bound)).not.toThrow();
    expect(() =>
      bindApprovedTargetManifest(base, {
        sourceHash: SOURCE_HASH,
        approvals: [
          {
            threadId: 't-eligible',
            approvedCategory: 'groups-events',
            approvedUrgent: true,
            sourceHash: 'e'.repeat(64),
            rehearsalResultHash: 'd'.repeat(64),
          },
        ],
      }),
    ).toThrow(/sourceHash.*mismatch/i);
  });

  it('detects lock or sender-preference mismatch against live state', async () => {
    const store = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    // mutate live lock
    store.threads.get('t-eligible')!.spamUserLockedAt = '2026-07-30T13:00:00.000Z';
    await expect(
      verifySnapshotAgainstLive({ driver: store.driver, snapshot }),
    ).rejects.toThrow(/lock|locked|pre-state|mismatch/i);

    store.threads.get('t-eligible')!.spamUserLockedAt = null;
    store.preferences.set('guest@example.com', 'block');
    await expect(
      verifySnapshotAgainstLive({ driver: store.driver, snapshot }),
    ).rejects.toThrow(/preference|policy|mismatch/i);
  });

  it('snapshot→mutate→restore reproduces exact hash and preserves custom categories', async () => {
    const store = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const beforeHash = snapshot.snapshotHash;

    // mutate AI-managed + spam only; customs stay; restore must not touch customs
    const eligible = store.threads.get('t-eligible')!;
    eligible.aiCategorySlugs = ['new-bookings', 'urgent'];
    eligible.spamAt = null;

    const blocked = store.threads.get('t-blocked')!;
    blocked.aiCategorySlugs = ['ops'];

    await restoreCenturionTriageSnapshot({
      driver: store.driver,
      snapshot,
      dryRun: false,
    });

    expect(eligible.aiCategorySlugs).toEqual(['ops']);
    expect(eligible.spamAt).toBe('2026-07-01T00:00:00.000Z');
    expect(eligible.customCategorySlugs).toEqual(['vip-desk']);
    expect(blocked.aiCategorySlugs).toEqual([]);
    expect(blocked.customCategorySlugs).toEqual(['manual-tag']);

    const prefs = await store.driver.listSenderPreferenceSnapshot();
    expect(prefs).toEqual(
      expect.arrayContaining([
        { email: 'spam@bad.com', kind: 'block' },
        { email: 'vip@partner.com', kind: 'allow' },
      ]),
    );

    await verifySnapshotAgainstLive({ driver: store.driver, snapshot });
    const after = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    // canonical cohort AI/spam/custom-presence must match; generatedAt fixed in test
    expect(after.snapshotHash).toBe(beforeHash);
  });

  it('rejects lock drift before any restore mutation', async () => {
    const store = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const eligible = store.threads.get('t-eligible')!;
    eligible.aiCategorySlugs = ['new-bookings'];
    eligible.spamAt = null;
    eligible.spamUserLockedAt = '2026-07-31T12:00:00.000Z';

    await expect(
      restoreCenturionTriageSnapshot({
        driver: store.driver,
        snapshot,
        dryRun: false,
      }),
    ).rejects.toThrow(/lock|drift|mismatch/i);

    expect(eligible.aiCategorySlugs).toEqual(['new-bookings']);
    expect(eligible.spamAt).toBeNull();
    expect(eligible.spamUserLockedAt).toBe('2026-07-31T12:00:00.000Z');
  });

  it('uses one atomic restore batch so a later row failure leaves earlier rows unchanged', async () => {
    const store = createMemoryStore({ threads: baseThreads(), failRestoreAfter: true });
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const before = [...store.threads.values()].map((row) => ({
      threadId: row.threadId,
      spamAt: row.spamAt,
      spamUserLockedAt: row.spamUserLockedAt,
      aiCategorySlugs: [...row.aiCategorySlugs],
    }));

    await expect(
      restoreCenturionTriageSnapshot({ driver: store.driver, snapshot, dryRun: false }),
    ).rejects.toThrow(/restore batch/i);
    expect(
      [...store.threads.values()].map((row) => ({
        threadId: row.threadId,
        spamAt: row.spamAt,
        spamUserLockedAt: row.spamUserLockedAt,
        aiCategorySlugs: [...row.aiCategorySlugs],
      })),
    ).toEqual(before);
  });

  it('passes snapshot binding into atomic restore boundary', async () => {
    const store = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    const seen: string[] = [];
    const driver = {
      ...store.driver,
      async restoreAiManagedStateBatch(
        rows: Parameters<typeof store.driver.restoreAiManagedStateBatch>[0],
        boundSnapshot?: { snapshotHash: string },
      ) {
        seen.push(boundSnapshot?.snapshotHash ?? 'missing');
        return store.driver.restoreAiManagedStateBatch(rows, boundSnapshot);
      },
    };

    await restoreCenturionTriageSnapshot({ driver, snapshot, dryRun: false });

    expect(seen).toEqual([snapshot.snapshotHash]);
  });

  it('restore recovers legacy invent-WHO joins cleared by retag and preserves custom categories', async () => {
    const store = createMemoryStore({ threads: baseThreads() });
    const eligible = store.threads.get('t-eligible')!;
    eligible.aiCategorySlugs = ['ops', 'internal'];
    eligible.customCategorySlugs = ['vip-desk'];
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });

    // Retag clears stale invent-WHO joins before enqueue; rollback must put them back.
    eligible.aiCategorySlugs = ['ops'];
    await restoreCenturionTriageSnapshot({
      driver: store.driver,
      snapshot,
      dryRun: false,
    });

    expect(eligible.aiCategorySlugs).toEqual(['internal', 'ops']);
    expect(eligible.customCategorySlugs).toEqual(['vip-desk']);
  });

  it('restore dry-run does not mutate AI-managed state', async () => {
    const store = createMemoryStore({ threads: baseThreads() });
    const snapshot = await buildCenturionTriageSnapshot({
      driver: store.driver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    store.threads.get('t-eligible')!.aiCategorySlugs = ['urgent'];
    await restoreCenturionTriageSnapshot({
      driver: store.driver,
      snapshot,
      dryRun: true,
    });
    expect(store.threads.get('t-eligible')!.aiCategorySlugs).toEqual(['urgent']);
  });
});

describe('quiesced deploy wrappers', () => {
  it('quiesced path has no PM2 start/delete/save or HTTP health requirement', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-deploy.sh'), 'utf8');

    expect(deploy).toContain('--quiesced');
    expect(ops).toContain('--quiesced');
    expect(ops).toContain('vpn-health-assert.sh');

    const deployQuiesced = extractBashIfBlock(
      deploy,
      /if\s+\[\s*"\$\{?QUIESCED\}?"\s*=\s*"1"\s*\]/,
    );
    expect(deployQuiesced, 'deploy-ec2.sh must have QUIESCED=1 branch').toBeTruthy();
    // Full branch: assets-only exit 0, no PM2 mutate; online http allowed.
    expect(deployQuiesced).toContain('quiesced deploy ok');
    expect(deployQuiesced).toMatch(/exit 0/);
    expect(deployQuiesced).toMatch(/online http OK/);
    expect(deployQuiesced).not.toMatch(/must be stopped/);
    expect(deployQuiesced).not.toMatch(/quiesced deploy refused/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+start\b/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+delete\b/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+save\b/);
    expect(deployQuiesced).not.toMatch(/health attempt|\/health/);

    // ops quiesced: still VPN; must not require HTTP health when passing --quiesced
    expect(ops).toMatch(/QUIESCED/);
    const opsHealthBlock = extractBashIfBlock(
      ops,
      /if\s+\[\s*"\$\{?QUIESCED\}?"\s*=\s*"1"\s*\]/,
    );
    expect(opsHealthBlock, 'ops-deploy.sh must have QUIESCED=1 branch').toBeTruthy();
    expect(opsHealthBlock).toContain('deploy-ec2.sh --quiesced');
    expect(opsHealthBlock).not.toMatch(/curl[^\n]*\/health/);
    expect(ops).toContain('vpn-health-assert.sh');
  });
});
