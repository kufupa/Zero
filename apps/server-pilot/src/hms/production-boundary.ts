/**
 * HMS production boundary — typed registry + import-graph proofs for read-only rollout.
 * No live HMS, no mutation enable flags, no write-lab/OCR/MCP/generic-browser in HMS graph.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  allToolEffectsAreRead,
  candidateToolEffects,
  createCandidateTools,
  createMockCandidateSession,
  DEFAULT_CANDIDATE_ACTIVE_TOOL_IDS,
  runClaimSafeCandidateDraft,
} from '../ai/candidate-draft-agent.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import { redactSecrets, redactTracePayload } from '../ai/security/redact.js';
import { computeThreadStateVersion } from '../ai/thread-context.js';
import { loadPm2Config } from '../deploy/load-pm2-config.js';
import {
  requestPolicyManifestSchema,
  requestRuleSchema,
} from './contracts.js';
import { evaluateObservedRequest } from './request-policy.js';
import {
  evaluateHmsCandidateFreshness,
  hmsPromoteBlockedByFreshness,
  isHmsEnrichedGeneration,
  resolveHmsCandidateVisibility,
} from '../trpc/routes/drafts.js';
import { issueTrustedRequesterAuthorization } from './requester-authorization.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverPilotRoot = join(here, '..', '..');
const srcRoot = join(serverPilotRoot, 'src');

/** Modules forbidden from the HMS production dependency graph (source imports). */
export const FORBIDDEN_HMS_GRAPH_PATTERNS: readonly RegExp[] = [
  /write[-_]?lab/i,
  /mail\/send\/smtp/,
  /getSmtpTransport/,
  /mail\/ingest\/pop3-client/,
  /pop3-client/,
  /@modelcontextprotocol/,
  /\/mcp\//i,
  /generic[-_]?browser/i,
  /tesseract/i,
  /ocrmypdf/i,
  /document[-_]?vision/i,
];

/** Env / PM2 keys that must never enable live HMS mutation. */
export const FORBIDDEN_MUTATION_ENABLE_KEYS: readonly string[] = [
  'HMS_MUTATION_ENABLED',
  'HMS_WRITE_ENABLED',
  'HMS_WRITE_ADAPTERS',
  'HMS_ALLOW_LIVE_WRITE',
  'HMS_LIVE_MUTATION',
  'INFOR_HMS_WRITE',
];

export type ProductionBoundaryReport = {
  allToolEffectsRead: boolean;
  toolEffects: Record<string, string>;
  forbiddenImports: Array<{ file: string; match: string }>;
  hmsBrowserOwnerOnly: boolean;
  defaultWorkerCannotClaimHms: boolean;
  mutationFlagsAbsent: boolean;
  failures: string[];
  passed: boolean;
};

export type HmsDraftJourneyId =
  | 'reservation_exact_candidate'
  | 'reservation_ambiguous_clarification'
  | 'quote_partial_no_candidate'
  | 'artifact_candidate_private'
  | 'scanned_pdf_manual'
  | 'unknown_request_abort'
  | 'timeout_lease_no_generation'
  | 'refresh_failure_keeps_prior'
  | 'outbound_before_send_stale'
  | 'off_mode_skeleton_promotable';

export type HmsDraftJourneyResult = {
  id: HmsDraftJourneyId;
  passed: boolean;
  detail: string;
};

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...walkTsFiles(full));
    } else if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

/** HMS + candidate-agent source roots that must stay read-only / fixture-safe. */
export function hmsProductionSourceRoots(): string[] {
  return [
    join(srcRoot, 'hms'),
    join(srcRoot, 'ai', 'candidate-draft-agent.ts'),
    join(srcRoot, 'ai', 'draft-evidence.ts'),
    join(srcRoot, 'mail', 'artifacts'),
  ];
}

/** Strict shadow terminal writer modules (Task 4+). Must not import src/ai/drafts. */
export function hmsShadowTerminalModules(): string[] {
  return [join(srcRoot, 'ai', 'hms-shadow.ts')].filter((p) => existsSync(p));
}

