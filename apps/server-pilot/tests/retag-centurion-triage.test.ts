import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  AI_MANAGED_SLUGS,
  DEFAULT_MODEL_ID,
  DEFAULT_KEY_PREFIX,
  DEFAULT_PROMPT_VERSION,
  parseArgs,
  retagIdempotencyKey,
  computeCanonicalManifestHash,
  computeTriggerHash,
  computePreStateHash,
  RETAG_UNSETTLE_SLUGS,
  validateApprovedRolloutManifest,
  runCenturionRetag,
} from '../scripts/retag-centurion-triage.mjs';

const TRANSPORT_ID = 'transport-centurion';
const MODEL_ID = 'amazon.nova-lite-v1:0';
const PROMPT_VERSION = 'triage-v5';
const PROMPT_HASH = 'a'.repeat(64);

type PrefKind = 'block' | 'allow';

type MemThread = {
  threadId: string;
  spamAt: Date | null;
  spamUserLockedAt: Date | null;
  latestInboundId: string | null;
  latestInboundFrom: string | null;
  latestInboundCreatedAt: Date | null;
  aiCategorySlugs: string[];
  hasInbound: boolean;
};

type MemRun = {
  id: string;
  threadId: string;
  triggerMessageId: string;
  idempotencyKey: string;
  modelId: string;
  promptVersion: string;
  promptHash?: string | null;
  state: string;
  metrics?: Record<string, unknown>;
  claimOwner?: string | null;
  claimToken?: string | null;
  attempts?: number;
  nextRunAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  heartbeatAt?: Date | null;
  lastError?: string | null;
  failureClass?: string | null;
  updatedAt?: Date;
};

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildManifest(targets: Array<{
  threadId: string;
  triggerMessageId: string;
  triggerCreatedAt: string;
  spamAt?: string | null;
  spamUserLockedAt?: string | null;
  aiCategorySlugs?: string[];
}>) {
  const body = {
    version: 1,
    transportId: TRANSPORT_ID,
    generatedAt: '2026-07-30T12:00:00.000Z',
    modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
      sourceHash: 'b'.repeat(64),
      snapshotHash: 'd'.repeat(64),
      targets: targets.map((t) => ({
      threadId: t.threadId,
      triggerMessageId: t.triggerMessageId,
      triggerHash: computeTriggerHash({
        threadId: t.threadId,
        triggerMessageId: t.triggerMessageId,
        createdAt: t.triggerCreatedAt,
      }),
      preStateHash: computePreStateHash({
        spamAt: t.spamAt ?? null,
        spamUserLockedAt: t.spamUserLockedAt ?? null,
        aiCategorySlugs: t.aiCategorySlugs ?? [],
      }),
      approvedCategory: 'manage-stay',
      approvedPrimaryFolder: 'manage-stay',
      approvedUrgent: false,
      approvedIsSpam: false,
      sourceHash: 'b'.repeat(64),
      rehearsalResultHash: 'c'.repeat(64),
    })),
  };
  return {
    ...body,
    manifestHash: computeCanonicalManifestHash(body),
  };
}

