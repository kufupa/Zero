import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  parseArgs,
  retagIdempotencyKey,
  computeCanonicalManifestHash,
  computeTriggerHash,
  computePreStateHash,
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
  state: string;
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
      approvedCategory: 'ops',
      approvedUrgent: false,
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
      async transaction<T>(work: (tx: {
        insertRunReturning: (row: {
          id: string;
          threadId: string;
          triggerMessageId: string;
          idempotencyKey: string;
          modelId: string;
          promptVersion: string;
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
            async insertRunReturning(row) {
              if (runs.has(row.idempotencyKey)) return null;
              runs.set(row.idempotencyKey, { ...row, state: 'queued' });
              if (failAfterInsert) {
                throw new Error('forced post-insert failure');
              }
              return row.id;
            },
            async clearAiManagedCategories(threadId) {
              const t = threads.get(threadId);
              if (!t) return;
              t.aiCategorySlugs = t.aiCategorySlugs.filter(
                (s) => !['ops', 'urgent', 'new-bookings', 'groups-events', 'at-risk', 'internal', 'individual', 'group', 'travel-agents'].includes(s),
              );
            },
            async clearSpamAt(threadId) {
              const t = threads.get(threadId);
              if (t) t.spamAt = null;
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
      keyPrefix: 'inbound-triage-retag-v5',
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
    });
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
          targets: manifest.targets,
        }),
      }),
    ).toThrow(/promptHash/i);
  });
});

describe('runCenturionRetag idempotency + skips', () => {
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
    expect(mem.threads.get('t-elig')?.aiCategorySlugs).toEqual([]);
    expect(mem.threads.get('t-elig')?.spamAt).toBeNull();

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

  it('skips locked, blocked, allowed, and outbound-only without mutation', async () => {
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
      scanned: 4,
      eligible: 0,
      skippedLocked: 1,
      skippedBlocked: 1,
      skippedAllowed: 1,
      skippedOutboundOnly: 1,
      inserted: 0,
      mutated: 0,
    });
    expect(mem.threads.get('t-locked')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t-block')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.threads.get('t-allow')?.aiCategorySlugs).toEqual(['ops']);
    expect(mem.runs.size).toBe(0);
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
    expect(src).toMatch(/ON CONFLICT\s*\(\s*idempotency_key\s*\)\s*DO NOTHING\s*RETURNING\s+id/i);
    expect(src).toMatch(/export\s+(async\s+)?function\s+runCenturionRetag/);
    expect(src).toMatch(/export\s+function\s+parseArgs/);
    expect(src).toMatch(/export\s+function\s+retagIdempotencyKey/);
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
