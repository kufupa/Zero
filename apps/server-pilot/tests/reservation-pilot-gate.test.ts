import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Outcome =
  | 'match'
  | 'mismatch'
  | 'changed_state'
  | 'ambiguous'
  | 'unscorable'
  | 'denied'
  | 'missing_capability';

type PilotCase = {
  id: string;
  conversationId: string;
  evaluationMode: 'current-state' | 'historical-replay' | 'future-shadow';
  split: 'development' | 'holdout';
  selectionStatus: 'runnable' | 'not-runnable' | 'unscorable';
  skipReason?: string;
  toolInput: Record<string, unknown>;
  expectedFacts: Record<string, unknown>;
  fieldOutcomes: Record<string, Outcome>;
  rejectedOperations: string[];
  exposure?: {
    sealedBeforeOutcome: boolean;
    outcomeMayInformTuning: boolean;
    outcomeMayInformRepair: boolean;
    outcomeMayChooseFixtures: boolean;
    outcomeMayTriggerRetry: boolean;
    state: 'sealed' | 'unsealed-retired';
    originalScorePreserved?: boolean;
    originalExposurePreserved?: boolean;
  };
};

type PilotManifest = {
  schemaVersion: string;
  fixtureKind: 'synthetic';
  publicFixture: true;
  source: {
    name: string;
    version: string;
    contentHash: string;
    mappingHash: string;
  };
  counts: {
    selectedRecords: number;
    externalOrMixedCandidates: number;
    strictExternalOutboundCandidates: number;
    eligibleGoldCases: number;
  };
  privacy: {
    rawCorpusIncluded: false;
    privatePaths: string[];
    targetReplyInToolInput: false;
    targetReplyInFixture: false;
  };
  phase2B: {
    selectionHash: string;
    mappingHash: string;
    membershipFrozenBeforeResults: true;
    caseIdentifiersFrozenBeforeResults: true;
    evaluationModeFrozenBeforeResults: true;
    selectionReasonsFrozenBeforeResults: true;
    conversationSplitFrozen: true;
    splitUnit: 'conversation';
    goldTargetExposure: 'evaluator-only';
    modeSpecificAggregation: true;
    allowedOutcomes: Outcome[];
    blockedPassOutcomes: Outcome[];
  };
  cases: PilotCase[];
  laterInboundFirstHoldout: {
    targetEpisodes: number;
    independentOfReplyExistence: true;
    excludesTargetAndFutureContext: true;
    includesNoReplyEpisode: true;
  };
  browserSafety: {
    allowedOrigins: string[];
    externalSocketsAllowed: false;
    transport: 'fake';
    prohibitedEffects: string[];
  };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'reservation-tools-pilot.json');
const gatePath = path.join(here, '..', 'scripts', 'reservation-pilot-gate.sh');

function readManifest(): PilotManifest {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PilotManifest;
}

async function loadGateLib() {
  return import('../scripts/reservation-pilot-gate-lib.mjs');
}

function runGate(mode: string, slice: string, overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) delete env[key];
  }
  return spawnSync('bash', [gatePath, mode, slice], {
    cwd: path.join(here, '..', '..', '..'),
    env,
    encoding: 'utf8',
  });
}

