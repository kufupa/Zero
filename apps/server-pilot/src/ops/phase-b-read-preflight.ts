/**
 * Fail-closed Phase B action-specific preflight.
 * Table-driven ready codes — never starts Chromium/HMS; never invents proofs.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requestPolicyManifestSchema } from '../hms/contracts.js';
import {
  HMS_READ_TOOL_IDS,
  READ_TOOL_IDS,
  READ_TOOLS,
  capabilityStateFor,
  type CapabilityState,
  type HmsReadToolDefinition,
  type HmsReadToolId,
  type ReadToolId,
} from '../hms/read-tools.js';
import {
  hmsReadRoleProofV2Schema,
  validateRoleProofV2ForTool,
} from '../hms/release-kernel.js';

export const PHASE_B_READ_ACTIONS = [
  'read-discovery',
  'read-proof',
  'read-promote',
  'read-rollback',
] as const;

export type PhaseBReadAction = (typeof PHASE_B_READ_ACTIONS)[number];

export const PHASE_B_READY_CODES = [
  'DISCOVERY_READY',
  'PROOF_READY',
  'PROMOTE_READY',
  'ROLLBACK_READY',
] as const;

export type PhaseBReadyCode = (typeof PHASE_B_READY_CODES)[number];

export const PHASE_B_PREFLIGHT_BLOCK_CODES = [
  'BLOCKED_UNKNOWN_TOOL',
  'BLOCKED_MAIL_ARTIFACT_DISCOVERY',
  'BLOCKED_MAIL_ARTIFACT_PROOF',
  'BLOCKED_NO_SEALED_FIXTURE',
  'BLOCKED_NO_SAFE_BOOTSTRAP',
  'BLOCKED_NO_ROLE_PROOF_V2',
  'BLOCKED_ROLE_PROOF_V2_INSECURE',
  'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST',
  'BLOCKED_NO_DISCOVERY_EVIDENCE',
  'BLOCKED_NO_DRIVER_OR_CONTROLS',
  'BLOCKED_NO_IMMUTABLE_RELEASE',
  'BLOCKED_NO_LOADABLE_HANDLER',
  'BLOCKED_NO_ACTIVE_REGISTRY',
  'BLOCKED_REGISTRY_CUTOVER_PENDING',
] as const;

export type PhaseBPreflightBlockCode =
  (typeof PHASE_B_PREFLIGHT_BLOCK_CODES)[number];

export type PhaseBPreflightCode = PhaseBReadyCode | PhaseBPreflightBlockCode;

export type PhaseBPreflightResult =
  | {
      ok: true;
      action: PhaseBReadAction;
      toolId: ReadToolId;
      capabilityState: CapabilityState;
      code: PhaseBReadyCode;
      exitCode: 0;
    }
  | {
      ok: false;
      action: PhaseBReadAction | string;
      toolId: string;
      code: PhaseBPreflightBlockCode;
      exitCode: 3;
    };

const ROLE_PROOF_V2_ENV = 'HMS_READ_ROLE_PROOF_V2_PATH';
const REVIEWED_MANIFEST_ENV = 'HMS_REVIEWED_REQUEST_MANIFEST_PATH';

function isReadToolId(value: string): value is ReadToolId {
  return (READ_TOOL_IDS as readonly string[]).includes(value);
}

function isHmsReadToolId(value: string): value is HmsReadToolId {
  return (HMS_READ_TOOL_IDS as readonly string[]).includes(value);
}

function isPhaseBReadAction(value: string): value is PhaseBReadAction {
  return (PHASE_B_READ_ACTIONS as readonly string[]).includes(value);
}

function readRegularFileStat(path: string): { raw: string; mode: number; uid: number } | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return {
      raw: readFileSync(path, 'utf8'),
      mode: stat.mode,
      uid: stat.uid,
    };
  } catch {
    return null;
  }
}

/** Production role-proof file: regular, non-symlink, no write bits (0444-class). */
function roleProofFileHardened(mode: number, uid: number): boolean {
  if ((mode & 0o222) !== 0) return false;
  if ((mode & 0o400) === 0) return false;
  if (process.env.HMS_ROLE_PROOF_V2_REQUIRE_ROOT === '1') {
    if (typeof process.getuid === 'function' && uid !== 0) return false;
  }
  return true;
}

function roleProofV2Status(
  path: string | null | undefined,
  toolId: HmsReadToolId,
  now: Date,
): 'ok' | 'missing' | 'insecure' {
  if (!path || !path.trim()) return 'missing';
  const file = readRegularFileStat(path.trim());
  if (file === null) return 'missing';
  if (!roleProofFileHardened(file.mode, file.uid)) return 'insecure';
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.raw);
  } catch {
    return 'missing';
  }
  const result = hmsReadRoleProofV2Schema.safeParse(parsed);
  if (!result.success) return 'missing';
  try {
    validateRoleProofV2ForTool(result.data, READ_TOOLS[toolId], now);
  } catch {
    return 'missing';
  }
  return 'ok';
}