function createMemoryDriver(seed: {
  threads: MemThread[];
  preferences?: Record<string, PrefKind>;
  existingKeys?: string[];
  failAfterInsert?: boolean;
  lockAfterInsert?: boolean;
  lockBeforeTransaction?: boolean;
}) {
  const threads = new Map(seed.threads.map((t) => [t.threadId, { ...t, aiCategorySlugs: [...t.aiCategorySlugs] }]));
  const preferences = new Map(Object.entries(seed.preferences ?? {}));
  const runs = new Map<string, MemRun>();
  for (const key of seed.existingKeys ?? []) {
    runs.set(key, {
      id: `existing-${key}`,
      threadId: 'unknown',
      triggerMessageId: 'unknown',
      idempotencyKey: key,
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      state: 'queued',
    });
  }
  let failAfterInsert = seed.failAfterInsert ?? false;
  let lockAfterInsert = seed.lockAfterInsert ?? false;
  let lockBeforeTransaction = seed.lockBeforeTransaction ?? false;

  return {
    threads,
    runs,
    setFailAfterInsert(v: boolean) {
      failAfterInsert = v;
    },
    driver: {
      async listAiManagedCategoryIds() {
        return ['cat-ops', 'cat-urgent'];
      },
      async listThreads(opts: { threadIds?: string[] | null }) {
        const all = [...threads.values()];
        if (opts.threadIds) {
          const want = new Set(opts.threadIds);
          return all.filter((t) => want.has(t.threadId));
        }
        return all;
      },
      async listSenderPreferences(emails: string[]) {
        const out = new Map<string, PrefKind>();
        for (const email of emails) {
          const kind = preferences.get(email);
          if (kind) out.set(email, kind);
        }
        return out;
      },
      async probeKeys(keys: string[]) {
        return new Set(keys.filter((k) => runs.has(k)));
      },
      async transaction<T>(work: (tx: {
        lockThreadForUpdate: (threadId: string) => Promise<MemThread | null>;
        getSenderPreference: (email: string) => Promise<PrefKind | null>;
        insertRunReturning: (row: {
          id: string;
          threadId: string;
          triggerMessageId: string;
          idempotencyKey: string;
          modelId: string;
          promptVersion: string;
          promptHash?: string | null;
          metrics?: Record<string, unknown>;
          now?: Date;
        }) => Promise<string | null>;
        clearAiManagedCategories: (threadId: string) => Promise<void>;
        clearSpamAt: (threadId: string) => Promise<void>;
      }) => Promise<T>): Promise<T> {
        const snapshotThreads = new Map(
          [...threads.entries()].map(([k, v]) => [k, { ...v, aiCategorySlugs: [...v.aiCategorySlugs] }]),
        );
        const snapshotRuns = new Map([...runs.entries()].map(([k, v]) => [k, { ...v }]));
        try {
          return await work({
            async lockThreadForUpdate(threadId) {
              const t = threads.get(threadId);
              if (!t) return null;
              if (lockBeforeTransaction) {
                lockBeforeTransaction = false;
                t.spamUserLockedAt = new Date('2026-07-01T11:00:00.000Z');
              }
              return { ...t, aiCategorySlugs: [...t.aiCategorySlugs] };
            },
            async getSenderPreference(email) {
              return preferences.get(email) ?? null;
            },
            async insertRunReturning(row) {
              const existing = runs.get(row.idempotencyKey);
              if (existing) {
                if (!['retry_wait', 'dead_letter'].includes(existing.state)) return null;
                runs.set(row.idempotencyKey, {
                  ...existing,
                  ...row,
                  id: existing.id,
                  state: 'queued',
                  metrics: row.metrics,
                  claimOwner: null,
                  claimToken: null,
                  attempts: 0,
                  nextRunAt: null,
                  startedAt: null,
                  finishedAt: null,
                  heartbeatAt: null,
                  lastError: null,
                  failureClass: null,
                  updatedAt: row.now,
                });
                return existing.id;
              }
              runs.set(row.idempotencyKey, {
                ...row,
                state: 'queued',
                metrics: row.metrics,
                updatedAt: row.now,
              });
              if (lockAfterInsert) {
                const t = threads.get(row.threadId);
                if (t) t.spamUserLockedAt = new Date('2026-07-01T11:00:00.000Z');
              }
              if (failAfterInsert) {
                throw new Error('forced post-insert failure');
              }
              return row.id;
            },
            async clearAiManagedCategories(threadId) {
              const t = threads.get(threadId);
              if (!t) return;
              if (t.spamUserLockedAt) return;
              t.aiCategorySlugs = t.aiCategorySlugs.filter(
                (s) => !['ops', 'urgent', 'new-bookings', 'groups-events', 'at-risk', 'internal', 'individual', 'group', 'travel-agents'].includes(s),
              );
            },
            async clearSpamAt(threadId) {
              const t = threads.get(threadId);
              if (t && !t.spamUserLockedAt) t.spamAt = null;
            },
          });
        } catch (err) {
          threads.clear();
          for (const [k, v] of snapshotThreads) threads.set(k, v);
          runs.clear();
          for (const [k, v] of snapshotRuns) runs.set(k, v);
          throw err;
        }
      },
    },
  };
}

