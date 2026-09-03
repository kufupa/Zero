import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditCenturionTriageRetag,
  createPostgresAuditDriver,
  effectiveDurableDecision,
  hashProductionTriageInput,
  parseAuditArgs,
} from '../scripts/audit-centurion-triage-retag.mjs';
import {
  Q11_MIN_AUTOMATE_THREADS,
  Q11_MIN_SPAM_THREADS,
  Q11_WINDOW_ACTIONABLE,
  Q11_WINDOW_RESPONDED,
  Q11_WINDOW_UNANSWERED,
  QUALITY_AUTOMATE_RECALL_FLOOR,
  QUALITY_SPAM_RECALL_FLOOR,
  auditCenturionTriageQuality,
  evaluateGoldAutomateRecall,
  evaluateGoldSpamRecall,
  evaluateQ11VolumeBand,
  evaluateSpamFpV6Refine,
  loadCenturionTriageQualityGoldFixture,
  type CenturionTriageQualityDriver,
  type Q11VolumeMetrics,
} from '../src/ops/centurion-triage-quality-audit.js';
import {
  bindApprovedTargetManifest,
  buildCenturionTriageSnapshot,
  emitTargetManifestFromSnapshot,
} from '../scripts/snapshot-centurion-triage.mjs';
import { computeCanonicalManifestHash } from '../scripts/retag-centurion-triage.mjs';

function rehashManifest(manifest: Record<string, unknown>) {
  const { manifestHash: _ignored, ...withoutHash } = manifest as {
    manifestHash?: string;
    [k: string]: unknown;
  };
  return {
    ...withoutHash,
    manifestHash: computeCanonicalManifestHash(withoutHash),
  };
}

const MODEL_ID = 'amazon.nova-lite-v1:0';
const PROMPT_VERSION = 'triage-v5';
const PROMPT_HASH = 'b'.repeat(64);
const SOURCE_HASH = 'c'.repeat(64);
const KEY_PREFIX = 'inbound-triage-retag-v5-cutover';

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