describe('reservation pilot synthetic fixture [gate-selftest]', () => {
  it('pins synthetic source/hash versions and exact bounded counts', () => {
    const manifest = readManifest();

    expect(manifest.fixtureKind).toBe('synthetic');
    expect(manifest.publicFixture).toBe(true);
    expect(manifest.source.version).toBe('reservation-tools-pilot.v1');
    expect(manifest.source.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.source.mappingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.counts).toEqual({
      selectedRecords: 420,
      externalOrMixedCandidates: 253,
      strictExternalOutboundCandidates: 251,
      eligibleGoldCases: 0,
    });
  });

  it('covers traffic/cohort/T0, reservation, document, finance and browser safety facts', () => {
    const manifest = readManifest();
    const ids = new Set(manifest.cases.map((pilotCase) => pilotCase.id));

    expect(ids).toEqual(
      new Set([
        'traffic-cohort-t0',
        'ambiguous-reservation',
        'partial-read',
        'wrong-document',
        'folio-deposit-difference',
        'prohibited-browser-effects',
        'future-shadow-negation',
        'zero-label-unscorable',
      ]),
    );
    expect(manifest.browserSafety.externalSocketsAllowed).toBe(false);
    expect(manifest.browserSafety.transport).toBe('fake');
    expect(manifest.browserSafety.allowedOrigins).toEqual(['http://127.0.0.1:4179']);
    expect(manifest.browserSafety.prohibitedEffects).toEqual(
      expect.arrayContaining(['create', 'amend', 'cancel', 'payment', 'send', 'folder-mutation']),
    );

    const traffic = manifest.cases.find((pilotCase) => pilotCase.id === 'traffic-cohort-t0');
    expect(traffic?.expectedFacts).toMatchObject({
      inboundCount: 3,
      knownZeroPostT0Day: '2026-09-04',
      t0: '2026-09-01T00:00:00.000Z',
    });
    expect(traffic?.fieldOutcomes).toMatchObject({ responseClock: 'unscorable' });
  });
});

describe('reservation pilot Phase 2/B contract [gate-selftest]', () => {
  it('freezes membership by conversation before outcomes and keeps gold evaluator-only', () => {
    const manifest = readManifest();

    expect(manifest.phase2B.membershipFrozenBeforeResults).toBe(true);
    expect(manifest.phase2B.selectionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.phase2B.modeSpecificAggregation).toBe(true);
    expect(manifest.phase2B.caseIdentifiersFrozenBeforeResults).toBe(true);
    expect(manifest.phase2B.evaluationModeFrozenBeforeResults).toBe(true);
    expect(manifest.phase2B.selectionReasonsFrozenBeforeResults).toBe(true);
    expect(manifest.phase2B.conversationSplitFrozen).toBe(true);
    expect(manifest.phase2B.splitUnit).toBe('conversation');
    expect(manifest.phase2B.goldTargetExposure).toBe('evaluator-only');
    expect(manifest.privacy.targetReplyInToolInput).toBe(false);
    expect(manifest.privacy.targetReplyInFixture).toBe(false);
    expect(manifest.privacy.privatePaths).toEqual([]);
    expect(manifest.source.mappingHash).toBe(manifest.phase2B.mappingHash);
    expect(manifest.counts.eligibleGoldCases).not.toBe(manifest.counts.selectedRecords);

    const splitByConversation = new Map<string, string>();
    for (const pilotCase of manifest.cases) {
      const previous = splitByConversation.get(pilotCase.conversationId);
      if (previous) expect(pilotCase.split).toBe(previous);
      splitByConversation.set(pilotCase.conversationId, pilotCase.split);
      expect(pilotCase.toolInput).not.toHaveProperty('gold');
      expect(pilotCase.toolInput).not.toHaveProperty('targetReply');
      expect(pilotCase.toolInput).not.toHaveProperty('humanOutbound');
      expect(Object.keys(pilotCase.expectedFacts)).not.toHaveLength(0);
      expect(pilotCase.rejectedOperations.length).toBeGreaterThan(0);
    }
  });

  it('records explicit not-runnable/unscorable reasons and mode-specific outcomes', () => {
    const manifest = readManifest();
    const allowed = new Set(manifest.phase2B.allowedOutcomes);
    const blockedPasses = new Set(manifest.phase2B.blockedPassOutcomes);
    const observedOutcomes = new Set(
      manifest.cases.flatMap((pilotCase) => Object.values(pilotCase.fieldOutcomes)),
    );

    expect(manifest.phase2B.allowedOutcomes).toEqual(
      expect.arrayContaining([
        'match',
        'mismatch',
        'changed_state',
        'ambiguous',
        'unscorable',
        'denied',
        'missing_capability',
      ]),
    );
    expect(manifest.phase2B.blockedPassOutcomes).toEqual(
      expect.arrayContaining([
        'changed_state',
        'unscorable',
        'ambiguous',
        'denied',
        'missing_capability',
      ]),
    );
    expect([...blockedPasses].sort()).toEqual(
      ['ambiguous', 'changed_state', 'denied', 'missing_capability', 'unscorable'].sort(),
    );
    expect(blockedPasses.has('match')).toBe(false);
    for (const blockedOutcome of blockedPasses) {
      expect(observedOutcomes.has(blockedOutcome)).toBe(true);
    }

    const explicitSkipped = manifest.cases.filter(
      (pilotCase) => pilotCase.selectionStatus !== 'runnable',
    );
    expect(explicitSkipped.length).toBeGreaterThanOrEqual(2);
    for (const pilotCase of explicitSkipped) {
      expect(pilotCase.skipReason).toEqual(expect.any(String));
      expect(pilotCase.skipReason).not.toBe('');
    }
    for (const pilotCase of manifest.cases) {
      for (const outcome of Object.values(pilotCase.fieldOutcomes)) {
        expect(allowed.has(outcome)).toBe(true);
      }
      expect(pilotCase.evaluationMode).toBeDefined();
    }
  });

  it('isolates held-out outcomes and retires an unsealed case without losing exposure', () => {
    const manifest = readManifest();
    const holdout = manifest.cases.filter((pilotCase) => pilotCase.split === 'holdout');
    expect(holdout.length).toBeGreaterThanOrEqual(2);
    for (const pilotCase of holdout) {
      expect(pilotCase.exposure).toMatchObject({
        sealedBeforeOutcome: true,
        outcomeMayInformTuning: false,
        outcomeMayInformRepair: false,
        outcomeMayChooseFixtures: false,
        outcomeMayTriggerRetry: false,
      });
    }

    const retired = manifest.cases.find(
      (pilotCase) => pilotCase.exposure?.state === 'unsealed-retired',
    );
    expect(retired?.exposure).toMatchObject({
      originalScorePreserved: true,
      originalExposurePreserved: true,
    });
    expect(retired?.split).toBe('development');
  });

  it('samples the later inbound-first holdout independently of reply existence', () => {
    const manifest = readManifest();
    expect(manifest.laterInboundFirstHoldout).toEqual({
      targetEpisodes: 200,
      independentOfReplyExistence: true,
      excludesTargetAndFutureContext: true,
      includesNoReplyEpisode: true,
    });
  });
});