describe('retag-centurion-triage CLI args', () => {
  it('defaults to dry-run and rejects unknown options', () => {
    expect(parseArgs(['--targets', 'm.json'])).toMatchObject({
      dryRun: true,
      keyPrefix: 'inbound-triage-retag-v6',
      targetsPath: 'm.json',
    });
    expect(() => parseArgs([])).toThrow(/--targets|--from-domain/i);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/i);
    expect(() => parseArgs(['--apply', '--targets'])).toThrow(/--targets requires/i);
    expect(() => parseArgs(['--key-prefix'])).toThrow(/--key-prefix requires/i);
    expect(() => parseArgs(['--from-domain'])).toThrow(/--from-domain requires/i);
  });

  it('requires --targets for full apply and forbids --targets with --from-domain', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/--targets/i);
    expect(() =>
      parseArgs(['--apply', '--targets', 'm.json', '--from-domain', 'example.com']),
    ).toThrow(/from-domain/i);
    expect(
      parseArgs(['--apply', '--targets', 'm.json', '--key-prefix', 'inbound-triage-retag-v5-x']),
    ).toMatchObject({
      dryRun: false,
      targetsPath: 'm.json',
      keyPrefix: 'inbound-triage-retag-v5-x',
      fromDomain: null,
    });
    expect(parseArgs(['--from-domain', 'RenniesBCDTravel.com'])).toMatchObject({
      dryRun: true,
      fromDomain: 'renniesbcdtravel.com',
      targetsPath: null,
      includeNonSpam: false,
    });
    expect(
      parseArgs(['--from-domain', 'synxis.com', '--include-non-spam']),
    ).toMatchObject({
      fromDomain: 'synxis.com',
      includeNonSpam: true,
    });
    expect(() => parseArgs(['--include-non-spam'])).toThrow(/--from-domain/i);
  });

  it('uses v6 prompt/key defaults and manages legacy plus workflow slugs', () => {
    expect(DEFAULT_MODEL_ID).toBe('global.openai.gpt-6-luna');
    expect(DEFAULT_PROMPT_VERSION).toBe('triage-v6');
    expect(DEFAULT_KEY_PREFIX).toBe('inbound-triage-retag-v6');
    expect(AI_MANAGED_SLUGS).toEqual(
      expect.arrayContaining([
        'new-bookings',
        'groups-events',
        'at-risk',
        'ops',
        'bookings',
        'manage-stay',
        'confirm-reconcile',
        'money-billing',
        'documents-delivery',
        'exceptions-recovery',
        'guest-experience',
        'internal-partner',
        'automated-channel',
        'unknown-review',
        'urgent',
      ]),
    );
    expect(new Set(AI_MANAGED_SLUGS).size).toBe(15);
    expect(RETAG_UNSETTLE_SLUGS).toEqual(
      expect.arrayContaining([
        ...AI_MANAGED_SLUGS,
        'internal',
        'individual',
        'group',
        'travel-agents',
      ]),
    );
  });
});

describe('retag idempotency key + manifest validation', () => {
  it('builds stable idempotency keys', () => {
    expect(retagIdempotencyKey('msg-1', 'prefix')).toBe('prefix:msg-1');
  });

  it('rejects hash tamper and duplicate target IDs', () => {
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
    expect(() => validateApprovedRolloutManifest(manifest)).not.toThrow();
    expect(() =>
      validateApprovedRolloutManifest({ ...manifest, manifestHash: sha('tampered') }),
    ).toThrow(/manifestHash/i);

    const dup = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        threadId: 't1',
        triggerMessageId: 'm2',
        triggerCreatedAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    // force duplicate past hash builder uniqueness
    dup.targets[1]!.threadId = 't1';
    dup.manifestHash = computeCanonicalManifestHash({
      version: dup.version,
      transportId: dup.transportId,
      generatedAt: dup.generatedAt,
      modelId: dup.modelId,
      promptVersion: dup.promptVersion,
      promptHash: dup.promptHash,
      sourceHash: dup.sourceHash,
      snapshotHash: dup.snapshotHash,
      targets: dup.targets,
    });
    expect(() => validateApprovedRolloutManifest(dup)).toThrow(/duplicate target/i);
  });

  it('requires transport-centurion and approved model/version/prompt hash', () => {
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
    expect(() =>
      validateApprovedRolloutManifest({ ...manifest, transportId: 'transport-other', manifestHash: 'x' }),
    ).toThrow(/transport-centurion/i);
    expect(() =>
      validateApprovedRolloutManifest({
        ...manifest,
        promptHash: 'short',
        manifestHash: computeCanonicalManifestHash({
          version: 1,
          transportId: TRANSPORT_ID,
          generatedAt: manifest.generatedAt,
          modelId: MODEL_ID,
          promptVersion: PROMPT_VERSION,
          promptHash: 'short',
          sourceHash: manifest.sourceHash,
          snapshotHash: manifest.snapshotHash,
          targets: manifest.targets,
        }),
      }),
    ).toThrow(/promptHash/i);
  });

  it('requires approval/source/rehearsal binding before apply', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't-unbound',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: 'm-unbound',
          latestInboundFrom: 'guest@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
      ],
    });
    const bound = buildManifest([
      { threadId: 't-unbound', triggerMessageId: 'm-unbound', triggerCreatedAt: createdAt },
    ]);
    const { manifestHash: _ignored, sourceHash: _source, ...withoutRootBinding } = bound;
    const unbound = {
      ...withoutRootBinding,
      targets: bound.targets.map(
        ({
          approvedCategory: _category,
          approvedPrimaryFolder: _primary,
          approvedUrgent: _urgent,
          approvedIsSpam: _spam,
          sourceHash: _targetSource,
          rehearsalResultHash: _rehearsal,
          ...target
        }) => target,
      ),
    };
    unbound.manifestHash = computeCanonicalManifestHash({
      version: unbound.version,
      transportId: unbound.transportId,
      generatedAt: unbound.generatedAt,
      modelId: unbound.modelId,
      promptVersion: unbound.promptVersion,
      promptHash: unbound.promptHash,
      snapshotHash: unbound.snapshotHash,
      targets: unbound.targets,
    });

    await expect(
      runCenturionRetag({
        driver: mem.driver,
        dryRun: false,
        keyPrefix: 'inbound-triage-retag-v6-unbound',
        fromDomain: null,
        manifest: unbound,
      }),
    ).rejects.toThrow(/bound|approval|rehearsal|source/i);
    expect(mem.runs.size).toBe(0);
    expect(mem.threads.get('t-unbound')?.aiCategorySlugs).toEqual(['ops']);
  });
});