/**
 * Schema-only manifest presence check until Task 12 binds enabled branch /
 * discovery-op against the tool under proof. Does not assert toolId/branch match.
 */
function reviewedManifestOk(path: string | null | undefined): boolean {
  if (!path || !path.trim()) return false;
  const file = readRegularFileStat(path.trim());
  if (file === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.raw);
  } catch {
    return false;
  }
  return requestPolicyManifestSchema.safeParse(parsed).success;
}

function resolveOptionalPath(
  input: { roleProofV2Path?: string | null; reviewedRequestManifestPath?: string | null },
  key: 'roleProofV2Path' | 'reviewedRequestManifestPath',
  envName: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(input, key)) {
    const value = input[key];
    return value == null || value === '' ? null : value;
  }
  return process.env[envName] ?? null;
}

function fail(
  action: PhaseBReadAction | string,
  toolId: string,
  code: PhaseBPreflightBlockCode,
): PhaseBPreflightResult {
  return { ok: false, action, toolId, code, exitCode: 3 };
}

function ready(
  action: PhaseBReadAction,
  toolId: ReadToolId,
  code: PhaseBReadyCode,
): PhaseBPreflightResult {
  return {
    ok: true,
    action,
    toolId,
    capabilityState: capabilityStateFor(toolId),
    code,
    exitCode: 0,
  };
}

/** Sealed fixture = fixture digest present (fixture_verified or higher). */
function hasSealedFixture(toolId: ReadToolId): boolean {
  return Boolean(READ_TOOLS[toolId].evidenceRefs.fixtureDigest);
}

/**
 * Safe bootstrap for abort-first discovery: closed discovery ops + request
 * branches with control oracles. Does not require role-proof or prior digests.
 */
function hasSafeBootstrap(toolId: ReadToolId): boolean {
  if (!isHmsReadToolId(toolId)) return false;
  const tool = READ_TOOLS[toolId] as HmsReadToolDefinition;
  return (
    tool.discoveryOperationIds.length > 0 &&
    tool.requestBranches.length > 0 &&
    tool.requestBranches.every((branch) => Boolean(branch.controlOracle))
  );
}

export type PhaseBPreflightInput = {
  action: string;
  toolId: string;
  roleProofV2Path?: string | null;
  reviewedRequestManifestPath?: string | null;
  now?: Date;
  /**
   * Explicit discovery evidence (receipt/digest). Defaults false — never
   * auto-satisfied from static READ_TOOLS.evidenceRefs.discoveryDigest.
   * Inject true or wire a live artifact path (Task 12+).
   */
  discoveryEvidencePresent?: boolean;
  /** Registered driver + required controls ready for proof. */
  driverAndControlsReady?: boolean;
  /** Immutable release artifact prevalidated for promote. */
  immutableReleaseReady?: boolean;
  /** Handler for release implementationSha256 is loadable. */
  loadableHandlerReady?: boolean;
  /** Active registry readable for rollback (ignores live evidence). */
  activeRegistryReady?: boolean;
  /**
   * Find+mail seed releases active and final handler path wired.
   * Until true, read-promote returns BLOCKED_REGISTRY_CUTOVER_PENDING.
   */
  registryCutoverComplete?: boolean;
};

type GateFn = (
  action: PhaseBReadAction,
  toolId: ReadToolId,
  input: PhaseBPreflightInput,
  now: Date,
) => PhaseBPreflightResult;

const gateDiscovery: GateFn = (action, toolId) => {
  if (toolId === 'mail_read_artifact') {
    return fail(action, toolId, 'BLOCKED_MAIL_ARTIFACT_DISCOVERY');
  }
  if (!hasSealedFixture(toolId)) {
    return fail(action, toolId, 'BLOCKED_NO_SEALED_FIXTURE');
  }
  if (!hasSafeBootstrap(toolId)) {
    return fail(action, toolId, 'BLOCKED_NO_SAFE_BOOTSTRAP');
  }
  return ready(action, toolId, 'DISCOVERY_READY');
};

const gateProof: GateFn = (action, toolId, input, now) => {
  if (toolId === 'mail_read_artifact') {
    return fail(action, toolId, 'BLOCKED_MAIL_ARTIFACT_PROOF');
  }
  if (!isHmsReadToolId(toolId)) {
    return fail(action, toolId, 'BLOCKED_UNKNOWN_TOOL');
  }

  const rolePath = resolveOptionalPath(input, 'roleProofV2Path', ROLE_PROOF_V2_ENV);
  const roleStatus = roleProofV2Status(rolePath, toolId, now);
  if (roleStatus === 'missing') {
    return fail(action, toolId, 'BLOCKED_NO_ROLE_PROOF_V2');
  }
  if (roleStatus === 'insecure') {
    return fail(action, toolId, 'BLOCKED_ROLE_PROOF_V2_INSECURE');
  }

  const manifestPath = resolveOptionalPath(
    input,
    'reviewedRequestManifestPath',
    REVIEWED_MANIFEST_ENV,
  );
  if (!reviewedManifestOk(manifestPath)) {
    return fail(action, toolId, 'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST');
  }

  // Default false: static fixture discoveryDigest must not auto-satisfy proof.
  if (input.discoveryEvidencePresent !== true) {
    return fail(action, toolId, 'BLOCKED_NO_DISCOVERY_EVIDENCE');
  }

  if (input.driverAndControlsReady !== true) {
    return fail(action, toolId, 'BLOCKED_NO_DRIVER_OR_CONTROLS');
  }

  return ready(action, toolId, 'PROOF_READY');
};