function normalizeImportSpecifier(specifier: string): string {
  return specifier.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Enumerate static imports, dynamic import(), and re-exports via TypeScript AST.
 * Does not use regex expansion of import lines.
 */
export function collectModuleImportSpecifiers(filePath: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specs: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specs.map(normalizeImportSpecifier);
}

export function collectForbiddenImports(
  roots: string[] = hmsProductionSourceRoots(),
): Array<{ file: string; match: string }> {
  const hits: Array<{ file: string; match: string }> = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      const st = statSync(root);
      files = st.isDirectory() ? walkTsFiles(root) : [root];
    } catch {
      continue;
    }
    for (const file of files) {
      // Skip this module — it documents forbidden patterns as RegExp sources.
      if (file.replace(/\\/g, '/').endsWith('/hms/production-boundary.ts')) continue;
      const text = readFileSync(file, 'utf8');
      const importSpecs = collectModuleImportSpecifiers(file, text);
      const scanTarget = importSpecs.join('\n');
      for (const pattern of FORBIDDEN_HMS_GRAPH_PATTERNS) {
        if (pattern.test(scanTarget) || importSpecs.some((s) => pattern.test(s))) {
          hits.push({
            file: relative(serverPilotRoot, file).replace(/\\/g, '/'),
            match: pattern.source,
          });
        }
      }
    }
  }

  for (const file of hmsShadowTerminalModules()) {
    const text = readFileSync(file, 'utf8');
    const importSpecs = collectModuleImportSpecifiers(file, text);
    const fileDir = dirname(file);
    for (const spec of importSpecs) {
      let resolved = spec;
      if (spec.startsWith('.')) {
        resolved = join(fileDir, spec).replace(/\\/g, '/');
      }
      const normalized = resolved
        .replace(/\\/g, '/')
        .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
      if (
        normalized.endsWith('/ai/drafts') ||
        normalized.includes('/ai/drafts/') ||
        /(?:^|[\\/])ai\/drafts(?:\.(?:ts|js))?$/.test(spec) ||
        spec.includes('ai/drafts')
      ) {
        hits.push({
          file: relative(serverPilotRoot, file).replace(/\\/g, '/'),
          match: 'ai/drafts',
        });
      }
    }
  }

  return hits;
}

const RAW_PAGE_APIS = new Set([
  'goto',
  'content',
  'postForm',
  'click',
  'fill',
  'press',
  'locator',
  'evaluate',
  'evaluateStableDom',
]);