type MemRun = {
  id: string;
  threadId: string;
  triggerMessageId: string;
  idempotencyKey: string;
  modelId: string;
  promptVersion: string;
  promptHash: string | null;
  state: string;
  metrics: Record<string, unknown>;
  createdAt: string;
  finishedAt: string;
};

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function baseThreads(): MemThread[] {
  return [
    {
      threadId: 't-eligible',
      spamAt: null,
      spamUserLockedAt: null,
      latestInboundId: 'm-eligible',
      latestInboundFrom: 'guest@example.com',
      latestInboundCreatedAt: '2026-07-01T00:00:00.000Z',
      aiCategorySlugs: ['groups-events', 'urgent'],
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
      customCategorySlugs: [],
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

function preCutoverThreads(): MemThread[] {
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
      customCategorySlugs: [],
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

async function buildApprovedFixture(opts?: {
  latestInboundFrom?: string;
  mutateLiveAfterSnapshot?: (threads: Map<string, MemThread>) => void;
  mutateRun?: (run: MemRun) => void;
  mutateManifest?: (manifest: any) => any;
  extraRun?: MemRun;
  applySummary?: Record<string, unknown>;
  skipPostApplyMutation?: boolean;
}) {
  const initialThreads = preCutoverThreads();
  if (opts?.latestInboundFrom) {
    initialThreads[0].latestInboundFrom = opts.latestInboundFrom;
  }
  const threads = new Map(
    initialThreads.map((t) => [
      t.threadId,
      {
        ...t,
        aiCategorySlugs: [...t.aiCategorySlugs],
        customCategorySlugs: [...t.customCategorySlugs],
      },
    ]),
  );
  const preferences = new Map<string, PrefKind>([
    ['spam@bad.com', 'block'],
    ['vip@partner.com', 'allow'],
  ]);

  const snapshotDriver = {
    async listThreads() {
      return [...threads.values()].map((t) => ({
        ...t,
        aiCategorySlugs: [...t.aiCategorySlugs],
        customCategorySlugs: [...t.customCategorySlugs],
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
  };

  const snapshot = await buildCenturionTriageSnapshot({
    driver: snapshotDriver,
    generatedAt: '2026-07-30T12:00:00.000Z',
  });

  let manifest = emitTargetManifestFromSnapshot(snapshot, {
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
  });
  if (manifest.targets.length === 0) {
    throw new Error('fixture expected eligible target');
  }
  manifest = bindApprovedTargetManifest(manifest, {
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
  if (opts?.mutateManifest) {
    manifest = opts.mutateManifest(manifest);
  }

  // Post-apply durable state for eligible target (excluded cohorts unchanged unless test mutates).
  if (!opts?.skipPostApplyMutation) {
    const eligible = threads.get('t-eligible')!;
    eligible.aiCategorySlugs = ['groups-events', 'urgent'];
    eligible.spamAt = null;
  }
  opts?.mutateLiveAfterSnapshot?.(threads);

  const inputHash = 'e'.repeat(64);
  const run: MemRun = {
    id: 'run-1',
    threadId: 't-eligible',
    triggerMessageId: 'm-eligible',
    idempotencyKey: `${KEY_PREFIX}:m-eligible`,
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
    state: 'succeeded',
    createdAt: '2026-07-30T12:59:00.000Z',
    finishedAt: '2026-07-30T13:00:00.000Z',
    metrics: {
      category: 'groups-events',
      urgent: true,
      applyMode: 'full',
      inputHash,
      promptHash: PROMPT_HASH,
      draftRunId: undefined,
    },
  };
  opts?.mutateRun?.(run);
  const runs = [run];
  if (opts?.extraRun) runs.push(opts.extraRun);

  const applySummary = {
    mode: 'apply',
    inserted: 1,
    mutated: 1,
    collisions: 0,
    eligible: 1,
    skippedLocked: 1,
    skippedBlocked: 1,
    skippedAllowed: 1,
    skippedOutboundOnly: 1,
    keyPrefix: KEY_PREFIX,
    manifestHash: manifest.manifestHash,
    ...opts?.applySummary,
  };

  const auditDriver = {
    async listRunsByPrefix(prefix: string) {
      return runs.filter(
        (r) => r.idempotencyKey.startsWith(`${prefix}:`) || r.idempotencyKey.startsWith(prefix),
      );
    },
    async recomputeProductionInputHash(input: {
      threadId: string;
      triggerMessageId: string;
      modelId: string;
      promptVersion: string;
      asOf: string;
    }) {
      void input;
      return inputHash;
    },
    async listDurableAiState(threadId: string) {
      const t = threads.get(threadId);
      if (!t) throw new Error(`missing ${threadId}`);
      return {
        spamAt: t.spamAt,
        spamUserLockedAt: t.spamUserLockedAt,
        aiCategorySlugs: [...t.aiCategorySlugs],
      };
    },
    async listThreadState(threadId: string) {
      return this.listDurableAiState(threadId);
    },
  };

  return { snapshot, manifest, applySummary, auditDriver, threads, runs, inputHash };
}

const here = dirname(fileURLToPath(import.meta.url));
const goldFixturePath = join(here, 'fixtures', 'centurion-triage-quality-gold.json');

function goodQ11Volume(): Q11VolumeMetrics {
  return {
    automateThreads: Q11_MIN_AUTOMATE_THREADS,
    spamThreads: Q11_MIN_SPAM_THREADS,
    unanswered: Q11_WINDOW_UNANSWERED,
    responded: Q11_WINDOW_RESPONDED,
    actionable: Q11_WINDOW_ACTIONABLE,
  };
}

function qualityDriver(overrides?: {
  neverSpamInSpam?: number;
  staffOutboundInSpam?: number;
  q11?: Partial<Q11VolumeMetrics>;
}): CenturionTriageQualityDriver {
  const q11 = { ...goodQ11Volume(), ...overrides?.q11 };
  return {
    async getSpamSafetyCounts() {
      return {
        neverSpamInSpam: overrides?.neverSpamInSpam ?? 0,
        staffOutboundInSpam: overrides?.staffOutboundInSpam ?? 0,
      };
    },
    async getQ11VolumeMetrics() {
      return q11;
    },
  };
}

describe('audit CLI args', () => {
  it('requires summary/manifest/snapshot/key-prefix', () => {
    expect(() => parseAuditArgs([])).toThrow(/--summary|--manifest|--snapshot|--key-prefix/i);
    expect(
      parseAuditArgs([
        '--summary',
        's.json',
        '--manifest',
        'm.json',
        '--snapshot',
        'snap.json',
        '--key-prefix',
        KEY_PREFIX,
      ]),
    ).toMatchObject({
      summaryPath: 's.json',
      manifestPath: 'm.json',
      snapshotPath: 'snap.json',
      keyPrefix: KEY_PREFIX,
      quality: false,
    });
    expect(() =>
      parseAuditArgs([
        '--summary',
        's.json',
        '--manifest',
        'm.json',
        '--snapshot',
        'snap.json',
        '--key-prefix',
        KEY_PREFIX,
        '--bad',
      ]),
    ).toThrow(/unknown option/i);
  });

  it('accepts --quality and optional q11 volume override path', () => {
    expect(
      parseAuditArgs([
        '--summary',
        's.json',
        '--manifest',
        'm.json',
        '--snapshot',
        'snap.json',
        '--key-prefix',
        KEY_PREFIX,
        '--quality',
        '--q11-volume',
        'q11.json',
      ]),
    ).toMatchObject({
      quality: true,
      q11VolumePath: 'q11.json',
    });
  });
});

describe('strict centurion triage audit', () => {
  it('accepts exact coverage with succeeded full apply and matching durable labels', async () => {
    const { snapshot, manifest, applySummary, auditDriver } = await buildApprovedFixture();
    const result = await auditCenturionTriageRetag({
      driver: auditDriver,
      snapshot,
      manifest,
      applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts valid input-specific run prompt hash different from manifest hash', async () => {
    const inputSpecificPromptHash = sha('serialized user prompt/asOf');
    const fx = await buildApprovedFixture({
      mutateRun: (run) => {
        run.metrics = { ...run.metrics, promptHash: inputSpecificPromptHash };
      },
    });
    expect(inputSpecificPromptHash).not.toBe(fx.manifest.promptHash);

    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a run whose static prompt artifact hash is not bound to the manifest', async () => {
    const fx = await buildApprovedFixture({
      mutateRun: (run) => {
        run.promptHash = sha('different static artifact');
      },
    });
    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/prompt artifact|prompt hash.*manifest|bound/i);
  });

  it('rejects missing or invalid run prompt hashes', async () => {
    const cases: Array<(run: MemRun) => void> = [
      (run) => {
        run.promptHash = null;
        run.metrics = { ...run.metrics, promptHash: undefined };
      },
      (run) => {
        run.promptHash = 'not-a-sha256';
      },
      (run) => {
        run.promptHash = null;
        run.metrics = { ...run.metrics, promptHash: 'not-a-sha256' };
      },
    ];

    for (const mutateRun of cases) {
      const fx = await buildApprovedFixture({ mutateRun });
      const result = await auditCenturionTriageRetag({
        driver: fx.auditDriver,
        snapshot: fx.snapshot,
        manifest: fx.manifest,
        applySummary: fx.applySummary,
        keyPrefix: KEY_PREFIX,
      });

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(/prompt hash/i);
    }
  });

  it('rejects missing/extra/duplicate target coverage', async () => {
    // Missing: drop eligible target + valid rehash → coverage path (not stale manifestHash).
    const missing = await buildApprovedFixture({
      mutateManifest: (m) => rehashManifest({ ...m, targets: [] }),
    });
    const missingResult = await auditCenturionTriageRetag({
      driver: missing.auditDriver,
      snapshot: missing.snapshot,
      manifest: missing.manifest,
      applySummary: missing.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join('\n')).toMatch(/missing target coverage/i);
    expect(missingResult.errors.join('\n')).not.toMatch(/manifestHash mismatch/i);

    // Extra: non-eligible target + valid rehash → extra coverage path.
    const extra = await buildApprovedFixture({
      mutateManifest: (m) =>
        rehashManifest({
          ...m,
          targets: [
            ...m.targets,
            {
              threadId: 't-locked',
              triggerMessageId: 'm-locked',
              triggerHash: 'a'.repeat(64),
              preStateHash: 'a'.repeat(64),
              approvedCategory: 'bookings',
              approvedPrimaryFolder: 'bookings',
              approvedIsSpam: false,
              approvedUrgent: false,
              sourceHash: SOURCE_HASH,
              rehearsalResultHash: 'd'.repeat(64),
            },
          ],
        }),
    });
    const extraResult = await auditCenturionTriageRetag({
      driver: extra.auditDriver,
      snapshot: extra.snapshot,
      manifest: extra.manifest,
      applySummary: extra.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(extraResult.ok).toBe(false);
    expect(extraResult.errors.join('\n')).toMatch(/extra\/non-eligible target/i);
    expect(extraResult.errors.join('\n')).not.toMatch(/manifestHash mismatch/i);

    // True duplicate target threadId (validator + audit duplicate gate).
    const dup = await buildApprovedFixture({
      mutateManifest: (m) => ({
        ...m,
        targets: [...m.targets, { ...m.targets[0] }],
      }),
    });
    const dupResult = await auditCenturionTriageRetag({
      driver: dup.auditDriver,
      snapshot: dup.snapshot,
      manifest: dup.manifest,
      applySummary: dup.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(dupResult.ok).toBe(false);
    expect(dupResult.errors.join('\n')).toMatch(/duplicate target/i);
  });

  it('rejects missing or mismatched snapshot binding even after manifest rehash', async () => {
    const missing = await buildApprovedFixture({
      mutateManifest: (m) => rehashManifest({ ...m, snapshotHash: undefined }),
    });
    const missingResult = await auditCenturionTriageRetag({
      driver: missing.auditDriver,
      snapshot: missing.snapshot,
      manifest: missing.manifest,
      applySummary: { ...missing.applySummary, manifestHash: missing.manifest.manifestHash },
      keyPrefix: KEY_PREFIX,
    });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join('\n')).toMatch(/snapshotHash|snapshot.*bind/i);

    const mismatched = await buildApprovedFixture({
      mutateManifest: (m) => rehashManifest({ ...m, snapshotHash: 'f'.repeat(64) }),
    });
    const mismatchedResult = await auditCenturionTriageRetag({
      driver: mismatched.auditDriver,
      snapshot: mismatched.snapshot,
      manifest: mismatched.manifest,
      applySummary: {
        ...mismatched.applySummary,
        manifestHash: mismatched.manifest.manifestHash,
      },
      keyPrefix: KEY_PREFIX,
    });
    expect(mismatchedResult.ok).toBe(false);
    expect(mismatchedResult.errors.join('\n')).toMatch(/snapshotHash|snapshot.*bind/i);
  });

  it('rejects wrong trigger/pre-state hash', async () => {
    const fx = await buildApprovedFixture({
      mutateManifest: (m) => ({
        ...m,
        targets: m.targets.map((t: any) => ({
          ...t,
          triggerHash: 'f'.repeat(64),
          preStateHash: 'f'.repeat(64),
        })),
      }),
    });
    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/trigger|pre-state|preState|hash/i);
  });

  it('rejects wrong run state/version/key/model/prompt hash/input hash/apply mode', async () => {
    const cases: Array<(run: MemRun) => void> = [
      (r) => {
        r.state = 'failed';
      },
      (r) => {
        r.promptVersion = 'triage-v4';
      },
      (r) => {
        r.idempotencyKey = 'wrong-prefix:m-eligible';
      },
      (r) => {
        r.modelId = 'wrong-model';
      },
      (r) => {
        r.promptHash = 'not-a-sha256';
      },
      (r) => {
        r.metrics = { ...r.metrics, inputHash: '0'.repeat(64) };
      },
      (r) => {
        r.metrics = { ...r.metrics, applyMode: 'urgency_only' };
      },
    ];
    for (const mutate of cases) {
      const fx = await buildApprovedFixture({ mutateRun: mutate });
      const result = await auditCenturionTriageRetag({
        driver: fx.auditDriver,
        snapshot: fx.snapshot,
        manifest: fx.manifest,
        applySummary: fx.applySummary,
        keyPrefix: KEY_PREFIX,
      });
      expect(result.ok, `expected fail for ${JSON.stringify(fx.runs[0])}`).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects approved-output mismatch and durable category/urgent/spam mismatch', async () => {
    const approved = await buildApprovedFixture({
      mutateRun: (r) => {
        r.metrics = { ...r.metrics, category: 'ops', urgent: false };
      },
    });
    const approvedResult = await auditCenturionTriageRetag({
      driver: approved.auditDriver,
      snapshot: approved.snapshot,
      manifest: approved.manifest,
      applySummary: approved.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(approvedResult.ok).toBe(false);
    expect(approvedResult.errors.join('\n')).toMatch(/approved|category|urgent/i);

    const durable = await buildApprovedFixture({
      mutateLiveAfterSnapshot: (threads) => {
        threads.get('t-eligible')!.aiCategorySlugs = ['ops'];
      },
    });
    const durableResult = await auditCenturionTriageRetag({
      driver: durable.auditDriver,
      snapshot: durable.snapshot,
      manifest: durable.manifest,
      applySummary: durable.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(durableResult.ok).toBe(false);
    expect(durableResult.errors.join('\n')).toMatch(/durable|category|label/i);
  });

  it('rejects unexpected draft', async () => {
    const fx = await buildApprovedFixture({
      mutateRun: (r) => {
        r.metrics = { ...r.metrics, draftRunId: 'draft-run-1' };
      },
    });
    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/draft/i);
  });

  it('rejects excluded cohort state drift vs snapshot and fresh-prefix runs', async () => {
    const threads = new Map(
      baseThreads().map((t) => [
        t.threadId,
        {
          ...t,
          aiCategorySlugs: [...t.aiCategorySlugs],
          customCategorySlugs: [...t.customCategorySlugs],
        },
      ]),
    );
    const preferences = new Map<string, PrefKind>([
      ['spam@bad.com', 'block'],
      ['vip@partner.com', 'allow'],
    ]);
    const snapshotDriver = {
      async listThreads() {
        return [...threads.values()].map((t) => ({
          ...t,
          aiCategorySlugs: [...t.aiCategorySlugs],
          customCategorySlugs: [...t.customCategorySlugs],
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
    };
    const snapshot = await buildCenturionTriageSnapshot({
      driver: snapshotDriver,
      generatedAt: '2026-07-30T12:00:00.000Z',
    });
    let manifest = emitTargetManifestFromSnapshot(snapshot, {
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
    });
    manifest = bindApprovedTargetManifest(manifest, {
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

    // Post-cutover: eligible labels match approved; mutate locked (excluded).
    threads.get('t-eligible')!.aiCategorySlugs = ['groups-events', 'urgent'];
    threads.get('t-eligible')!.spamAt = null;
    threads.get('t-locked')!.aiCategorySlugs = ['ops'];

    const inputHash = 'e'.repeat(64);
    const runs: MemRun[] = [
      {
        id: 'run-1',
        threadId: 't-eligible',
        triggerMessageId: 'm-eligible',
        idempotencyKey: `${KEY_PREFIX}:m-eligible`,
        modelId: MODEL_ID,
        promptVersion: PROMPT_VERSION,
        promptHash: PROMPT_HASH,
        state: 'succeeded',
        createdAt: '2026-07-30T12:59:00.000Z',
        finishedAt: '2026-07-30T13:00:00.000Z',
        metrics: {
          category: 'groups-events',
          urgent: true,
          applyMode: 'full',
          inputHash,
          promptHash: PROMPT_HASH,
        },
      },
    ];

    const auditDriver = {
      async listRunsByPrefix(prefix: string) {
        return runs.filter((r) => r.idempotencyKey.startsWith(prefix));
      },
      async recomputeProductionInputHash() {
        return inputHash;
      },
      async listDurableAiState(threadId: string) {
        const t = threads.get(threadId)!;
        return {
          spamAt: t.spamAt,
          spamUserLockedAt: t.spamUserLockedAt,
          aiCategorySlugs: [...t.aiCategorySlugs],
        };
      },
      async listThreadState(threadId: string) {
        return this.listDurableAiState(threadId);
      },
    };

    const drift = await auditCenturionTriageRetag({
      driver: auditDriver,
      snapshot,
      manifest,
      applySummary: {
        mode: 'apply',
        inserted: 1,
        mutated: 1,
        collisions: 0,
        keyPrefix: KEY_PREFIX,
        manifestHash: manifest.manifestHash,
      },
      keyPrefix: KEY_PREFIX,
    });
    expect(drift.ok).toBe(false);
    expect(drift.errors.join('\n')).toMatch(/excluded|locked|mutation|drift/i);

    // restore locked; add forbidden fresh-prefix run on blocked
    threads.get('t-locked')!.aiCategorySlugs = ['at-risk'];
    runs.push({
      id: 'run-bad',
      threadId: 't-blocked',
      triggerMessageId: 'm-blocked',
      idempotencyKey: `${KEY_PREFIX}:m-blocked`,
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
      state: 'succeeded',
      createdAt: '2026-07-30T12:59:00.000Z',
      finishedAt: '2026-07-30T13:00:00.000Z',
      metrics: { category: 'ops', urgent: false, applyMode: 'full', inputHash },
    });
    const forbidden = await auditCenturionTriageRetag({
      driver: auditDriver,
      snapshot,
      manifest,
      applySummary: {
        mode: 'apply',
        inserted: 1,
        mutated: 1,
        collisions: 0,
        keyPrefix: KEY_PREFIX,
        manifestHash: manifest.manifestHash,
      },
      keyPrefix: KEY_PREFIX,
    });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.errors.join('\n')).toMatch(/excluded|unexpected|fresh|prefix/i);
  });

  it('ignores pre-existing spam category joins when auditing excluded state', async () => {
    const fx = await buildApprovedFixture({
      mutateLiveAfterSnapshot: (threads) => {
        // Snapshot deliberately excludes spam joins; audit must not treat this
        // pre-existing join as a retag mutation on an excluded thread.
        threads.get('t-locked')!.aiCategorySlugs.push('spam');
      },
    });
    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(true);
  });

  it('does not compare production input hash to regression hash; uses run-time recompute', async () => {
    const fx = await buildApprovedFixture();
    let seenAsOf: string | null = null;
    const driver = {
      ...fx.auditDriver,
      async recomputeProductionInputHash(input: {
        threadId: string;
        triggerMessageId: string;
        modelId: string;
        promptVersion: string;
        asOf: string;
      }) {
        seenAsOf = input.asOf;
        // Worker asOf is run.createdAt, not finishedAt.
        expect(input.asOf).toBe('2026-07-30T12:59:00.000Z');
        return fx.inputHash;
      },
    };
    const result = await auditCenturionTriageRetag({
      driver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
      // regression hash must be ignored if provided
      regressionInputHashByThread: { 't-eligible': sha('regression-different') },
    });
    expect(result.ok).toBe(true);
    expect(seenAsOf).toBe('2026-07-30T12:59:00.000Z');
  });

  it('accepts spam-approved targets via spam_at without spam category slug', async () => {
    const fx = await buildApprovedFixture({
      mutateLiveAfterSnapshot: (threads) => {
        const eligible = threads.get('t-eligible')!;
        eligible.aiCategorySlugs = [];
        eligible.spamAt = '2026-07-30T13:00:00.000Z';
      },
    });
    fx.runs[0].metrics = {
      ...fx.runs[0].metrics,
      category: 'spam',
      urgent: false,
    };
    const manifest = rehashManifest({
      ...fx.manifest,
      targets: fx.manifest.targets.map((t: Record<string, unknown>) => ({
        ...t,
        approvedCategory: 'spam',
        approvedPrimaryFolder: 'spam',
        approvedIsSpam: true,
        approvedUrgent: false,
      })),
    });

    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest,
      applySummary: {
        ...fx.applySummary,
        manifestHash: (manifest as { manifestHash: string }).manifestHash,
      },
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(true);
  });

  it('matches durable worker contract for spam plus urgent output', async () => {
    const fx = await buildApprovedFixture({
      mutateManifest: (m) =>
        rehashManifest({
          ...m,
          targets: m.targets.map((t: Record<string, unknown>) => ({
            ...t,
            approvedCategory: 'spam',
            approvedPrimaryFolder: 'spam',
            approvedIsSpam: true,
            approvedUrgent: true,
          })),
        }),
      mutateRun: (run) => {
        run.metrics = {
          inputHash: run.metrics.inputHash,
          applyMode: 'full',
          canonicalOutput: {
            primaryFolder: 'bookings',
            urgent: true,
            isSpam: true,
          },
        };
      },
      mutateLiveAfterSnapshot: (threads) => {
        threads.get('t-eligible')!.aiCategorySlugs = [];
        threads.get('t-eligible')!.spamAt = '2026-07-30T13:00:00.000Z';
      },
    });
    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(true);
  });

  it('requires approvedUrgent boolean for every target', async () => {
    const fx = await buildApprovedFixture({
      mutateManifest: (m) =>
        rehashManifest({
          ...m,
          targets: m.targets.map((t: Record<string, unknown>) => {
            const { approvedUrgent: _ignored, ...withoutUrgent } = t;
            return withoutUrgent;
          }),
        }),
    });
    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/approved urgent|urgent required/i);
  });

  it('audits canonical v6 output: spam has no primary; non-spam uses workflow primary', async () => {
    const fx = await buildApprovedFixture({
      mutateManifest: (m) =>
        rehashManifest({
          ...m,
          targets: m.targets.map((t: Record<string, unknown>) => ({
            ...t,
            approvedPrimaryFolder: 'bookings',
            approvedIsSpam: false,
            approvedCategory: undefined,
            approvedUrgent: false,
          })),
        }),
      mutateRun: (run) => {
        run.metrics = {
          inputHash: run.metrics.inputHash,
          applyMode: 'full',
          canonicalOutput: {
            primaryFolder: 'bookings',
            urgent: false,
            isSpam: false,
          },
        };
      },
    });
    fx.threads.get('t-eligible')!.aiCategorySlugs = ['bookings'];
    fx.threads.get('t-eligible')!.spamAt = null;

    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(result.ok).toBe(true);

    const spam = await buildApprovedFixture({
      mutateManifest: (m) =>
        rehashManifest({
          ...m,
          targets: m.targets.map((t: Record<string, unknown>) => ({
            ...t,
            approvedCategory: 'spam',
            approvedPrimaryFolder: 'spam',
            approvedIsSpam: true,
            approvedUrgent: false,
          })),
        }),
      mutateRun: (run) => {
        run.metrics = {
          inputHash: run.metrics.inputHash,
          applyMode: 'full',
          canonicalOutput: {
            primaryFolder: 'bookings',
            urgent: false,
            isSpam: true,
          },
        };
      },
      mutateLiveAfterSnapshot: (threads) => {
        threads.get('t-eligible')!.aiCategorySlugs = [];
        threads.get('t-eligible')!.spamAt = '2026-07-30T13:00:00.000Z';
      },
    });
    const spamResult = await auditCenturionTriageRetag({
      driver: spam.auditDriver,
      snapshot: spam.snapshot,
      manifest: spam.manifest,
      applySummary: spam.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(spamResult.ok).toBe(true);

    spam.threads.get('t-eligible')!.aiCategorySlugs = ['spam'];
    const spamJoinResult = await auditCenturionTriageRetag({
      driver: spam.auditDriver,
      snapshot: spam.snapshot,
      manifest: spam.manifest,
      applySummary: spam.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(spamJoinResult.ok).toBe(false);
    expect(spamJoinResult.errors.join('\n')).toMatch(/primary|category/i);
  });

  it('loads spam joins into durable audit state instead of hiding them as non-managed', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join: pathJoin } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      pathJoin(
        dirname(fileURLToPath(import.meta.url)),
        '../scripts/audit-centurion-triage-retag.mjs',
      ),
      'utf8',
    );
    expect(src).toMatch(/RETAG_UNSETTLE_SLUGS,\s*'spam'/);
  });

  it('hashes canonical recipients and thread signals, including address-sensitive changes', () => {
    const base = {
      transportId: 'transport-centurion',
      threadId: 't-hash',
      triggerMessageId: 'm-hash',
      asOf: '2026-07-30T12:59:00.000Z',
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      messages: [
        {
          id: 'm-hash',
          from: 'guest@example.com',
          subject: 'Booking',
          body: 'Please confirm.',
          direction: 'inbound',
          createdAt: new Date('2026-07-30T12:58:00.000Z'),
          receivedAt: new Date('2026-07-30T12:58:00.000Z'),
          sentAt: null,
          to: ['Staff@Example.com'],
          cc: [],
          bcc: [],
        },
      ],
      threadSignals: { legacyHotelsOutboundResponse: false },
    };

    const reorderedAddress = {
      ...base,
      messages: [{ ...base.messages[0], to: ['staff@example.com'] }],
    };
    const changedAddress = {
      ...base,
      messages: [{ ...base.messages[0], to: ['other@example.com'] }],
    };
    const changedSignal = {
      ...base,
      threadSignals: { legacyHotelsOutboundResponse: true },
    };

    expect(hashProductionTriageInput(base)).toBe(hashProductionTriageInput(reorderedAddress));
    expect(hashProductionTriageInput(changedAddress)).not.toBe(hashProductionTriageInput(base));
    expect(hashProductionTriageInput(changedSignal)).not.toBe(hashProductionTriageInput(base));
  });

  it('recomputes production hashes from recipient columns and the causal signal window', async () => {
    const queries: string[] = [];
    const messages = [
      {
        id: 'm-later',
        from: 'agent@legacyhotels.co.za',
        subject: 'Later reply',
        body: 'Later reply',
        direction: 'outbound',
        createdAt: new Date('2026-07-30T13:00:00.000Z'),
        receivedAt: null,
        sentAt: new Date('2026-07-30T13:00:00.000Z'),
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
      },
      {
        id: 'm-trigger',
        from: 'guest@example.com',
        subject: 'Booking',
        body: 'Please confirm.',
        direction: 'inbound',
        createdAt: new Date('2026-07-30T12:00:00.000Z'),
        receivedAt: new Date('2026-07-30T12:00:00.000Z'),
        sentAt: null,
        to: ['Staff@Example.com'],
        cc: [],
        bcc: [],
      },
      {
        id: 'm-rc',
        from: 'pmbobo@eu.mail.reservecloud.com',
        subject: 'Staff reply',
        body: 'Staff reply',
        direction: 'outbound',
        createdAt: new Date('2026-07-30T11:00:00.000Z'),
        receivedAt: null,
        sentAt: new Date('2026-07-30T11:00:00.000Z'),
        to: ['pmbobo@legacyhotels.co.za'],
        cc: ['Staff@Example.com'],
        bcc: [],
      },
    ];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = Array.from(strings).join(' ');
      queries.push(statement);
      if (/FROM message/i.test(statement)) return messages;
      throw new Error(`unexpected SQL in driver test: ${statement}`);
    }) as unknown as Parameters<typeof createPostgresAuditDriver>[0];

    const driver = createPostgresAuditDriver(sql);
    const actual = await driver.recomputeProductionInputHash({
      threadId: 't-driver',
      triggerMessageId: 'm-trigger',
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      asOf: '2026-07-30T12:59:00.000Z',
    });
    const expected = hashProductionTriageInput({
      transportId: 'transport-centurion',
      threadId: 't-driver',
      triggerMessageId: 'm-trigger',
      asOf: '2026-07-30T12:59:00.000Z',
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      messages: [messages[2], messages[1]],
      threadSignals: {
        legacyHotelsOutboundResponse: false,
        reserveCloudStaffOutbound: true,
        reserveCloudStaffOutboundFrom: 'pmbobo@eu.mail.reservecloud.com',
        reserveCloudStaffOutboundRecipients: [
          'pmbobo@legacyhotels.co.za',
          'staff@example.com',
        ],
      },
    });

    expect(actual).toBe(expected);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/to_addresses AS "to"/);
    expect(queries[0]).toMatch(/cc_addresses AS "cc"/);
    expect(queries[0]).toMatch(/bcc_addresses AS "bcc"/);
  });

  it('derives durable expected primary from the worker exception remap', () => {
    const target = { approvedPrimaryFolder: 'bookings', approvedIsSpam: false, approvedUrgent: false };
    const canonical = true;

    expect(
      effectiveDurableDecision(target, {}, { latestSender: 'staff@legacyhotels.co.za' }, canonical)
        .primaryFolder,
    ).toBe('internal-partner');
    expect(
      effectiveDurableDecision(
        target,
        {},
        { latestSender: 'pmbobo@eu.mail.reservecloud.com' },
        canonical,
      ).primaryFolder,
    ).toBe('internal-partner');
    expect(
      effectiveDurableDecision(
        { ...target, approvedPrimaryFolder: 'groups-events' },
        {},
        { latestSender: 'pmbobo@eu.mail.reservecloud.com' },
        canonical,
      ).primaryFolder,
    ).toBe('groups-events');
    expect(
      effectiveDurableDecision(
        target,
        {},
        { latestSender: 'aroransh17@gmail.com' },
        canonical,
      ).primaryFolder,
    ).toBe('bookings');
    expect(
      effectiveDurableDecision(
        { ...target, approvedPrimaryFolder: 'automated-channel' },
        { threadSignals: { legacyHotelsOutboundResponse: true } },
        { latestSender: 'guest@example.com' },
        canonical,
      ).primaryFolder,
    ).toBe('internal-partner');
    expect(
      effectiveDurableDecision(
        { ...target, approvedPrimaryFolder: 'unknown-review' },
        {
          threadSignals: {
            reserveCloudStaffOutbound: true,
            reserveCloudStaffOutboundFrom: 'pmbobo@eu.mail.reservecloud.com',
            reserveCloudStaffOutboundRecipients:
              'pmbobo@legacyhotels.co.za, staff@example.com',
          },
        },
        { latestSender: 'guest@example.com' },
        canonical,
      ).primaryFolder,
    ).toBe('internal-partner');
  });

  it('audits durable state against the worker exception remap', async () => {
    const fx = await buildApprovedFixture({
      latestInboundFrom: 'staff@legacyhotels.co.za',
      mutateManifest: (m) =>
        rehashManifest({
          ...m,
          targets: m.targets.map((target: Record<string, unknown>) => ({
            ...target,
            approvedCategory: undefined,
            approvedPrimaryFolder: 'groups-events',
            approvedIsSpam: false,
            approvedUrgent: false,
          })),
        }),
      mutateRun: (run) => {
        run.metrics = {
          inputHash: run.metrics.inputHash,
          applyMode: 'full',
          canonicalOutput: {
            primaryFolder: 'groups-events',
            urgent: false,
            isSpam: false,
          },
        };
      },
      mutateLiveAfterSnapshot: (threads) => {
        threads.get('t-eligible')!.aiCategorySlugs = ['internal-partner'];
      },
    });

    const result = await auditCenturionTriageRetag({
      driver: fx.auditDriver,
      snapshot: fx.snapshot,
      manifest: fx.manifest,
      applySummary: fx.applySummary,
      keyPrefix: KEY_PREFIX,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('centurion triage quality --quality floors', () => {
  it('loads gold fixture with min-N cohort floors', () => {
    const gold = loadCenturionTriageQualityGoldFixture(goldFixturePath);
    expect(gold.cohorts.automate.length).toBeGreaterThanOrEqual(25);
    expect(gold.cohorts.promoSpam.length).toBeGreaterThanOrEqual(25);
    expect(gold.cohorts.fortimailDigest.length).toBeGreaterThanOrEqual(10);
    expect(gold.cohorts.neverSpamNegatives.length).toBeGreaterThanOrEqual(15);
  });

  it('meets automate and spam recall floors on gold re-refine', () => {
    const gold = loadCenturionTriageQualityGoldFixture(goldFixturePath);
    const automate = evaluateGoldAutomateRecall(gold);
    const spam = evaluateGoldSpamRecall(gold);
    expect(automate.recall).toBeGreaterThanOrEqual(QUALITY_AUTOMATE_RECALL_FLOOR);
    expect(spam.recall).toBeGreaterThanOrEqual(QUALITY_SPAM_RECALL_FLOOR);
  });

  it('has zero spam-fp-v6 protected regressions after shared refine', () => {
    const { regressions } = evaluateSpamFpV6Refine();
    expect(regressions).toBe(0);
  });

  it('passes quality audit with good driver metrics', async () => {
    const result = await auditCenturionTriageQuality({
      driver: qualityDriver(),
      goldFixturePath: goldFixturePath,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.metrics.automateRecall).toBeGreaterThanOrEqual(QUALITY_AUTOMATE_RECALL_FLOOR);
    expect(result.metrics.spamRecall).toBeGreaterThanOrEqual(QUALITY_SPAM_RECALL_FLOOR);
    expect(result.metrics.spamFpV6Regressions).toBe(0);
    expect(result.metrics.neverSpamInSpam).toBe(0);
    expect(result.metrics.staffOutboundInSpam).toBe(0);
  });

  it('fails closed when automate recall would drop below floor', async () => {
    const gold = loadCenturionTriageQualityGoldFixture(goldFixturePath);
    const broken = {
      ...gold,
      cohorts: {
        ...gold.cohorts,
        automate: gold.cohorts.automate.map((entry, index) =>
          index < 6
            ? {
                ...entry,
                subject: 'Guest reply required within 12 hours unpaid balance',
                bodySnippet: 'Please reply within 12 hours. Unpaid arrival tomorrow.',
              }
            : entry,
        ),
      },
    };
    const automate = evaluateGoldAutomateRecall(broken);
    expect(automate.recall).toBeLessThan(QUALITY_AUTOMATE_RECALL_FLOOR);

    const result = await auditCenturionTriageQuality({
      driver: qualityDriver(),
      goldFixture: broken,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/automate recall/i);
  });

  it('fails closed on neverSpamInSpam, staffOutboundInSpam, and Q11 volume', async () => {
    const never = await auditCenturionTriageQuality({
      driver: qualityDriver({ neverSpamInSpam: 1 }),
      goldFixturePath: goldFixturePath,
    });
    expect(never.ok).toBe(false);
    expect(never.errors.join('\n')).toMatch(/neverSpamInSpam/i);

    const staff = await auditCenturionTriageQuality({
      driver: qualityDriver({ staffOutboundInSpam: 2 }),
      goldFixturePath: goldFixturePath,
    });
    expect(staff.ok).toBe(false);
    expect(staff.errors.join('\n')).toMatch(/staffOutboundInSpam/i);

    const q11Fail = evaluateQ11VolumeBand({
      automateThreads: 0,
      spamThreads: 4,
      unanswered: 999,
      responded: 999,
      actionable: 999,
    });
    expect(q11Fail.ok).toBe(false);
    expect(q11Fail.errors.join('\n')).toMatch(/automate volume|spam volume|WINDOW band/i);

    const q11Audit = await auditCenturionTriageQuality({
      driver: qualityDriver({
        q11: {
          automateThreads: 0,
          spamThreads: 4,
          unanswered: 999,
          responded: 999,
          actionable: 999,
        },
      }),
      goldFixturePath: goldFixturePath,
    });
    expect(q11Audit.ok).toBe(false);
    expect(q11Audit.errors.join('\n')).toMatch(/Q11/i);
  });

  it('documents ops sequence in audit script help comment', () => {
    const src = readFileSync(
      join(here, '../scripts/audit-centurion-triage-retag.mjs'),
      'utf8',
    );
    expect(src).toMatch(/quiesce.*snapshot.*KEY_PREFIX.*dry-run retag.*restore drill/s);
    expect(src).toMatch(/quality\+Q11 audit/);
    expect(src).toMatch(/live spot-check Automate\/Spam\/Quarantine\/Urgent/);
  });
});
