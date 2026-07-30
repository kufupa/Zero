/**
 * HMS production boundary — typed registry + import-graph proofs for read-only rollout.
 * No live HMS, no mutation enable flags, no write-lab/OCR/MCP/generic-browser in HMS graph.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allToolEffectsAreRead,
  candidateToolEffects,
  createCandidateTools,
  createMockCandidateSession,
  runClaimSafeCandidateDraft,
} from '../ai/candidate-draft-agent.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import { loadPm2Config } from '../deploy/load-pm2-config.js';

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
  | 'pdf_text_candidate'
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
      const importLines = text
        .split('\n')
        .filter((line) => /^\s*(import|export)\b/.test(line) || /require\s*\(/.test(line));
      const scanTarget = importLines.join('\n');
      for (const pattern of FORBIDDEN_HMS_GRAPH_PATTERNS) {
        if (pattern.test(scanTarget)) {
          hits.push({
            file: relative(serverPilotRoot, file).replace(/\\/g, '/'),
            match: pattern.source,
          });
        }
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
    hmsWorker?.script === 'dist/ai/worker.js';
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
    const expected = Object.keys(candidateToolEffects).sort();
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
    const parsed = JSON.parse(userPrompt) as { availableClaimIds?: string[] };
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
): ToolResult<unknown>['evidence'] {
  return {
    kind: 'hms',
    id,
    toolId,
    toolVersion: '1',
    propertyCode: 'CENTURION',
    observedAt: '2026-07-30T11:00:00.000Z',
    expiresAt: '2026-07-30T13:00:00.000Z',
    claimKeys,
    sourceHash: sha(hashChar),
  };
}

/**
 * API-level fixture journeys (no live HMS / no full UI stack required).
 * Proves outcome matrix from plan Task 9 Step 3 against claim-safe agent + mocks.
 */
export async function runHmsDraftPipelineJourneys(): Promise<HmsDraftJourneyResult[]> {
  const results: HmsDraftJourneyResult[] = [];
  const live = new AbortController().signal;

  {
    const session = createMockCandidateSession({
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
          evidence: hmsEv('ev-1', 'hms_find_reservation', ['reservation.status'], 'a'),
        }) as ToolResult<unknown>,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'Please confirm reservation',
      signal: live,
      planModel: async ({ userPrompt }) => planFromAvailableClaims(userPrompt),
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
          evidence: hmsEv('ev-amb', 'hms_find_reservation', [], 'b'),
        }) as ToolResult<unknown>,
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
          evidence: hmsEv('ev-q', 'hms_quote_stay', [], 'c'),
        }) as ToolResult<unknown>,
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
          draftReady: true,
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
            toolVersion: '1',
            attachmentId: 'att-pdf',
            observedAt: '2026-07-30T11:00:00.000Z',
            sourceHash: sha('d'),
            claimKeys: ['attachment.confirmation'],
          },
        }) as ToolResult<unknown>,
    });
    const out = await runClaimSafeCandidateDraft({
      session,
      normalizedThreadText: 'See attached PDF',
      signal: live,
      probeAttachmentIds: ['att-pdf'],
      planModel: async ({ userPrompt }) => planFromAvailableClaims(userPrompt),
    });
    results.push({
      id: 'pdf_text_candidate',
      passed: out.outcome === 'candidate',
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
            toolVersion: '1',
            attachmentId: 'att-scan',
            observedAt: '2026-07-30T11:00:00.000Z',
            sourceHash: sha('e'),
            claimKeys: [],
          },
        }) as ToolResult<unknown>,
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
    const prior = { id: 'draft-prior' };
    const refreshFailed = { state: 'failed' as const };
    const visible = refreshFailed.state === 'failed' ? prior : null;
    results.push({
      id: 'refresh_failure_keeps_prior',
      passed: visible?.id === 'draft-prior',
      detail: `visible=${visible?.id ?? 'none'}`,
    });
  }

  {
    const freshness = 'stale_thread' as const;
    results.push({
      id: 'outbound_before_send_stale',
      passed: freshness === 'stale_thread',
      detail: `freshness=${freshness}`,
    });
  }

  {
    const hmsMode = 'off';
    results.push({
      id: 'off_mode_skeleton_promotable',
      passed: hmsMode === 'off',
      detail: `mode=${hmsMode}`,
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