describe('runCenturionRetag idempotency + skips', () => {
  it('successful enqueue preserves prior AI state until worker succeeds', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const spamAt = new Date('2026-07-01T09:00:00.000Z');
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't-pending',
          spamAt,
          spamUserLockedAt: null,
          latestInboundId: 'm-pending',
          latestInboundFrom: 'a@b.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops', 'urgent'],
          hasInbound: true,
        },
      ],
    });
    const manifest = buildManifest([
      {
        threadId: 't-pending',
        triggerMessageId: 'm-pending',
        triggerCreatedAt: createdAt,
        spamAt: spamAt.toISOString(),
        aiCategorySlugs: ['ops', 'urgent'],
      },
    ]);

    const result = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v6-pending',
      fromDomain: null,
      manifest,
    });

    expect(result).toMatchObject({ inserted: 1, mutated: 1 });
    expect(mem.threads.get('t-pending')?.aiCategorySlugs).toEqual(['ops', 'urgent']);
    expect(mem.threads.get('t-pending')?.spamAt).toEqual(spamAt);
  });

  it('second identical apply reports collision, zero inserts/mutations, labels unchanged', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't-elig',
          spamAt: new Date('2026-07-01T09:00:00.000Z'),
          spamUserLockedAt: null,
          latestInboundId: 'm-elig',
          latestInboundFrom: 'guest@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops', 'urgent'],
          hasInbound: true,
        },
      ],
    });
    const manifest = buildManifest([
      {
        threadId: 't-elig',
        triggerMessageId: 'm-elig',
        triggerCreatedAt: createdAt,
        spamAt: '2026-07-01T09:00:00.000Z',
        aiCategorySlugs: ['ops', 'urgent'],
      },
    ]);

    const first = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v5-test',
      fromDomain: null,
      manifest,
    });
    expect(first).toMatchObject({
      scanned: 1,
      eligible: 1,
      wouldInsert: 0,
      inserted: 1,
      mutated: 1,
      collisions: 0,
    });
    expect(mem.threads.get('t-elig')?.aiCategorySlugs).toEqual(['ops', 'urgent']);
    expect(mem.threads.get('t-elig')?.spamAt?.toISOString()).toBe('2026-07-01T09:00:00.000Z');

    // restore labels to prove second apply does not clear again — simulate worker re-applied
    mem.threads.get('t-elig')!.aiCategorySlugs = ['ops'];
    mem.threads.get('t-elig')!.spamAt = new Date('2026-07-02T00:00:00.000Z');
    // update pre-state in a fresh manifest matching current state for second apply attempt
    const manifest2 = buildManifest([
      {
        threadId: 't-elig',
        triggerMessageId: 'm-elig',
        triggerCreatedAt: createdAt,
        spamAt: '2026-07-02T00:00:00.000Z',
        aiCategorySlugs: ['ops'],
      },
    ]);

    const second = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v5-test',
      fromDomain: null,
      manifest: manifest2,
    });
    expect(second).toMatchObject({
      inserted: 0,
      mutated: 0,
      collisions: 1,
      wouldInsert: 0,
    });
    expect(mem.threads.get('t-elig')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t-elig')?.spamAt?.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  it('existing-key collision mutates nothing', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const keyPrefix = 'inbound-triage-retag-v5-collide';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't1',
          spamAt: new Date('2026-07-01T09:00:00.000Z'),
          spamUserLockedAt: null,
          latestInboundId: 'm1',
          latestInboundFrom: 'a@b.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
      ],
      existingKeys: [retagIdempotencyKey('m1', keyPrefix)],
    });
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: createdAt,
        spamAt: '2026-07-01T09:00:00.000Z',
        aiCategorySlugs: ['ops'],
      },
    ]);
    const result = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix,
      fromDomain: null,
      manifest,
    });
    expect(result).toMatchObject({ collisions: 1, inserted: 0, mutated: 0 });
    expect(mem.threads.get('t1')?.aiCategorySlugs).toEqual(['ops']);
  });

  it('resumes the same key only from retry_wait/dead_letter and resets failure state', async () => {
    for (const state of ['retry_wait', 'dead_letter']) {
      const createdAt = '2026-07-01T10:00:00.000Z';
      const keyPrefix = `inbound-triage-retag-v6-resume-${state}`;
      const mem = createMemoryDriver({
        threads: [
          {
            threadId: 't-resume',
            spamAt: new Date('2026-07-01T09:00:00.000Z'),
            spamUserLockedAt: null,
            latestInboundId: 'm-resume',
            latestInboundFrom: 'guest@example.com',
            latestInboundCreatedAt: new Date(createdAt),
            aiCategorySlugs: ['ops', 'urgent'],
            hasInbound: true,
          },
        ],
        existingKeys: [retagIdempotencyKey('m-resume', keyPrefix)],
      });
      const existing = mem.runs.get(retagIdempotencyKey('m-resume', keyPrefix))!;
      Object.assign(existing, {
        state,
        claimOwner: 'stale-worker',
        claimToken: 'stale-token',
        attempts: 3,
        nextRunAt: new Date('2026-07-01T11:00:00.000Z'),
        startedAt: new Date('2026-07-01T10:30:00.000Z'),
        finishedAt: new Date('2026-07-01T10:31:00.000Z'),
        heartbeatAt: new Date('2026-07-01T10:30:30.000Z'),
        lastError: 'old failure',
        failureClass: 'transient',
      });

      const manifest = buildManifest([
        {
          threadId: 't-resume',
          triggerMessageId: 'm-resume',
          triggerCreatedAt: createdAt,
          spamAt: '2026-07-01T09:00:00.000Z',
          aiCategorySlugs: ['ops', 'urgent'],
        },
      ]);
      const result = await runCenturionRetag({
        driver: mem.driver,
        dryRun: false,
        keyPrefix,
        fromDomain: null,
        manifest,
      });

      expect(result).toMatchObject({ inserted: 1, mutated: 1, collisions: 0 });
      expect(mem.runs.get(retagIdempotencyKey('m-resume', keyPrefix))).toMatchObject({
        state: 'queued',
        claimOwner: null,
        claimToken: null,
        attempts: 0,
        nextRunAt: null,
        startedAt: null,
        finishedAt: null,
        heartbeatAt: null,
        lastError: null,
        failureClass: null,
        metrics: { retagPending: true },
      });
      expect(mem.threads.get('t-resume')?.aiCategorySlugs).toEqual(['ops', 'urgent']);
      expect(mem.threads.get('t-resume')?.spamAt?.toISOString()).toBe('2026-07-01T09:00:00.000Z');
    }

    const terminalKeyPrefix = 'inbound-triage-retag-v6-resume-terminal';
    const terminalMem = createMemoryDriver({
      threads: [
        {
          threadId: 't-resume',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: 'm-resume',
          latestInboundFrom: 'guest@example.com',
          latestInboundCreatedAt: new Date('2026-07-01T10:00:00.000Z'),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
      ],
      existingKeys: [retagIdempotencyKey('m-resume', terminalKeyPrefix)],
    });
    const terminalResult = await runCenturionRetag({
      driver: terminalMem.driver,
      dryRun: false,
      keyPrefix: terminalKeyPrefix,
      fromDomain: null,
      manifest: buildManifest([
        {
          threadId: 't-resume',
          triggerMessageId: 'm-resume',
          triggerCreatedAt: '2026-07-01T10:00:00.000Z',
          aiCategorySlugs: ['ops'],
        },
      ]),
    });
    expect(terminalResult).toMatchObject({ inserted: 0, mutated: 0, collisions: 1 });
  });

  it('transaction rollback leaves no run and no mutation', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const keyPrefix = 'inbound-triage-retag-v5-rollback';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't1',
          spamAt: new Date('2026-07-01T09:00:00.000Z'),
          spamUserLockedAt: null,
          latestInboundId: 'm1',
          latestInboundFrom: 'a@b.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
      ],
      failAfterInsert: true,
    });
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: createdAt,
        spamAt: '2026-07-01T09:00:00.000Z',
        aiCategorySlugs: ['ops'],
      },
    ]);
    await expect(
      runCenturionRetag({
        driver: mem.driver,
        dryRun: false,
        keyPrefix,
        fromDomain: null,
        manifest,
      }),
    ).rejects.toThrow(/forced post-insert failure/);
    expect(mem.runs.size).toBe(0);
    expect(mem.threads.get('t1')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t1')?.spamAt).not.toBeNull();
  });

  it('dry-run wouldInsert agrees with apply inserted', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const keyPrefix = 'inbound-triage-retag-v5-agree';
    const seedThreads: MemThread[] = [
      {
        threadId: 't1',
        spamAt: null,
        spamUserLockedAt: null,
        latestInboundId: 'm1',
        latestInboundFrom: 'a@b.com',
        latestInboundCreatedAt: new Date(createdAt),
        aiCategorySlugs: ['ops'],
        hasInbound: true,
      },
    ];
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: createdAt,
        aiCategorySlugs: ['ops'],
      },
    ]);
    const dryMem = createMemoryDriver({ threads: seedThreads });
    const dry = await runCenturionRetag({
      driver: dryMem.driver,
      dryRun: true,
      keyPrefix,
      fromDomain: null,
      manifest,
    });
    const applyMem = createMemoryDriver({ threads: seedThreads.map((t) => ({ ...t, aiCategorySlugs: [...t.aiCategorySlugs] })) });
    const apply = await runCenturionRetag({
      driver: applyMem.driver,
      dryRun: false,
      keyPrefix,
      fromDomain: null,
      manifest,
    });
    expect(dry.wouldInsert).toBe(1);
    expect(apply.inserted).toBe(dry.wouldInsert);
    expect(apply.mutated).toBe(dry.wouldInsert);
    expect(dry.inserted).toBe(0);
    expect(dry.mutated).toBe(0);
  });

  it('dry-run existing key reports collisions=1 wouldInsert=0 (agrees with apply)', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const keyPrefix = 'inbound-triage-retag-v5-dry-collide';
    const seedThreads: MemThread[] = [
      {
        threadId: 't1',
        spamAt: new Date('2026-07-01T09:00:00.000Z'),
        spamUserLockedAt: null,
        latestInboundId: 'm1',
        latestInboundFrom: 'a@b.com',
        latestInboundCreatedAt: new Date(createdAt),
        aiCategorySlugs: ['ops'],
        hasInbound: true,
      },
    ];
    const existingKeys = [retagIdempotencyKey('m1', keyPrefix)];
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: createdAt,
        spamAt: '2026-07-01T09:00:00.000Z',
        aiCategorySlugs: ['ops'],
      },
    ]);
    const dryMem = createMemoryDriver({
      threads: seedThreads.map((t) => ({ ...t, aiCategorySlugs: [...t.aiCategorySlugs] })),
      existingKeys,
    });
    const dry = await runCenturionRetag({
      driver: dryMem.driver,
      dryRun: true,
      keyPrefix,
      fromDomain: null,
      manifest,
    });
    expect(dry).toMatchObject({
      eligible: 1,
      collisions: 1,
      wouldInsert: 0,
      inserted: 0,
      mutated: 0,
    });

    const applyMem = createMemoryDriver({
      threads: seedThreads.map((t) => ({ ...t, aiCategorySlugs: [...t.aiCategorySlugs] })),
      existingKeys,
    });
    const apply = await runCenturionRetag({
      driver: applyMem.driver,
      dryRun: false,
      keyPrefix,
      fromDomain: null,
      manifest,
    });
    expect(apply).toMatchObject({
      eligible: 1,
      collisions: 1,
      wouldInsert: 0,
      inserted: 0,
      mutated: 0,
    });
    expect(dry.collisions).toBe(apply.collisions);
    expect(dry.wouldInsert).toBe(apply.inserted);
    expect(applyMem.threads.get('t1')?.aiCategorySlugs).toEqual(['ops']);
  });

  it('skips locked, blocked, allowed, outbound-only, and not-spam domain without mutation', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't-locked',
          spamAt: new Date(),
          spamUserLockedAt: new Date(),
          latestInboundId: 'm-locked',
          latestInboundFrom: 'locked@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
        {
          threadId: 't-block',
          spamAt: new Date(),
          spamUserLockedAt: null,
          latestInboundId: 'm-block',
          latestInboundFrom: 'blocked@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
        {
          threadId: 't-allow',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: 'm-allow',
          latestInboundFrom: 'allowed@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
        {
          threadId: 't-out',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: null,
          latestInboundFrom: null,
          latestInboundCreatedAt: null,
          aiCategorySlugs: [],
          hasInbound: false,
        },
        {
          threadId: 't-nospam',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: 'm-nospam',
          latestInboundFrom: 'clean@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
      ],
      preferences: {
        'blocked@example.com': 'block',
        'allowed@example.com': 'allow',
      },
    });

    const result = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v5-skips',
      fromDomain: 'example.com',
      manifest: null,
    });

    expect(result).toMatchObject({
      scanned: 5,
      eligible: 0,
      skippedLocked: 1,
      skippedBlocked: 1,
      skippedAllowed: 1,
      skippedOutboundOnly: 1,
      skippedNotSpam: 1,
      inserted: 0,
      mutated: 0,
    });
    expect(mem.threads.get('t-locked')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t-block')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t-allow')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t-nospam')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.runs.size).toBe(0);
  });

  it('includeNonSpam allows from-domain quality repair of non-spam Automate donors', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't-synxis',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: 'm-synxis',
          latestInboundFrom: 'notice@synxis.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['bookings'],
          hasInbound: true,
        },
      ],
    });

    const dry = await runCenturionRetag({
      driver: mem.driver,
      dryRun: true,
      keyPrefix: 'inbound-triage-retag-v6-quality-domain',
      fromDomain: 'synxis.com',
      includeNonSpam: true,
      manifest: null,
    });
    expect(dry).toMatchObject({
      scanned: 1,
      eligible: 1,
      skippedNotSpam: 0,
      wouldInsert: 1,
    });

    const applied = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v6-quality-domain',
      fromDomain: 'synxis.com',
      includeNonSpam: true,
      manifest: null,
    });
    expect(applied).toMatchObject({
      eligible: 1,
      inserted: 1,
      mutated: 1,
      skippedNotSpam: 0,
    });
    expect(mem.runs.size).toBe(1);
    expect([...mem.runs.values()][0]?.metrics).toMatchObject({ retagPending: true });
  });

  it('selects latest inbound by createdAt/id not backdated received dates', async () => {
    // Memory driver already exposes trusted latestInboundId; assert helper order contract via hashes
    // and that trigger drift fires when DB latest differs from manifest.
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't1',
          spamAt: null,
          spamUserLockedAt: null,
          latestInboundId: 'm-newer-created',
          latestInboundFrom: 'new@example.com',
          latestInboundCreatedAt: new Date('2026-07-02T00:00:00.000Z'),
          aiCategorySlugs: [],
          hasInbound: true,
        },
      ],
    });
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm-older-created-but-newer-received',
        triggerCreatedAt: createdAt,
      },
    ]);
    await expect(
      runCenturionRetag({
        driver: mem.driver,
        dryRun: true,
        keyPrefix: 'inbound-triage-retag-v5-drift',
        fromDomain: null,
        manifest,
      }),
    ).rejects.toThrow(/trigger drift/i);
  });

  it('preserves spam_at when user lock appears before guarded clear', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const spamAt = '2026-07-01T09:00:00.000Z';
    const mem = createMemoryDriver({
      lockAfterInsert: true,
      threads: [
        {
          threadId: 't-lock-race',
          spamAt: new Date(spamAt),
          spamUserLockedAt: null,
          latestInboundId: 'm-lock-race',
          latestInboundFrom: 'guest@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops'],
          hasInbound: true,
        },
      ],
    });
    const manifest = buildManifest([
      {
        threadId: 't-lock-race',
        triggerMessageId: 'm-lock-race',
        triggerCreatedAt: createdAt,
        spamAt,
        aiCategorySlugs: ['ops'],
      },
    ]);

    const result = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v5-lock-race',
      fromDomain: null,
      manifest,
    });

    expect(result).toMatchObject({ inserted: 1, mutated: 1 });
    expect(mem.threads.get('t-lock-race')?.spamAt?.toISOString()).toBe(spamAt);
    expect(mem.threads.get('t-lock-race')?.spamUserLockedAt).not.toBeNull();
    expect(mem.threads.get('t-lock-race')?.aiCategorySlugs).toEqual(['ops']);
  });

  it('rechecks the locked row inside the mutation transaction before enqueue and clear', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      lockBeforeTransaction: true,
      threads: [
        {
          threadId: 't-lock-before',
          spamAt: new Date('2026-07-01T09:00:00.000Z'),
          spamUserLockedAt: null,
          latestInboundId: 'm-lock-before',
          latestInboundFrom: 'guest@example.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['ops', 'urgent'],
          hasInbound: true,
        },
      ],
    });
    const manifest = buildManifest([
      {
        threadId: 't-lock-before',
        triggerMessageId: 'm-lock-before',
        triggerCreatedAt: createdAt,
        spamAt: '2026-07-01T09:00:00.000Z',
        aiCategorySlugs: ['ops', 'urgent'],
      },
    ]);

    const result = await runCenturionRetag({
      driver: mem.driver,
      dryRun: false,
      keyPrefix: 'inbound-triage-retag-v6-lock-before',
      fromDomain: null,
      manifest,
    });

    expect(result).toMatchObject({ skippedLocked: 1, inserted: 0, mutated: 0 });
    expect(mem.runs.size).toBe(0);
    expect(mem.threads.get('t-lock-before')?.aiCategorySlugs).toEqual(['ops', 'urgent']);
  });

  it('refuses pre-state drift and rows absent from manifest', async () => {
    const createdAt = '2026-07-01T10:00:00.000Z';
    const mem = createMemoryDriver({
      threads: [
        {
          threadId: 't1',
          spamAt: new Date('2026-07-03T00:00:00.000Z'),
          spamUserLockedAt: null,
          latestInboundId: 'm1',
          latestInboundFrom: 'a@b.com',
          latestInboundCreatedAt: new Date(createdAt),
          aiCategorySlugs: ['at-risk'],
          hasInbound: true,
        },
      ],
    });
    const manifest = buildManifest([
      {
        threadId: 't1',
        triggerMessageId: 'm1',
        triggerCreatedAt: createdAt,
        spamAt: null,
        aiCategorySlugs: ['ops'],
      },
    ]);
    await expect(
      runCenturionRetag({
        driver: mem.driver,
        dryRun: true,
        keyPrefix: 'inbound-triage-retag-v5-pre',
        fromDomain: null,
        manifest,
      }),
    ).rejects.toThrow(/pre-state drift/i);

    const missing = buildManifest([
      {
        threadId: 't-missing',
        triggerMessageId: 'm-missing',
        triggerCreatedAt: createdAt,
      },
    ]);
    await expect(
      runCenturionRetag({
        driver: mem.driver,
        dryRun: true,
        keyPrefix: 'inbound-triage-retag-v5-missing',
        fromDomain: null,
        manifest: missing,
      }),
    ).rejects.toThrow(/absent from|not found|missing target/i);
  });
});