describe('reservation pilot runtime validators', () => {
  it('binds the manifest to deterministic canonical digests and validates the contract', async () => {
    const gate = await loadGateLib();
    const manifest = readManifest();

    expect(() => gate.assertManifestContract(manifest)).not.toThrow();
    expect(gate.computeManifestDigests(manifest)).toEqual({
      contentHash: manifest.source.contentHash,
      mappingHash: manifest.source.mappingHash,
      selectionHash: manifest.phase2B.selectionHash,
    });
  });

  it('enforces mode/split isolation and a real holdout unseal transition', async () => {
    const gate = await loadGateLib();
    const session = gate.createEvaluationSession(readManifest());

    expect(() => session.aggregate('future-shadow', 'holdout')).toThrow(/holdout/i);
    expect(session.canUse('prohibited-browser-effects', 'tune')).toBe(false);
    expect(session.canUse('prohibited-browser-effects', 'repair')).toBe(false);
    expect(session.canUse('prohibited-browser-effects', 'choose-fixture')).toBe(false);
    expect(session.canUse('prohibited-browser-effects', 'retry')).toBe(false);
    expect(session.canUse('zero-label-unscorable', 'tune')).toBe(false);

    const retired = session.unsealHoldout('prohibited-browser-effects', {
      sideEffects: 'denied',
    });
    expect(retired.split).toBe('development');
    expect(retired.exposure).toMatchObject({
      state: 'unsealed-retired',
      originalScorePreserved: true,
      originalExposurePreserved: true,
    });
    expect(session.canUse('prohibited-browser-effects', 'tune')).toBe(false);
    expect(
      session.manifest.cases.find((pilotCase) => pilotCase.id === 'prohibited-browser-effects')
        ?.retirement,
    ).not.toHaveProperty('originalOutcome');
    expect(session.aggregate('future-shadow', 'development').caseIds).not.toContain(
      'prohibited-browser-effects',
    );
    expect(session.aggregate('current-state', 'development').caseIds).not.toContain(
      'future-shadow-negation',
    );
  });

  it('does not admit non-runnable or blocked cases to implementation or aggregation', async () => {
    const gate = await loadGateLib();
    const session = gate.createEvaluationSession(readManifest());

    expect(session.canUse('ambiguous-reservation', 'tune')).toBe(false);
    expect(session.canUse('partial-read', 'repair')).toBe(false);
    expect(session.canUse('wrong-document', 'choose-fixture')).toBe(false);
    expect(() => session.recordOutcome('partial-read', 'current-state', 'match')).toThrow(
      /eligible|runnable|blocked/i,
    );
    expect(() => session.recordOutcome('traffic-cohort-t0', 'current-state', 'match')).toThrow(
      /eligible|blocked/i,
    );
    expect(session.aggregate('current-state', 'development')).toEqual({
      evaluationMode: 'current-state',
      split: 'development',
      caseIds: [],
      eligibleCount: 0,
    });
  });

  it('builds a minimal child environment and strips ambient DB/model/browser/mail/Vite state', async () => {
    const gate = await loadGateLib();
    const environment = gate.buildChildEnvironment(
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PGHOST: 'live-db.example',
        PGPORT: '5432',
        PGPASSWORD: 'do-not-copy',
        POSTGRES_HOST: 'live-db.example',
        POSTGRES_PASSWORD: 'do-not-copy',
        NODE_OPTIONS: '--require=/tmp/live-preload.cjs',
        VITE_API_URL: 'https://live.example',
        OPENAI_API_KEY: 'do-not-copy',
        DATABASE_URL: 'postgres://live.example/prod',
      },
      { kind: 'fixture', guardPath: '/tmp/reservation-pilot-fixture-guard.mjs' },
    );

    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      MAIL_TRANSPORT_MODE: 'fixture',
      NAVA_FIXTURE_NETWORK: 'loopback-only',
      NAVA_EXTERNAL_SOCKETS: 'deny',
      NODE_OPTIONS: '--import=/tmp/reservation-pilot-fixture-guard.mjs',
    });
    expect(environment).not.toHaveProperty('PGHOST');
    expect(environment).not.toHaveProperty('PGPORT');
    expect(environment).not.toHaveProperty('PGPASSWORD');
    expect(environment).not.toHaveProperty('POSTGRES_HOST');
    expect(environment).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(environment).not.toHaveProperty('VITE_API_URL');
    expect(environment).not.toHaveProperty('DATABASE_URL');
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(Object.keys(environment).every((key) => gate.CHILD_ENV_ALLOWLIST.has(key))).toBe(true);
  });

  it('rejects external sockets through the actual fixture guard before connect', () => {
    const guardPath = path.join(here, '..', 'scripts', 'reservation-pilot-fixture-guard.mjs');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        guardPath,
        '--input-type=module',
        '-e',
        "import net from 'node:net'; try { net.connect({ host: '198.51.100.10', port: 9 }); console.log('not-denied'); } catch (error) { console.log(error.message); }",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/external sockets denied/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain('not-denied');
  });

  it('parses an executable fixture config contract rather than trusting comments', async () => {
    const gate = await loadGateLib();
    const valid = `
      import { defineConfig } from 'vite';
      export const pilotFixtureContract = {
        mode: 'fixture', envFiles: false, liveBindings: false,
        externalSockets: false, networkPolicy: 'loopback-only', transport: 'fake',
        allowedOrigins: ['http://127.0.0.1:4179'],
        publicOrigin: 'http://127.0.0.1:4179',
      } as const;
      export default defineConfig({ envDir: '/dev/null', server: { host: '127.0.0.1', port: 4179 } });
    `;
    expect(gate.validateFixtureConfigSource(valid, ['http://127.0.0.1:4179'])).toMatchObject({
      envFiles: false,
      externalSockets: false,
    });

    const commentOnly = `// envFiles: false, externalSockets: false\nexport default {};`;
    expect(() => gate.validateFixtureConfigSource(commentOnly, ['http://127.0.0.1:4179'])).toThrow(
      /pilotFixtureContract|fixture contract/i,
    );
    expect(() =>
      gate.validateFixtureConfigSource(
        valid.replace(
          'export const pilotFixtureContract',
          "const ambient = process['env']; export const pilotFixtureContract",
        ),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/live|process\.env/i);

    const dummyConfigThenObjectDefault = `
      import { defineConfig } from 'vite';
      export const pilotFixtureContract = {
        mode: 'fixture', envFiles: false, liveBindings: false,
        externalSockets: false, networkPolicy: 'loopback-only', transport: 'fake',
        allowedOrigins: ['http://127.0.0.1:4179'], publicOrigin: 'http://127.0.0.1:4179',
      } as const;
      const safeDummy = defineConfig({ envDir: '/dev/null', server: { host: '127.0.0.1', port: 4179 } });
      export default {};
    `;
    expect(() =>
      gate.validateFixtureConfigSource(dummyConfigThenObjectDefault, ['http://127.0.0.1:4179']),
    ).toThrow(/default|defineConfig/i);

    const proxyDefault = `
      import { defineConfig } from 'vite';
      export const pilotFixtureContract = {
        mode: 'fixture', envFiles: false, liveBindings: false,
        externalSockets: false, networkPolicy: 'loopback-only', transport: 'fake',
        allowedOrigins: ['http://127.0.0.1:4179'], publicOrigin: 'http://127.0.0.1:4179',
      } as const;
      export default defineConfig({
        envDir: '/dev/null',
        server: { host: '127.0.0.1', port: 4179, proxy: { '/pms': { target: 'https://pms.example' } } },
      });
    `;
    expect(() => gate.validateFixtureConfigSource(proxyDefault, ['http://127.0.0.1:4179'])).toThrow(
      /proxy|endpoint|external/i,
    );
  });

  it('allows only the reviewed local document fixture plugin in the explicit second slot', async () => {
    const gate = await loadGateLib();
    const contract = `
      export const pilotFixtureContract = {
        mode: 'fixture', envFiles: false, liveBindings: false,
        externalSockets: false, networkPolicy: 'loopback-only', transport: 'fake',
        allowedOrigins: ['http://127.0.0.1:4179'], publicOrigin: 'http://127.0.0.1:4179',
      } as const;
    `;
    const prefix = `
      import { defineConfig } from 'vite';
      import tailwindcss from '@tailwindcss/vite';
      ${contract}
    `;
    const config = (
      plugins: string,
      declaration = "function documentServiceFixturePlugin() { return { name: 'fixture' }; }",
      extra = '',
    ) => `
      ${prefix}
      ${declaration}
      export default defineConfig({
        envDir: '/dev/null', server: { host: '127.0.0.1', port: 4179 },
        plugins: ${plugins},
        ${extra}
      });
    `;

    expect(
      gate.validateFixtureConfigSource(config('[tailwindcss()]'), ['http://127.0.0.1:4179']),
    ).toMatchObject({ transport: 'fake' });
    expect(
      gate.validateFixtureConfigSource(config('[tailwindcss(), documentServiceFixturePlugin()]'), [
        'http://127.0.0.1:4179',
      ]),
    ).toMatchObject({ transport: 'fake' });

    expect(() =>
      gate.validateFixtureConfigSource(config('documentServiceFixturePlugin()'), [
        'http://127.0.0.1:4179',
      ]),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config('[tailwindcss(), [tailwindcss(), documentServiceFixturePlugin()]]'),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config(
          '[tailwindcss()]',
          undefined,
          'plugins: [tailwindcss(), documentServiceFixturePlugin()],',
        ),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/plugins|plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(config('[documentServiceFixturePlugin(), tailwindcss()]'), [
        'http://127.0.0.1:4179',
      ]),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config('[tailwindcss(), documentServiceFixturePlugin({})]'),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config('[tailwindcss(), documentServiceFixturePlugin(), tailwindcss()]'),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config(
          '[tailwindcss(), pluginAlias()]',
          'const pluginAlias = documentServiceFixturePlugin;',
        ),
      ),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config(
          '[tailwindcss(), documentServiceFixturePlugin()]',
          "import documentServiceFixturePlugin from './document-service-fixture.js';",
        ),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config(
          '[tailwindcss(), documentServiceFixturePlugin()]',
          "const documentServiceFixturePlugin = () => ({ name: 'fixture' });",
        ),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/plugin|literal/i);
    expect(() =>
      gate.validateFixtureConfigSource(
        config(
          '[tailwindcss(), documentServiceFixturePlugin()]',
          "function documentServiceFixturePlugin() { return { name: 'fixture' }; }",
          'root: resolveRoot(),',
        ),
        ['http://127.0.0.1:4179'],
      ),
    ).toThrow(/literal/i);
  });

  it('requires an actual browser egress boundary before a Chromium child', async () => {
    const gate = await loadGateLib();
    expect(() => gate.assertBrowserNetworkBoundary()).not.toThrow();
  });

  it('rejects any unexpected Docker Postgres publication', async () => {
    const gate = await loadGateLib();
    expect(gate.getDbProfile('pg16')).toMatchObject({
      major: '16',
      port: '15433',
      runLabel: '20260907-pg16-u1setup',
      sentinelTable: 'centurion_u1_pg16_setup_sentinel',
    });
    expect(() => gate.getDbProfile('production')).toThrow(/unknown disposable database profile/i);
    expect(() =>
      gate.validatePostgresPortBindings({
        '5432/tcp': [
          { HostIp: '127.0.0.1', HostPort: '15432' },
          { HostIp: '0.0.0.0', HostPort: '15432' },
        ],
      }),
    ).toThrow(/binding|exposure/i);
    expect(
      gate.validatePostgresPortBindings({
        '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }],
      }),
    ).toBe(true);
    expect(
      gate.validatePostgresPortBindings(
        { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15433' }] },
        '15433',
      ),
    ).toBe(true);
  });

  it('requires a nonempty, fully passing exact browser title selection', async () => {
    const gate = await loadGateLib();
    const report = {
      suites: [
        {
          title: '',
          specs: [
            {
              title: 'reservation-tools-pilot/dashboard',
              tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
            },
          ],
        },
      ],
    };
    expect(gate.validatePlaywrightReport(report, 'reservation-tools-pilot/dashboard')).toEqual({
      testCount: 1,
      skipped: 0,
      failed: 0,
    });
    expect(() =>
      gate.validatePlaywrightReport(
        {
          suites: [
            { title: '', specs: [{ title: 'reservation-tools-pilot/dashboard', tests: [] }] },
          ],
        },
        'reservation-tools-pilot/dashboard',
      ),
    ).toThrow(/zero tests|selected no tests/i);
    expect(() =>
      gate.validatePlaywrightReport(
        {
          suites: [
            {
              title: '',
              specs: [
                {
                  title: 'reservation-tools-pilot/dashboard',
                  tests: [{ status: 'flaky', results: [{ status: 'passed' }] }],
                },
              ],
            },
          ],
        },
        'reservation-tools-pilot/dashboard',
      ),
    ).toThrow(/skipped\/failed/i);
  });

  it('maps dashboard and measurement to downstream named tests and keeps U1 self-tests separate', async () => {
    const gate = await loadGateLib();
    expect(gate.getSlicePlan('unit', 'dashboard')).toEqual({
      server: [
        'tests/admin-dashboard-access.test.ts',
        'tests/admin-dashboard-metrics.test.ts',
        'tests/admin-dashboard-query.test.ts',
        'tests/admin-dashboard-export.test.ts',
      ],
      mail: [
        'tests/admin-dashboard/response-metrics-availability.test.ts',
        'tests/admin-dashboard/business-overview.test.tsx',
        'tests/admin-dashboard/export.test.ts',
      ],
    });
    expect(gate.getSlicePlan('unit', 'measurement')).toEqual({
      server: ['tests/mail-measurement-config.test.ts', 'tests/mail-data-health.test.ts'],
    });
    expect(gate.getSlicePlan('unit', 'gate')).toEqual({
      server: [
        'tests/reservation-pilot-gate.test.ts',
        'tests/reservation-pilot-gate-dispatch.test.ts',
        'tests/fixtures/reservation-tools-pilot.json',
        'scripts/reservation-pilot-gate-lib.mjs',
        'scripts/reservation-pilot-fixture-guard.mjs',
      ],
    });
    expect(gate.getSlicePlan('unit', 'drafting').server).toContain(
      'tests/hms-live-guest-stay.test.ts',
    );
  });

  it('refuses a deterministic missing path without launching a future test runner', async () => {
    const gate = await loadGateLib();
    expect(() =>
      gate.assertRequiredFiles(path.join(here, '..', '..', '..'), [
        'apps/server-pilot/tests/__u1_required_path_is_absent__.test.ts',
      ]),
    ).toThrow(/required file|missing/i);
  });
});

