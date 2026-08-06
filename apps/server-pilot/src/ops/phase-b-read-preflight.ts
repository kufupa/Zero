/**
 * Fail-closed Phase B read-discovery/proof/promote/rollback preflight.
 * Named blockers only — never starts Chromium/HMS; never invents proofs.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requestPolicyManifestSchema } from '../hms/contracts.js';
import {
  READ_TOOL_IDS,
  READ_TOOLS,
  capabilityStateFor,
  type CapabilityState,
  type ReadToolId,
} from '../hms/read-tools.js';
import { hmsReadRoleProofV2Schema } from '../hms/release-kernel.js';

export const PHASE_B_READ_ACTIONS = [
  'read-discovery',
  'read-proof',
  'read-promote',
  'read-rollback',
] as const;

export type PhaseBReadAction = (typeof PHASE_B_READ_ACTIONS)[number];

export const PHASE_B_PREFLIGHT_BLOCK_CODES = [
  'BLOCKED_UNKNOWN_TOOL',
  'BLOCKED_MAIL_ARTIFACT_DISCOVERY',
  'BLOCKED_NO_ROLE_PROOF_V2',
  'BLOCKED_ROLE_PROOF_V2_INSECURE',
  'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST',
  'BLOCKED_TOOL_FIXTURE_ONLY',
  'PHASE_B_BLOCKED',
] as const;

export type PhaseBPreflightBlockCode =
  (typeof PHASE_B_PREFLIGHT_BLOCK_CODES)[number];

export type PhaseBPreflightResult =
  | {
      ok: true;
      action: PhaseBReadAction;
      toolId: ReadToolId;
      capabilityState: CapabilityState;
      /** Live browser discovery/proof still unimplemented after evidence checks. */
      code: 'PHASE_B_BLOCKED';
      exitCode: 3;
    }
  | {
      ok: false;
      action: PhaseBReadAction | string;
      toolId: string;
      code: Exclude<PhaseBPreflightBlockCode, 'PHASE_B_BLOCKED'>;
      exitCode: 3;
    };

const ROLE_PROOF_V2_ENV = 'HMS_READ_ROLE_PROOF_V2_PATH';
const REVIEWED_MANIFEST_ENV = 'HMS_REVIEWED_REQUEST_MANIFEST_PATH';

function isReadToolId(value: string): value is ReadToolId {
  return (READ_TOOL_IDS as readonly string[]).includes(value);
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
  // EC2/production: require root ownership when explicitly enabled.
  if (process.env.HMS_ROLE_PROOF_V2_REQUIRE_ROOT === '1') {
    if (typeof process.getuid === 'function' && uid !== 0) return false;
  }
  return true;
}

function roleProofV2Status(
  path: string | null | undefined,
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
  const issued = Date.parse(result.data.issuedAt);
  const expires = Date.parse(result.data.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return 'missing';
  if (issued > now.getTime() || expires <= issued) return 'missing';
  if (expires <= now.getTime()) return 'missing';
  return 'ok';
}

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

/**
 * Evidence preflight for Phase B tool actions.
 * Order: tool → role-proof-v2 → reviewed request manifest → registry capability.
 * On full evidence pass, still returns PHASE_B_BLOCKED (live action unwired).
 */
export function runPhaseBReadPreflight(input: {
  action: string;
  toolId: string;
  roleProofV2Path?: string | null;
  reviewedRequestManifestPath?: string | null;
  now?: Date;
}): PhaseBPreflightResult {
  const now = input.now ?? new Date();
  if (!isPhaseBReadAction(input.action)) {
    return {
      ok: false,
      action: input.action,
      toolId: input.toolId,
      code: 'BLOCKED_UNKNOWN_TOOL',
      exitCode: 3,
    };
  }
  const action = input.action;

  if (!isReadToolId(input.toolId)) {
    return {
      ok: false,
      action,
      toolId: input.toolId,
      code: 'BLOCKED_UNKNOWN_TOOL',
      exitCode: 3,
    };
  }
  const toolId = input.toolId;

  if (action === 'read-discovery' && toolId === 'mail_read_artifact') {
    return {
      ok: false,
      action,
      toolId,
      code: 'BLOCKED_MAIL_ARTIFACT_DISCOVERY',
      exitCode: 3,
    };
  }

  const rolePath = resolveOptionalPath(input, 'roleProofV2Path', ROLE_PROOF_V2_ENV);
  const roleStatus = roleProofV2Status(rolePath, now);
  if (roleStatus === 'missing') {
    return {
      ok: false,
      action,
      toolId,
      code: 'BLOCKED_NO_ROLE_PROOF_V2',
      exitCode: 3,
    };
  }
  if (roleStatus === 'insecure') {
    return {
      ok: false,
      action,
      toolId,
      code: 'BLOCKED_ROLE_PROOF_V2_INSECURE',
      exitCode: 3,
    };
  }

  const manifestPath = resolveOptionalPath(
    input,
    'reviewedRequestManifestPath',
    REVIEWED_MANIFEST_ENV,
  );
  if (!reviewedManifestOk(manifestPath)) {
    return {
      ok: false,
      action,
      toolId,
      code: 'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST',
      exitCode: 3,
    };
  }

  const capabilityState = capabilityStateFor(toolId);
  const refs = READ_TOOLS[toolId].evidenceRefs;
  if (capabilityState === 'fixture_verified' || !refs.discoveryDigest) {
    return {
      ok: false,
      action,
      toolId,
      code: 'BLOCKED_TOOL_FIXTURE_ONLY',
      exitCode: 3,
    };
  }

  return {
    ok: true,
    action,
    toolId,
    capabilityState,
    code: 'PHASE_B_BLOCKED',
    exitCode: 3,
  };
}

export function formatPhaseBPreflightWaitLine(
  code: PhaseBPreflightBlockCode,
): string {
  return `HMS_WAIT code=${code}`;
}

export function phaseBPreflightJsonRecord(result: PhaseBPreflightResult): {
  schemaVersion: 1;
  outcome: 'wait';
  stage: 'preflight';
  code: PhaseBPreflightBlockCode;
  exitCode: 3;
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
    outcome: 'wait',
    stage: 'preflight',
    code: result.code,
    exitCode: 3,
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
  const line = formatPhaseBPreflightWaitLine(result.code);
  process.stderr.write(`${line}\n`);
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