describe('retag script source contract', () => {
  it('orders latest inbound by created_at DESC, id DESC and inserts before mutate with RETURNING', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pathJoin } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathJoin(here, '../scripts/retag-centurion-triage.mjs'), 'utf8');
    expect(src).toMatch(/ORDER BY\s+m\.created_at DESC\s*,\s*m\.id DESC/i);
    expect(src).toMatch(
      /ON CONFLICT\s*\(\s*idempotency_key\s*\)\s*DO UPDATE[\s\S]*WHERE\s+ai_workflow_run\.state\s+IN\s*\(\s*'retry_wait'\s*,\s*'dead_letter'\s*\)[\s\S]*RETURNING\s+id/i,
    );
    expect(src).toMatch(/probeKeys/);
    expect(src).toMatch(/export\s+(async\s+)?function\s+runCenturionRetag/);
    expect(src).toMatch(/export\s+function\s+parseArgs/);
    expect(src).toMatch(/export\s+function\s+retagIdempotencyKey/);
  });

  it('guards spam clearing against a concurrent user spam lock', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pathJoin } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathJoin(here, '../scripts/retag-centurion-triage.mjs'), 'utf8');
    expect(src).toMatch(/SET\s+spam_at\s*=\s*NULL[\s\S]*spam_user_locked_at\s+IS\s+NULL/i);
  });
});

describe('load targets file hash surface', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retag-manifest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parseArgs accepts targets path for dry-run full rollout', () => {
    const path = join(dir, 'approved.json');
    writeFileSync(path, '{}');
    expect(parseArgs(['--targets', path])).toMatchObject({
      dryRun: true,
      targetsPath: path,
    });
  });
});