describe('reservation pilot gate refusal contract', () => {
  it('refuses unknown mode and unknown slice before a child runner', () => {
    const unknownMode = runGate('nope', 'dashboard');
    expect(unknownMode.status).not.toBe(0);
    expect(`${unknownMode.stdout}${unknownMode.stderr}`).toMatch(/unknown mode/i);

    const unknownSlice = runGate('unit', 'not-a-slice');
    expect(unknownSlice.status).not.toBe(0);
    expect(`${unknownSlice.stdout}${unknownSlice.stderr}`).toMatch(/unknown slice/i);
  });

  it('refuses required DB mode without a verified disposable URL and clears ambient DB', () => {
    const result = runGate('db', 'outbox', {
      DATABASE_URL: 'postgres://ambient:secret@ambient.example/prod',
      NAVA_TEST_DATABASE_URL: undefined,
      CONFIRM_DISPOSABLE_TEST_DB: undefined,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/NAVA_TEST_DATABASE_URL|disposable|required file/i);
    expect(output).not.toContain('ambient:secret');
  });

  it('refuses production-looking DB before connection and does not leak credentials', () => {
    const secret = 'do-not-print-this-password';
    const result = runGate('db', 'outbox', {
      NAVA_TEST_DATABASE_URL: `postgres://fixture:${secret}@nava-zero-mail-pilot.cluster.amazonaws.com/prod`,
      CONFIRM_DISPOSABLE_TEST_DB: '1',
      DATABASE_URL: undefined,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/refus|production|pilot/i);
    expect(output).not.toContain(secret);
  });

  it('refuses a missing future requirement without skipping green', async () => {
    const gate = await loadGateLib();
    expect(() =>
      gate.assertRequiredFiles(path.join(here, '..', '..', '..'), [
        'apps/server-pilot/tests/__u1_future_requirement_is_absent__.test.ts',
      ]),
    ).toThrow(/required file|missing/i);
  });
});
