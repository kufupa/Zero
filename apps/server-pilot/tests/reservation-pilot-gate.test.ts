import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

function runGate(
  mode: string,
  slice: string,
  overrides: Record<string, string | undefined> = {},
) {
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

describe('reservation pilot synthetic fixture [dashboard]', () => {
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
    expect(manifest.browserSafety.allowedOrigins).toEqual(['http://127.0.0.1']);
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

describe('reservation pilot Phase 2/B contract [measurement]', () => {
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
        if (blockedPasses.has(outcome)) expect(outcome).not.toBe('match');
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

  it('refuses a future slice when its named test/config is absent instead of skipping green', () => {
    const result = runGate('unit', 'reads', {
      DATABASE_URL: undefined,
      VITEST_ALLOW_PILOT_RDS: undefined,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/required file|missing|not available/i);
    expect(output).not.toMatch(/pass(ed)?\s+with\s+no\s+tests/i);
  });
});