const gatePromote: GateFn = (action, toolId, input) => {
  // Cutover gate first: no new Phase B tool promotes until find/mail seeds +
  // final handler path are active.
  if (input.registryCutoverComplete !== true) {
    return fail(action, toolId, 'BLOCKED_REGISTRY_CUTOVER_PENDING');
  }
  if (input.immutableReleaseReady !== true) {
    return fail(action, toolId, 'BLOCKED_NO_IMMUTABLE_RELEASE');
  }
  if (input.loadableHandlerReady !== true) {
    return fail(action, toolId, 'BLOCKED_NO_LOADABLE_HANDLER');
  }
  return ready(action, toolId, 'PROMOTE_READY');
};

const gateRollback: GateFn = (action, toolId, input) => {
  if (input.activeRegistryReady !== true) {
    return fail(action, toolId, 'BLOCKED_NO_ACTIVE_REGISTRY');
  }
  return ready(action, toolId, 'ROLLBACK_READY');
};

const ACTION_GATES: Record<PhaseBReadAction, GateFn> = {
  'read-discovery': gateDiscovery,
  'read-proof': gateProof,
  'read-promote': gatePromote,
  'read-rollback': gateRollback,
};

/**
 * Evidence preflight for Phase B tool actions — action-specific, non-circular.
 */
export function runPhaseBReadPreflight(
  input: PhaseBPreflightInput,
): PhaseBPreflightResult {
  const now = input.now ?? new Date();
  if (!isPhaseBReadAction(input.action)) {
    return fail(input.action, input.toolId, 'BLOCKED_UNKNOWN_TOOL');
  }
  const action = input.action;

  if (!isReadToolId(input.toolId)) {
    return fail(action, input.toolId, 'BLOCKED_UNKNOWN_TOOL');
  }
  const toolId = input.toolId;

  return ACTION_GATES[action](action, toolId, input, now);
}

export function formatPhaseBPreflightWaitLine(
  code: PhaseBPreflightBlockCode,
): string {
  return `HMS_WAIT code=${code}`;
}

export function formatPhaseBPreflightOkLine(code: PhaseBReadyCode): string {
  return `HMS_OK code=${code}`;
}

export function phaseBPreflightJsonRecord(result: PhaseBPreflightResult): {
  schemaVersion: 1;
  outcome: 'ok' | 'wait';
  stage: 'preflight';
  code: PhaseBPreflightCode;
  exitCode: 0 | 3;
  action: PhaseBReadAction | string;
  toolId: string;
  toolVersion: string | null;
  capabilityState: CapabilityState | null;
  retryable: false;
} {
  const toolVersion =
    result.ok || isReadToolId(result.toolId)
      ? READ_TOOLS[result.toolId as ReadToolId].version
      : null;
  return {
    schemaVersion: 1,
    outcome: result.ok ? 'ok' : 'wait',
    stage: 'preflight',
    code: result.code,
    exitCode: result.exitCode,
    action: result.action,
    toolId: result.toolId,
    toolVersion,
    capabilityState: result.ok ? result.capabilityState : null,
    retryable: false,
  };
}

function parseArgv(argv: string[]): {
  action: string;
  toolId: string;
  json: boolean;
} | null {
  if (argv.length < 2 || argv.length > 3) return null;
  const [action, toolId, maybeJson] = argv;
  if (!action || !toolId) return null;
  if (argv.length === 3 && maybeJson !== '--json') return null;
  return { action, toolId, json: maybeJson === '--json' };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgv(argv);
  if (!parsed) {
    process.stderr.write(
      'usage: phase-b-read-preflight.ts <read-discovery|read-proof|read-promote|read-rollback> <tool-id> [--json]\n',
    );
    return 2;
  }
  const result = runPhaseBReadPreflight({
    action: parsed.action,
    toolId: parsed.toolId,
  });
  if (result.ok) {
    process.stderr.write(`${formatPhaseBPreflightOkLine(result.code)}\n`);
  } else {
    process.stderr.write(`${formatPhaseBPreflightWaitLine(result.code)}\n`);
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(phaseBPreflightJsonRecord(result))}\n`);
  }
  return result.exitCode;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  process.exit(main());
}
