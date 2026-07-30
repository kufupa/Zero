import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  auditCenturionTriageRetag,
  parseAuditArgs,
} from '../scripts/audit-centurion-triage-retag.mjs';
import {
  bindApprovedTargetManifest,
  buildCenturionTriageSnapshot,
  emitTargetManifestFromSnapshot,
} from '../scripts/snapshot-centurion-triage.mjs';

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
  mutateLiveAfterSnapshot?: (threads: Map<string, MemThread>) => void;
  mutateRun?: (run: MemRun) => void;
  mutateManifest?: (manifest: any) => any;
  extraRun?: MemRun;
  applySummary?: Record<string, unknown>;
  skipPostApplyMutation?: boolean;
}) {
  const threads = new Map(
    preCutoverThreads().map((t) => [
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

  it('rejects missing/extra/duplicate target coverage', async () => {
    const missing = await buildApprovedFixture({
      mutateManifest: (m) => {
        const next = {
          ...m,
          targets: [
            ...m.targets,
            {
              ...m.targets[0],
              threadId: 't-missing',
              triggerMessageId: 'm-missing',
              triggerHash: 'a'.repeat(64),
              preStateHash: 'a'.repeat(64),
            },
          ],
        };
        // leave hash stale → also hash fail; recompute via bind helper path in audit
        return next;
      },
    });
    const missingResult = await auditCenturionTriageRetag({
      driver: missing.auditDriver,
      snapshot: missing.snapshot,
      manifest: missing.manifest,
      applySummary: missing.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join('\n')).toMatch(/missing|coverage|manifestHash|duplicate|extra/i);

    const extraRun = await buildApprovedFixture({
      extraRun: {
        id: 'run-extra',
        threadId: 't-locked',
        triggerMessageId: 'm-locked',
        idempotencyKey: `${KEY_PREFIX}:m-locked`,
        modelId: MODEL_ID,
        promptVersion: PROMPT_VERSION,
        promptHash: PROMPT_HASH,
        state: 'succeeded',
        finishedAt: '2026-07-30T13:00:00.000Z',
        metrics: { category: 'ops', urgent: false, applyMode: 'full', inputHash: 'e'.repeat(64) },
      },
    });
    const extraResult = await auditCenturionTriageRetag({
      driver: extraRun.auditDriver,
      snapshot: extraRun.snapshot,
      manifest: extraRun.manifest,
      applySummary: extraRun.applySummary,
      keyPrefix: KEY_PREFIX,
    });
    expect(extraResult.ok).toBe(false);
    expect(extraResult.errors.join('\n')).toMatch(/extra|excluded|unexpected/i);
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
        r.promptHash = 'a'.repeat(64);
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
        expect(input.asOf).toBe('2026-07-30T13:00:00.000Z');
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
    expect(seenAsOf).toBe('2026-07-30T13:00:00.000Z');
  });
});