/** Syntax-aware proof that production drivers cannot reach raw browser APIs. */
export function collectRawPageDriverAccess(
  files?: readonly string[],
): Array<{ file: string; api: string }> {
  const hits: Array<{ file: string; api: string }> = [];
  const targets =
    files ??
    walkTsFiles(join(srcRoot, 'hms')).filter((file) =>
      file.replace(/\\/g, '/').endsWith('-driver.ts'),
    );
  for (const file of targets) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const record = (api: string) => {
      hits.push({
        file: relative(serverPilotRoot, file).replace(/\\/g, '/'),
        api,
      });
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isImportSpecifier(node) &&
        node.name.text === 'HmsPage'
      ) {
        record('HmsPage');
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        RAW_PAGE_APIS.has(node.name.text)
      ) {
        record(node.name.text);
      }
      // page['goto'] and friends bypass property-access detection.
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        RAW_PAGE_APIS.has(node.argumentExpression.text)
      ) {
        record(node.argumentExpression.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

/**
 * Promoted negative terminals may only be constructed by negative-result.ts.
 * Legacy receipt type unions remain readable, but production paths cannot assign them.
 */
const PROMOTED_NEGATIVE_LITERALS = new Set([
  'BUSINESS_NOT_FOUND',
  'business_not_found',
  'not_found',
]);

/** Assignment targets that carry a promoted terminal to model / receipt surfaces. */
const PROMOTED_NEGATIVE_TARGETS = new Set(['status', 'outcome', 'terminalCode']);

/**
 * Parser-level `outcome: 'not_found'` stays legal (internal search vocabulary);
 * only tool `status` and receipt `terminalCode` may not carry it as a value.
 */
const PROMOTED_NEGATIVE_PROPERTY_TARGETS = new Set(['status', 'terminalCode']);

function assignmentTargetName(target: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  return null;
}

/** Sole adapter path: only negative-result.ts may construct business not_found. */
export const BUSINESS_NOT_FOUND_SOLE_ADAPTER =
  'src/hms/negative-result.ts' as const;

export function collectBusinessNotFoundAssignments(
  inputFiles?: readonly string[],
): Array<{
  file: string;
  value: string;
}> {
  const files = (
    inputFiles ?? [
      ...walkTsFiles(join(srcRoot, 'hms')).filter((file) => {
        const normalized = file.replace(/\\/g, '/');
        return (
          /(?:-driver|reservation-candidate-session|adapter|browser-artifacts|claim-envelope|quote-stay-contract|document-list-contract|sent-email-audit-contract|folio-read-contract|company-account-read-contract|group-block-read-contract|event-read-contract)\.ts$/.test(
            normalized,
          ) || /\/hms\/(?:adapter|browser-artifacts|claim-envelope)\.ts$/.test(normalized)
        );
      }),
      join(srcRoot, 'ai', 'worker.ts'),
      join(srcRoot, 'ops', 'hms-live-proof.ts'),
    ]
  ).filter((file) => existsSync(file));
  const hits: Array<{ file: string; value: string }> = [];
  for (const file of files) {
    if (file.replace(/\\/g, '/').endsWith('/hms/negative-result.ts')) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const record = (value: string) => {
      hits.push({
        file: relative(serverPilotRoot, file).replace(/\\/g, '/'),
        value,
      });
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isStringLiteralLike(node.initializer) &&
        PROMOTED_NEGATIVE_LITERALS.has(node.initializer.text)
      ) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
          ? node.name.text
          : null;
        if (
          node.initializer.text !== 'not_found' ||
          (name !== null && PROMOTED_NEGATIVE_PROPERTY_TARGETS.has(name))
        ) {
          record(node.initializer.text);
        }
      }
      // `status = 'not_found'` / `receipt.terminalCode = 'BUSINESS_NOT_FOUND'`.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isStringLiteralLike(node.right) &&
        PROMOTED_NEGATIVE_LITERALS.has(node.right.text)
      ) {
        const name = assignmentTargetName(node.left);
        if (name !== null && PROMOTED_NEGATIVE_TARGETS.has(name)) {
          record(node.right.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (inputFiles) return hits;
  const opsPath = join(serverPilotRoot, 'deploy', 'ops-hms-proof.sh');
  if (existsSync(opsPath)) {
    for (const line of readFileSync(opsPath, 'utf8').split(/\r?\n/)) {
      if (
        /(?:status|outcome|terminalCode)\s*[:=]\s*["']?(?:BUSINESS_NOT_FOUND|business_not_found|not_found)\b/.test(
          line,
        )
      ) {
        hits.push({
          file: relative(serverPilotRoot, opsPath).replace(/\\/g, '/'),
          value: line.trim(),
        });
      }
    }
  }
  return hits;
}

export function assertToolEffectsAllRead(): void {
  if (!allToolEffectsAreRead()) {
    throw new Error('HMS production boundary: non-read tool effect registered');
  }
  for (const [id, effect] of Object.entries(candidateToolEffects)) {
    if (effect !== 'read') {
      throw new Error(`HMS production boundary: tool ${id} effect=${effect}`);
    }
  }
}

export function assertNoMutationEnableFlags(env: Record<string, unknown>): void {
  for (const key of FORBIDDEN_MUTATION_ENABLE_KEYS) {
    const val = env[key];
    if (
      val !== undefined &&
      val !== null &&
      String(val) !== '' &&
      String(val) !== '0' &&
      String(val) !== 'false'
    ) {
      throw new Error(
        `HMS production boundary: mutation enable flag present: ${key}=${String(val)}`,
      );
    }
  }
}

export function assertPm2HasNoMutationFlags(): void {
  const pm2 = loadPm2Config() as {
    apps: Array<{ name: string; env?: Record<string, string> }>;
  };
  for (const app of pm2.apps) {
    assertNoMutationEnableFlags(app.env ?? {});
  }
  const pkg = JSON.parse(readFileSync(join(serverPilotRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = Object.values(pkg.scripts ?? {}).join('\n');
  for (const key of FORBIDDEN_MUTATION_ENABLE_KEYS) {
    if (scripts.includes(key)) {
      throw new Error(`HMS production boundary: package.json scripts reference ${key}`);
    }
  }
}

/** Only hms-ai-worker may set AI_WORKER_LANE=hms; default ai-worker stays default. */
export function assertHmsBrowserOwnerIsolation(): {
  hmsBrowserOwnerOnly: boolean;
  defaultWorkerCannotClaimHms: boolean;
} {
  const pm2 = loadPm2Config() as {
    apps: Array<{ name: string; env?: Record<string, string>; script?: string }>;
  };
  const aiWorker = pm2.apps.find((a) => a.name === 'ai-worker');
  const hmsWorker = pm2.apps.find((a) => a.name === 'hms-ai-worker');
  const hmsBrowserOwnerOnly =
    hmsWorker?.env?.AI_WORKER_LANE === 'hms' &&
    aiWorker?.env?.AI_WORKER_LANE === 'default' &&
    hmsWorker?.script === '/usr/local/bin/asm-exec';
  const defaultWorkerCannotClaimHms = aiWorker?.env?.AI_WORKER_LANE !== 'hms';
  if (!hmsBrowserOwnerOnly) {
    throw new Error('HMS production boundary: HMS browser owner isolation failed in PM2');
  }
  if (!defaultWorkerCannotClaimHms) {
    throw new Error('HMS production boundary: default worker can claim HMS lane');
  }
  return { hmsBrowserOwnerOnly, defaultWorkerCannotClaimHms };
}

/**
 * When HMS_DB_TEST_REQUIRED=1, DATABASE_URL must be present (fail closed).
 * General suites may still skip; HMS gate never skips green on missing DB.
 */
export function assertHmsDbTestPrerequisite(): void {
  if (process.env.HMS_DB_TEST_REQUIRED !== '1') return;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'HMS_DB_TEST_REQUIRED=1 but DATABASE_URL is unset — fail closed (no skip)',
    );
  }
}

export function auditProductionBoundary(): ProductionBoundaryReport {
  const failures: string[] = [];
  let allToolEffectsRead = false;
  try {
    assertToolEffectsAllRead();
    allToolEffectsRead = true;
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  const forbiddenImports = collectForbiddenImports();
  if (forbiddenImports.length > 0) {
    failures.push(
      `forbidden imports: ${forbiddenImports.map((h) => `${h.file}~${h.match}`).join('; ')}`,
    );
  }

  let hmsBrowserOwnerOnly = false;
  let defaultWorkerCannotClaimHms = false;
  try {
    const iso = assertHmsBrowserOwnerIsolation();
    hmsBrowserOwnerOnly = iso.hmsBrowserOwnerOnly;
    defaultWorkerCannotClaimHms = iso.defaultWorkerCannotClaimHms;
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  let mutationFlagsAbsent = false;
  try {
    assertPm2HasNoMutationFlags();
    mutationFlagsAbsent = true;
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const session = createMockCandidateSession({});
    const bundle = createCandidateTools(session);
    const ids = Object.keys(bundle.tools).sort();
    const expected = [...DEFAULT_CANDIDATE_ACTIVE_TOOL_IDS].sort();
    if (ids.join(',') !== expected.join(',')) {
      failures.push(`tool registry drift: got ${ids.join(',')} expected ${expected.join(',')}`);
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  return {
    allToolEffectsRead,
    toolEffects: { ...candidateToolEffects },
    forbiddenImports,
    hmsBrowserOwnerOnly,
    defaultWorkerCannotClaimHms,
    mutationFlagsAbsent,
    failures,
    passed: failures.length === 0,
  };
}

function sha(hexChar: string): string {
  return hexChar.repeat(64);
}

function parseAvailableClaimIds(userPrompt: string): string[] {
  try {
    // The claim-safe runner now wraps the plan payload in bounded prepared
    // input. Extract only its code-owned allowlist rather than parsing the
    // whole prompt as JSON.
    const json = /Available claim IDs:\s*(\[[^\]]*\])/s.exec(userPrompt)?.[1] ?? userPrompt;
    const parsed = JSON.parse(json) as { availableClaimIds?: string[] } | string[];
    if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string');
    return Array.isArray(parsed.availableClaimIds) ? parsed.availableClaimIds : [];
  } catch {
    return [];
  }
}

function planFromAvailableClaims(userPrompt: string): Record<string, unknown> {
  const ids = parseAvailableClaimIds(userPrompt);
  if (ids.length === 0) {
    return {
      outcome: 'insufficient_evidence',
      questionCodes: [],
      unavailableSources: ['hms'],
    };
  }
  return {
    outcome: 'candidate',
    salutation: 'generic',
    openingTemplate: 'acknowledge_request',
    selectedClaimIds: [ids[0]!],
    closingTemplate: 'invite_questions',
  };
}

function hmsEv(
  id: string,
  toolId: string,
  claimKeys: string[],
  hashChar: string,
  now: Date,
): ToolResult<unknown>['evidence'] {
  const observedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  return {
    kind: 'hms',
    id,
    toolId,
    toolVersion: '1',
    propertyCode: 'CENTURION',
    observedAt,
    expiresAt,
    claimKeys,
    sourceHash: sha(hashChar),
    scopeVerified: true,
  };
}

function journeyClaimAuthorization(now: Date) {
  const currentState = {
    operationId: 'production-boundary-journey',
    mailboxGrant: {
      sha256: sha('a'),
      transportId: 'journey-transport',
      active: true,
    },
    thread: {
      transportId: 'journey-transport',
      threadId: 'journey-thread',
      stateVersion: 'journey-state-v1',
    },
    requester: {
      identity: 'journey-requester',
      requesterClass: 'reservation_guest',
      inquiryClass: 'labelled_narrow_status',
      allowedClaimKinds: ['reservation_summary'],
      forwarded: false,
      spoofed: false,
    },
  } as const;
  const key = Buffer.alloc(32, 0x41);
  const expectedPrivateDigestKeyVersion = 'journey-key-v1';
  const authorization = issueTrustedRequesterAuthorization(currentState, {
    key,
    keyVersion: expectedPrivateDigestKeyVersion,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
  });
  if (!authorization) throw new Error('journey requester authorization could not be issued');
  return {
    authorization,
    currentState,
    key,
    expectedPrivateDigestKeyVersion,
    now,
  };
}

/**
 * API-level fixture journeys (no live HMS / no full UI stack required).
 * Proves outcome matrix from plan Task 9 Step 3 against claim-safe agent + mocks.
 * `now` freezes evidence TTL so journeys stay green as wall time advances.
 */
export async function runHmsDraftPipelineJourneys(
  now: Date = new Date(),
): Promise<HmsDraftJourneyResult[]> {
  const results: HmsDraftJourneyResult[] = [];
  const live = new AbortController().signal;
  const observedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

  {
    const session = createMockCandidateSession({
      claimAuthorization: journeyClaimAuthorization(now),
      lookupCandidates: new Map([
        ['cand-res-1', { id: 'cand-res-1', kind: 'confirmation', value: 'CONF-1' }],
      ]),
      findReservation: async () =>
        ({
          status: 'ok',
          draftReady: true,
          data: {
            matches: [
              {
                confirmationNumber: 'CONF-1',
                externalReference: null,
                guestName: 'Guest',
                arrivalDate: '2026-08-01',
                departureDate: '2026-08-03',
                reservationStatus: 'Confirmed',
                roomType: 'STD',
                ratePlan: null,
              },
            ],
            matchCount: 1,
            capped: false,
          },
          unresolvedFields: [],
          evidence: hmsEv('ev-1', 'hms_find_reservation', ['reservation.status'], 'a', now),
        }) as never,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'Please confirm reservation',
      signal: live,
      planModel: async ({ userPrompt }) => planFromAvailableClaims(userPrompt),
      now,
    });
    results.push({
      id: 'reservation_exact_candidate',
      passed: out.outcome === 'candidate',
      detail: `outcome=${out.outcome}`,
    });
  }

  {
    const session = createMockCandidateSession({
      lookupCandidates: new Map([
        ['cand-amb', { id: 'cand-amb', kind: 'confirmation', value: 'AMB' }],
      ]),
      findReservation: async () =>
        ({
          status: 'ambiguous',
          draftReady: false,
          data: { matches: [{}, {}], matchCount: 2, capped: false },
          unresolvedFields: ['reservation.match'],
          evidence: hmsEv('ev-amb', 'hms_find_reservation', [], 'b', now),
        }) as never,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'Which reservation?',
      signal: live,
      planModel: async () => ({
        outcome: 'needs_clarification',
        questionCodes: ['ambiguous_match'],
        unavailableSources: [],
      }),
      now,
    });
    results.push({
      id: 'reservation_ambiguous_clarification',
      passed: out.outcome === 'needs_clarification' || out.outcome !== 'candidate',
      detail: `outcome=${out.outcome}`,
    });
  }

  {
    const session = createMockCandidateSession({
      lookupCandidates: new Map([
        [
          'cand-q',
          {
            id: 'cand-q',
            kind: 'surname_dates',
            surname: 'X',
            arrivalDate: '2026-08-01',
            departureDate: '2026-08-03',
          },
        ],
      ]),
      quoteStay: async () =>
        ({
          status: 'partial',
          draftReady: false,
          data: { inventoryObservations: [], rateObservations: [] },
          unresolvedFields: ['rate.amount', 'inventory.rooms'],
          evidence: hmsEv('ev-q', 'hms_quote_stay', [], 'c', now),
        }) as never,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'Quote for 2 rooms',
      signal: live,
      planModel: async () => ({
        outcome: 'insufficient_evidence',
        questionCodes: [],
        unavailableSources: ['hms'],
      }),
      now,
    });
    results.push({
      id: 'quote_partial_no_candidate',
      passed: out.outcome !== 'candidate',
      detail: `outcome=${out.outcome}`,
    });
  }

  {
    const session = createMockCandidateSession({
      authorizedAttachmentIds: new Set(['att-pdf']),
      readArtifact: async () =>
        ({
          status: 'ok',
          draftReady: false,
          data: {
            mimeType: 'application/pdf' as const,
            text: 'Confirmation CONF-99 on file',
            pageCount: 1,
            reason: 'text' as const,
          },
          unresolvedFields: [],
          evidence: {
            kind: 'mail_attachment',
            id: 'ev-pdf',
            toolId: 'mail_read_artifact',
            toolVersion: '2',
            attachmentId: 'att-pdf',
            observedAt,
            sourceHash: sha('d'),
            claimKeys: [],
          },
        }) as never,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'See attached PDF',
      signal: live,
      probeAttachmentIds: ['att-pdf'],
      planModel: async ({ userPrompt }) => planFromAvailableClaims(userPrompt),
      now,
    });
    results.push({
      id: 'artifact_candidate_private',
      passed: out.outcome === 'insufficient_evidence',
      detail: `outcome=${out.outcome}`,
    });
  }

  {
    const session = createMockCandidateSession({
      authorizedAttachmentIds: new Set(['att-scan']),
      readArtifact: async () =>
        ({
          status: 'manual_required',
          draftReady: false,
          data: {
            mimeType: 'application/pdf' as const,
            text: null,
            pageCount: 2,
            reason: 'no_embedded_text' as const,
          },
          unresolvedFields: ['attachment.text'],
          evidence: {
            kind: 'mail_attachment',
            id: 'ev-scan',
            toolId: 'mail_read_artifact',
            toolVersion: '2',
            attachmentId: 'att-scan',
            observedAt,
            sourceHash: sha('e'),
            claimKeys: [],
          },
        }) as never,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'Scanned attachment',
      signal: live,
      probeAttachmentIds: ['att-scan'],
      planModel: async () => ({
        outcome: 'insufficient_evidence',
        questionCodes: [],
        unavailableSources: ['mail_attachment'],
      }),
      now,
    });
    results.push({
      id: 'scanned_pdf_manual',
      passed: out.outcome !== 'candidate',
      detail: `outcome=${out.outcome}`,
    });
  }

  {
    const session = createMockCandidateSession({
      lookupCandidates: new Map([
        ['cand-unk', { id: 'cand-unk', kind: 'confirmation', value: 'X' }],
      ]),
      findReservation: async () => {
        throw new Error('UNKNOWN_REQUEST_ABORTED');
      },
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'lookup',
      signal: live,
      planModel: async ({ userPrompt }) => planFromAvailableClaims(userPrompt),
      now,
    });
    results.push({
      id: 'unknown_request_abort',
      passed: out.outcome !== 'candidate',
      detail: `outcome=${out.outcome}`,
    });
  }

  {
    const session = createMockCandidateSession({
      lookupCandidates: new Map([
        ['cand-to', { id: 'cand-to', kind: 'confirmation', value: 'T' }],
      ]),
      findReservation: async (_id, signal) => {
        if (signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        throw new Error('should have aborted');
      },
    });
    const controller = new AbortController();
    controller.abort();
    let passed = false;
    let detail = '';
    try {
      const out = await runClaimSafeCandidateDraft({
        session,
        normalizedThreadText: 'timeout',
        signal: controller.signal,
        now,
      });
      passed = out.outcome !== 'candidate';
      detail = `outcome=${out.outcome}`;
    } catch (err) {
      passed = true;
      detail = err instanceof Error ? err.message : String(err);
    }
    results.push({ id: 'timeout_lease_no_generation', passed, detail });
  }

  {
    // Refresh failure / dead_letter: prior candidate stays; activeRun cleared.
    const priorId = 'draft-prior';
    const visibility = resolveHmsCandidateVisibility({
      priorCandidateId: priorId,
      refreshRun: { id: 'run-refresh-fail', state: 'dead_letter' },
    });
    results.push({
      id: 'refresh_failure_keeps_prior',
      passed:
        visibility.visibleCandidateId === priorId && visibility.activeRun === null,
      detail: `visible=${visibility.visibleCandidateId ?? 'none'};activeRun=${visibility.activeRun?.state ?? 'none'}`,
    });
  }

  {
    // New outbound after generation → thread version drift → stale_thread → send blocked.
    const atGeneration = computeThreadStateVersion({
      messages: [
        {
          id: 'm-in',
          direction: 'inbound',
          timestamp: '2026-07-30T10:00:00.000Z',
        },
      ],
      latestDraftRevisionId: null,
    });
    const afterOutbound = computeThreadStateVersion({
      messages: [
        {
          id: 'm-in',
          direction: 'inbound',
          timestamp: '2026-07-30T10:00:00.000Z',
        },
        {
          id: 'm-out',
          direction: 'outbound',
          timestamp: '2026-07-30T10:05:00.000Z',
        },
      ],
      latestDraftRevisionId: null,
    });
    const evidence = [
      hmsEv('ev-stale', 'hms_find_reservation', ['reservation.status'], 'f', now),
    ];
    const freshness = evaluateHmsCandidateFreshness({
      threadStateVersion: atGeneration,
      liveThreadStateVersion: afterOutbound,
      evidence,
      now,
    });
    const sendBlocked = hmsPromoteBlockedByFreshness({
      generation: {
        outcome: 'candidate',
        threadStateVersion: atGeneration,
        evidence,
      },
      liveThreadStateVersion: afterOutbound,
      now,
    });
    results.push({
      id: 'outbound_before_send_stale',
      passed: freshness === 'stale_thread' && sendBlocked,
      detail: `freshness=${freshness};sendBlocked=${sendBlocked}`,
    });
  }

  {
    // Off-mode skeleton: not HMS-enriched → promote freshness gate skipped.
    const skeletonGeneration = {
      outcome: null,
      threadStateVersion: null,
      evidence: [] as unknown[],
    };
    const enriched = isHmsEnrichedGeneration(skeletonGeneration);
    const promoteBlocked = hmsPromoteBlockedByFreshness({
      generation: skeletonGeneration,
      liveThreadStateVersion: 'any-live-version',
    });
    results.push({
      id: 'off_mode_skeleton_promotable',
      passed: !enriched && !promoteBlocked,
      detail: `enriched=${enriched};promoteBlocked=${promoteBlocked}`,
    });
  }

  return results;
}

/** Security-marker matrix: inject markers; assert redaction/absence in serializable surfaces. */
export const SECURITY_MARKERS = {
  email: 'HMS_SEC_MARK_EMAIL_7f3a',
  fixtureDom: 'HMS_SEC_MARK_DOM_9c2b',
  pdf: 'HMS_SEC_MARK_PDF_1d4e',
  secretMeta: 'HMS_SEC_MARK_SECRET_5a8f',
} as const;

export function redactHmsSecurityMarkers(text: string): string {
  let out = text;
  for (const marker of Object.values(SECURITY_MARKERS)) {
    out = out.split(marker).join(`[REDACTED:${marker}]`);
  }
  return out;
}

/** Mirror runtime redactError: never echo password/secret/arn/cookie into health. */
function redactHealthError(errMessage: string): string {
  if (/password|secret|arn:aws|cookie|authorization/i.test(errMessage)) {
    return 'redacted_error';
  }
  return errMessage.slice(0, 120);
}

const SECURITY_MATRIX_ORIGIN = 'http://127.0.0.1:17888';

/**
 * Inject markers through email / fixture DOM POST / PDF / secret-loader paths,
 * then serialize the surfaces production code would persist or emit.
 * Raw markers must be absent or wrapped as [REDACTED:marker].
 */
export function buildSecurityMarkerSurfacesFromInjectedPayloads(payloads: {
  emailBody: string;
  fixtureDomPostData: string;
  pdfText: string;
  secretLoaderError: string;
}): {
  dbRowsJson: string;
  logs: string;
  metricsJson: string;
  healthJson: string;
  mastraJson: string;
  evidenceJson: string;
} {
  // Email → logs / Mastra: secret patterns + HMS marker redaction.
  const logs = redactHmsSecurityMarkers(
    redactSecrets(`mail.inbound body=${payloads.emailBody}`),
  );
  const mastraJson = redactHmsSecurityMarkers(
    JSON.stringify(
      redactTracePayload({
        kind: 'inbound_mail',
        body: payloads.emailBody,
      }),
    ),
  );

  // Fixture DOM / XHR body → request-policy redacted signature (keys only).
  const rule = requestRuleSchema.parse({
    id: 'reservation-search-sec',
    origin: SECURITY_MATRIX_ORIGIN,
    method: 'POST',
    path: '/web/reservation/search',
    resourceTypes: ['xhr', 'fetch'],
    fixedQuery: { screen: 'guestStay' },
    variableQuery: {
      confirmationNumber: { pattern: '[A-Z0-9]{1,16}', maxLength: 16 },
    },
    contentType: 'application/x-www-form-urlencoded',
    fixedBody: {
      action: 'search',
      tenant: 'FIXTURE',
      property: 'centurion',
    },
    variableBody: {
      surname: { pattern: "[A-Za-z0-9'_\\-]{1,64}", maxLength: 64 },
    },
    maxBodyBytes: 4096,
    redirectPolicy: 'same-reviewed-chain',
  });
  const manifest = requestPolicyManifestSchema.parse({ rules: [rule] });
  const decision = evaluateObservedRequest(manifest, {
    url: `${SECURITY_MATRIX_ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=CONF1`,
    method: 'POST',
    resourceType: 'xhr',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    postData: payloads.fixtureDomPostData,
  });
  const decisionJson = JSON.stringify(decision);

  // PDF → persisted evidence is ref/hash/claimKeys only (no attachment text).
  const sourceHash = createHash('sha256').update(payloads.pdfText).digest('hex');
  const evidence = {
    kind: 'mail_attachment',
    id: 'ev-sec-pdf',
    toolId: 'mail_read_artifact',
    toolVersion: '1',
    attachmentId: 'att-sec-pdf',
    observedAt: '2026-07-30T11:00:00.000Z',
    sourceHash,
    claimKeys: ['attachment.text'],
  };
  const evidenceJson = JSON.stringify(evidence);

  // Secret-loader failure → health lastErrorCode via redact path.
  const healthJson = JSON.stringify({
    schemaVersion: 1,
    state: 'degraded',
    lastErrorCode: redactHealthError(payloads.secretLoaderError),
  });

  const metricsJson = JSON.stringify({
    toolFailures: 0,
    securityMarkerPaths: ['email', 'dom', 'pdf', 'secret'],
    decisionAction: 'action' in decision ? decision.action : 'unknown',
  });

  const dbRowsJson = JSON.stringify({
    generations: [{ outcome: 'insufficient_evidence', evidence: [evidence] }],
    drafts: [{ textBody: '[REDACTED_DRAFT]' }],
    requestPolicy: JSON.parse(decisionJson),
  });

  return {
    dbRowsJson,
    logs,
    metricsJson,
    healthJson,
    mastraJson,
    evidenceJson,
  };
}

export function assertSecurityMarkersAbsentOrRedacted(surfaces: {
  dbRowsJson?: string;
  logs?: string;
  metricsJson?: string;
  healthJson?: string;
  mastraJson?: string;
  evidenceJson?: string;
}): { passed: boolean; leaks: string[] } {
  const leaks: string[] = [];
  for (const [surface, text] of Object.entries(surfaces)) {
    if (typeof text !== 'string') continue;
    for (const marker of Object.values(SECURITY_MARKERS)) {
      if (!text.includes(marker)) continue;
      // Allow only when every occurrence is inside [REDACTED:marker]
      const stripped = text.split(`[REDACTED:${marker}]`).join('');
      if (stripped.includes(marker)) {
        leaks.push(`${surface}:${marker}`);
      }
    }
  }
  return { passed: leaks.length === 0, leaks };
}
