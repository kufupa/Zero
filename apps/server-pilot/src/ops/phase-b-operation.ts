/**
 * Phase B atomic operation store + shared argv/terminal contracts.
 * Extracted from the live operator surface — not a second proof CLI.
 * Digests/opaque IDs only; never guest/mail/credential values.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISCOVERY_OPERATION_IDS,
  HMS_READ_TOOL_IDS,
  READ_TOOL_IDS,
  READ_TOOLS,
  type DiscoveryOperationId,
  type HmsReadToolId,
  type ReadToolId,
} from '../hms/read-tools.js';
import {
  PHASE_B_WAVE_IDS,
  PHASE_B_WAVE_TOOLS,
  type PhaseBWaveId,
} from './phase-b-status.js';
import {
  PHASE_B_READ_ACTIONS,
  type PhaseBPreflightBlockCode,
  type PhaseBReadAction,
  runPhaseBReadPreflight,
} from './phase-b-read-preflight.js';

export type PhaseBOperationStage =
  | 'created'
  | 'preflight'
  | 'candidate_snapshot'
  | 'browser'
  | 'receipt'
  | 'release'
  | 'terminal';

export type PhaseBOperationAction =
  | PhaseBReadAction
  | 'read-wave'
  | 'rearm'
  | 'doctor'
  | 'status'
  | 'artifacts'
  | 'fetch-artifact';

export type PhaseBOperationV1 = {
  schemaVersion: 1;
  operationId: string;
  supersedesOperationId: string | null;
  action: PhaseBReadAction | 'read-wave' | 'rearm';
  target:
    | { toolId: ReadToolId }
    | { waveId: PhaseBWaveId; toolIds: readonly ReadToolId[] };
  sourceRevision: string;
  inputSha256: string;
  candidateSnapshotArtifactId: string | null;
  candidateSnapshotSha256: string | null;
  cursor: number;
  stage: PhaseBOperationStage;
  leaseEpoch: number;
  lastCode: string;
  createdAt: string;
  updatedAt: string;
};

export type CandidateSnapshotV1 = {
  schemaVersion: 1;
  operationId: string;
  authorizedSourceSnapshotSha256: string;
  extractorVersion: string;
  privateDigestKeyVersion: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  sources: Array<{
    privateSourceRefId: string;
    ordinal: number;
    status: 'zero' | 'one' | 'multiple' | 'truncated' | 'unsupported' | 'failed';
    candidateIds: string[];
  }>;
  candidates: Array<{
    candidateId: string;
    sourceOrdinal: number;
    kind: string;
    canonicalValueHmacSha256: string;
  }>;
  createdAt: string;
};

export type PhaseBBlockingOwner = 'none' | 'agent' | 'external' | 'safety';
export type PhaseBRetryMode =
  | 'none'
  | 'same_operation'
  | 'after_source_change'
  | 'after_external_recovery';

export type PhaseBExitCode = 0 | 2 | 3 | 10 | 20 | 70;

export type PhaseBOperatorResult = {
  schemaVersion: 1;
  outcome: 'ok' | 'wait' | 'fail';
  action: string;
  stage: string;
  code: string;
  exitCode: PhaseBExitCode;
  blockingOwner: PhaseBBlockingOwner;
  retryMode: PhaseBRetryMode;
  operationId: string | null;
  sourceRevision: string;
  toolId: ReadToolId | null;
  waveId: PhaseBWaveId | null;
  artifactIds: string[];
  releaseId: string | null;
  elapsedMs: number;
  nextCommand: string | null;
  docsAnchor: string;
};

export type PhaseBTerminalCode =
  | 'COMPLETE'
  | 'NOOP_ALREADY_APPLIED'
  | 'NEXT_ACTION_READY'
  | 'USAGE_ERROR'
  | 'MANIFEST_SOURCE_CHANGE_REQUIRED'
  | 'AGENT_REPAIR_REQUIRED'
  | 'BLOCKED_NO_POSITIVE_CONTROL'
  | 'BLOCKED_EXTERNAL'
  | 'POLICY_OR_EVIDENCE_REJECTED'
  | 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN'
  | 'ROLLBACK_INCOMPLETE'
  | 'TRANSPORT_UNCERTAIN';

export type PreTransmissionEvidenceSource =
  | 'prior_same_fingerprint_no_write_proof'
  | 'official_semantics_plus_static_handler_map'
  | 'same_version_nonprod_no_mutation_audit';

export type PreTransmissionEvidence = {
  source: PreTransmissionEvidenceSource;
  structuralSignatureSha256: string;
};

export type RedactedStructuralCapture = {
  method: string;
  origin: string;
  path: string;
  resourceType: string;
  queryKeys: string[];
  bodyKeys: string[];
  bodyBytes: number;
  structuralSignatureSha256: string;
};

export type PhaseBParsedCommand =
  | {
      action: 'doctor';
      toolId?: ReadToolId;
      waveId?: PhaseBWaveId;
      doctorAction?: PhaseBReadAction;
      offline?: boolean;
      json: boolean;
    }
  | {
      action: 'status';
      toolId?: ReadToolId;
      waveId?: PhaseBWaveId;
      operationId?: string;
      json: boolean;
    }
  | {
      action: PhaseBReadAction;
      toolId: ReadToolId;
      resumeOperationId?: string;
      releaseId?: string;
      json: boolean;
    }
  | {
      action: 'read-wave';
      waveId: PhaseBWaveId;
      resumeOperationId?: string;
      json: boolean;
    }
  | {
      action: 'artifacts';
      toolId: ReadToolId;
      operationId?: string;
      releaseId?: string;
      latestUsable?: boolean;
      json: boolean;
    }
  | {
      action: 'fetch-artifact';
      artifactId: string;
      kind: 'receipt' | 'video' | 'trace';
      confirmSensitive: boolean;
    }
  | {
      action: 'rearm';
      toolId: ReadToolId;
      supersededOperationId: string;
      afterSource: string;
      resumeOperationId?: string;
      json: boolean;
    };

const STAGE_ORDER: readonly PhaseBOperationStage[] = [
  'created',
  'preflight',
  'candidate_snapshot',
  'browser',
  'receipt',
  'release',
  'terminal',
] as const;

const DOCS_ANCHOR =
  'docs/infor-hms/phase-b-read-portfolio-operator-runbook.md' as const;

const READ_ONLY_ACTIONS = new Set([
  'doctor',
  'status',
  'artifacts',
  'fetch-artifact',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isReadToolId(value: string): value is ReadToolId {
  return (READ_TOOL_IDS as readonly string[]).includes(value);
}

function isHmsReadToolId(value: string): value is HmsReadToolId {
  return (HMS_READ_TOOL_IDS as readonly string[]).includes(value);
}

function isWaveId(value: string): value is PhaseBWaveId {
  return (PHASE_B_WAVE_IDS as readonly string[]).includes(value);
}

function isDiscoveryOperationId(value: string): value is DiscoveryOperationId {
  return (DISCOVERY_OPERATION_IDS as readonly string[]).includes(value);
}

function isPhaseBReadAction(value: string): value is PhaseBReadAction {
  return (PHASE_B_READ_ACTIONS as readonly string[]).includes(value);
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmacSha256Hex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type NextCommandContext = {
  code: PhaseBTerminalCode;
  action: string;
  toolId?: ReadToolId | null;
  waveId?: PhaseBWaveId | null;
  operationId?: string | null;
  releaseId?: string | null;
  afterSource?: string | null;
  nextAction?: string | null;
  nextToolId?: ReadToolId | null;
  nextWaveId?: PhaseBWaveId | null;
  nextOperationId?: string | null;
  nextReleaseId?: string | null;
};

/** Shared renderer — shell-quotes real IDs; never emits placeholders. */
export function renderPhaseBNextCommand(
  ctx: NextCommandContext,
): string | null {
  const { code } = ctx;
  switch (code) {
    case 'COMPLETE':
    case 'NOOP_ALREADY_APPLIED':
    case 'USAGE_ERROR':
    case 'MANIFEST_SOURCE_CHANGE_REQUIRED':
    case 'AGENT_REPAIR_REQUIRED':
    case 'POLICY_OR_EVIDENCE_REJECTED':
    case 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN':
    case 'ROLLBACK_INCOMPLETE':
      return null;
    case 'NEXT_ACTION_READY': {
      const action = ctx.nextAction ?? ctx.action;
      if (action === 'read-wave' && (ctx.nextWaveId || ctx.waveId)) {
        const wave = ctx.nextWaveId ?? ctx.waveId!;
        const op = ctx.nextOperationId;
        return op
          ? `read-wave ${shellQuote(wave)} --resume ${shellQuote(op)} --json`
          : `read-wave ${shellQuote(wave)} --json`;
      }
      if (action === 'read-promote') {
        const tool = ctx.nextToolId ?? ctx.toolId;
        const release = ctx.nextReleaseId ?? ctx.releaseId;
        if (!tool || !release) return null;
        return `read-promote ${shellQuote(tool)} --release ${shellQuote(release)} --json`;
      }
      if (action === 'rearm') {
        const tool = ctx.nextToolId ?? ctx.toolId;
        const superseded = ctx.operationId;
        const after = ctx.afterSource;
        if (!tool || !superseded || !after) return null;
        // Successor rearm after source deploy: real revision only (no placeholders).
        return `rearm ${shellQuote(tool)} --operation ${shellQuote(superseded)} --after-source ${shellQuote(after)} --json`;
      }
      const tool = ctx.nextToolId ?? ctx.toolId;
      if (!tool) return null;
      const op = ctx.nextOperationId;
      return op
        ? `${action} ${shellQuote(tool)} --resume ${shellQuote(op)} --json`
        : `${action} ${shellQuote(tool)} --json`;
    }
    case 'BLOCKED_NO_POSITIVE_CONTROL': {
      const tool = ctx.toolId;
      if (!tool) return null;
      return `read-proof ${shellQuote(tool)} --json`;
    }
    case 'BLOCKED_EXTERNAL': {
      if (READ_ONLY_ACTIONS.has(ctx.action)) {
        if (ctx.action === 'doctor') {
          return ctx.toolId
            ? `doctor --tool ${shellQuote(ctx.toolId)} --json`
            : ctx.waveId
              ? `doctor --wave ${shellQuote(ctx.waveId)} --json`
              : 'doctor --json';
        }
        if (ctx.action === 'status') {
          if (ctx.operationId) {
            return `status --operation ${shellQuote(ctx.operationId)} --json`;
          }
          if (ctx.toolId) return `status --tool ${shellQuote(ctx.toolId)} --json`;
          if (ctx.waveId) return `status --wave ${shellQuote(ctx.waveId)} --json`;
          return 'status --json';
        }
        if (ctx.action === 'artifacts' && ctx.toolId) {
          return `artifacts ${shellQuote(ctx.toolId)} --json`;
        }
        if (ctx.action === 'fetch-artifact' && ctx.operationId) {
          return `fetch-artifact ${shellQuote(ctx.operationId)} receipt`;
        }
        return null;
      }
      if (!ctx.operationId) return null;
      if (ctx.action === 'read-wave' && ctx.waveId) {
        return `read-wave ${shellQuote(ctx.waveId)} --resume ${shellQuote(ctx.operationId)} --json`;
      }
      if (ctx.toolId) {
        return `${ctx.action} ${shellQuote(ctx.toolId)} --resume ${shellQuote(ctx.operationId)} --json`;
      }
      return null;
    }
    case 'TRANSPORT_UNCERTAIN': {
      if (READ_ONLY_ACTIONS.has(ctx.action)) return null;
      if (!ctx.operationId) return null;
      if (ctx.action === 'read-wave' && ctx.waveId) {
        return `read-wave ${shellQuote(ctx.waveId)} --resume ${shellQuote(ctx.operationId)} --json`;
      }
      if (ctx.action === 'rearm' && ctx.toolId) {
        // Same-operation resume requires real --after-source; never emit placeholders.
        if (!ctx.afterSource) return null;
        return `rearm ${shellQuote(ctx.toolId)} --operation ${shellQuote(ctx.operationId)} --after-source ${shellQuote(ctx.afterSource)} --resume ${shellQuote(ctx.operationId)} --json`;
      }
      if (ctx.toolId) {
        const release =
          ctx.action === 'read-promote' && ctx.releaseId
            ? ` --release ${shellQuote(ctx.releaseId)}`
            : '';
        return `${ctx.action} ${shellQuote(ctx.toolId)}${release} --resume ${shellQuote(ctx.operationId)} --json`;
      }
      return null;
    }
    default:
      return null;
  }
}

export function classifyTerminalOwnership(code: PhaseBTerminalCode): {
  exitCode: PhaseBExitCode;
  blockingOwner: PhaseBBlockingOwner;
  retryMode: PhaseBRetryMode;
  outcome: 'ok' | 'wait' | 'fail';
} {
  switch (code) {
    case 'COMPLETE':
    case 'NOOP_ALREADY_APPLIED':
    case 'NEXT_ACTION_READY':
      return {
        exitCode: 0,
        blockingOwner: 'none',
        retryMode: 'none',
        outcome: 'ok',
      };
    case 'USAGE_ERROR':
      return {
        exitCode: 2,
        blockingOwner: 'agent',
        retryMode: 'none',
        outcome: 'fail',
      };
    case 'MANIFEST_SOURCE_CHANGE_REQUIRED':
    case 'AGENT_REPAIR_REQUIRED':
      return {
        exitCode: 3,
        blockingOwner: 'agent',
        retryMode: 'after_source_change',
        outcome: 'wait',
      };
    case 'BLOCKED_NO_POSITIVE_CONTROL':
    case 'BLOCKED_EXTERNAL':
      return {
        exitCode: 3,
        blockingOwner: 'external',
        retryMode: 'after_external_recovery',
        outcome: 'wait',
      };
    case 'POLICY_OR_EVIDENCE_REJECTED':
    case 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN':
      return {
        exitCode: 10,
        blockingOwner: 'safety',
        retryMode: 'none',
        outcome: 'fail',
      };
    case 'ROLLBACK_INCOMPLETE':
      return {
        exitCode: 20,
        blockingOwner: 'safety',
        retryMode: 'none',
        outcome: 'fail',
      };
    case 'TRANSPORT_UNCERTAIN':
      return {
        exitCode: 70,
        blockingOwner: 'agent',
        retryMode: 'same_operation',
        outcome: 'wait',
      };
  }
}

export function buildPhaseBOperatorResult(input: {
  code: PhaseBTerminalCode;
  action: string;
  stage?: string;
  operationId?: string | null;
  sourceRevision?: string;
  toolId?: ReadToolId | null;
  waveId?: PhaseBWaveId | null;
  artifactIds?: string[];
  releaseId?: string | null;
  afterSource?: string | null;
  elapsedMs?: number;
  nextAction?: string | null;
  nextToolId?: ReadToolId | null;
  nextWaveId?: PhaseBWaveId | null;
  nextOperationId?: string | null;
  nextReleaseId?: string | null;
}): PhaseBOperatorResult {
  const ownership = classifyTerminalOwnership(input.code);
  const operationId =
    input.code === 'USAGE_ERROR' ? null : (input.operationId ?? null);
  const nextCommand = renderPhaseBNextCommand({
    code: input.code,
    action: input.action,
    toolId: input.toolId,
    waveId: input.waveId,
    operationId,
    releaseId: input.releaseId,
    afterSource: input.afterSource,
    nextAction: input.nextAction,
    nextToolId: input.nextToolId,
    nextWaveId: input.nextWaveId,
    nextOperationId: input.nextOperationId,
    nextReleaseId: input.nextReleaseId,
  });
  return {
    schemaVersion: 1,
    outcome: ownership.outcome,
    action: input.action,
    stage: input.stage ?? 'terminal',
    code: input.code,
    exitCode: ownership.exitCode,
    blockingOwner: ownership.blockingOwner,
    retryMode: ownership.retryMode,
    operationId,
    sourceRevision: input.sourceRevision ?? '',
    toolId: input.toolId ?? null,
    waveId: input.waveId ?? null,
    artifactIds: input.artifactIds ?? [],
    releaseId: input.releaseId ?? null,
    elapsedMs: input.elapsedMs ?? 0,
    nextCommand,
    docsAnchor: DOCS_ANCHOR,
  };
}

/** Canonical matrix rows for snapshot coverage. */
export function phaseBTerminalMatrixFixtures(ids: {
  toolId: ReadToolId;
  waveId: PhaseBWaveId;
  operationId: string;
  releaseId: string;
  successorOperationId: string;
  afterSource: string;
}): Array<{ label: string; result: PhaseBOperatorResult }> {
  const { toolId, waveId, operationId, releaseId, successorOperationId, afterSource } =
    ids;
  return [
    {
      label: 'COMPLETE',
      result: buildPhaseBOperatorResult({
        code: 'COMPLETE',
        action: 'read-proof',
        toolId,
        operationId,
        releaseId,
      }),
    },
    {
      label: 'NOOP_ALREADY_APPLIED',
      result: buildPhaseBOperatorResult({
        code: 'NOOP_ALREADY_APPLIED',
        action: 'read-promote',
        toolId,
        operationId,
        releaseId,
      }),
    },
    {
      label: 'NEXT_ACTION_READY_tool',
      result: buildPhaseBOperatorResult({
        code: 'NEXT_ACTION_READY',
        action: 'read-discovery',
        toolId,
        operationId,
        nextAction: 'read-proof',
        nextToolId: toolId,
        nextOperationId: operationId,
      }),
    },
    {
      label: 'NEXT_ACTION_READY_wave',
      result: buildPhaseBOperatorResult({
        code: 'NEXT_ACTION_READY',
        action: 'read-wave',
        waveId,
        operationId,
        nextAction: 'read-wave',
        nextWaveId: waveId,
        nextOperationId: operationId,
      }),
    },
    {
      label: 'USAGE_ERROR',
      result: buildPhaseBOperatorResult({
        code: 'USAGE_ERROR',
        action: 'read-discovery',
        toolId,
        operationId,
      }),
    },
    {
      label: 'MANIFEST_SOURCE_CHANGE_REQUIRED',
      result: buildPhaseBOperatorResult({
        code: 'MANIFEST_SOURCE_CHANGE_REQUIRED',
        action: 'read-discovery',
        toolId,
        operationId,
      }),
    },
    {
      label: 'AGENT_REPAIR_REQUIRED',
      result: buildPhaseBOperatorResult({
        code: 'AGENT_REPAIR_REQUIRED',
        action: 'read-proof',
        toolId,
        operationId,
      }),
    },
    {
      label: 'successor_rearm_after_deploy',
      result: buildPhaseBOperatorResult({
        code: 'NEXT_ACTION_READY',
        action: 'status',
        toolId,
        operationId,
        nextAction: 'rearm',
        nextToolId: toolId,
        afterSource,
      }),
    },
    {
      label: 'BLOCKED_NO_POSITIVE_CONTROL',
      result: buildPhaseBOperatorResult({
        code: 'BLOCKED_NO_POSITIVE_CONTROL',
        action: 'read-proof',
        toolId,
        operationId,
      }),
    },
    {
      label: 'BLOCKED_EXTERNAL_resume',
      result: buildPhaseBOperatorResult({
        code: 'BLOCKED_EXTERNAL',
        action: 'read-proof',
        toolId,
        operationId,
      }),
    },
    {
      label: 'BLOCKED_EXTERNAL_doctor',
      result: buildPhaseBOperatorResult({
        code: 'BLOCKED_EXTERNAL',
        action: 'doctor',
        toolId,
      }),
    },
    {
      label: 'POLICY_OR_EVIDENCE_REJECTED',
      result: buildPhaseBOperatorResult({
        code: 'POLICY_OR_EVIDENCE_REJECTED',
        action: 'read-proof',
        toolId,
        operationId,
      }),
    },
    {
      label: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN',
      result: buildPhaseBOperatorResult({
        code: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN',
        action: 'read-discovery',
        toolId,
        operationId,
      }),
    },
    {
      label: 'ROLLBACK_INCOMPLETE',
      result: buildPhaseBOperatorResult({
        code: 'ROLLBACK_INCOMPLETE',
        action: 'read-rollback',
        toolId,
        operationId,
      }),
    },
    {
      label: 'TRANSPORT_UNCERTAIN',
      result: buildPhaseBOperatorResult({
        code: 'TRANSPORT_UNCERTAIN',
        action: 'read-proof',
        toolId,
        operationId,
      }),
    },
    {
      label: 'TRANSPORT_UNCERTAIN_wave',
      result: buildPhaseBOperatorResult({
        code: 'TRANSPORT_UNCERTAIN',
        action: 'read-wave',
        waveId,
        operationId,
      }),
    },
    {
      label: 'rearm_successor_ids',
      result: buildPhaseBOperatorResult({
        code: 'COMPLETE',
        action: 'rearm',
        toolId,
        operationId: successorOperationId,
      }),
    },
  ];
}

function usageResult(action: string): PhaseBOperatorResult {
  return buildPhaseBOperatorResult({
    code: 'USAGE_ERROR',
    action,
    stage: 'parse',
  });
}

function takeFlag(
  args: string[],
  name: string,
): { present: boolean; value?: string; rest: string[] } {
  const out: string[] = [];
  let present = false;
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) {
      if (present) return { present: true, rest: ['__dup__'] };
      present = true;
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        return { present: true, rest: ['__missing__'] };
      }
      value = next;
      i++;
      continue;
    }
    out.push(arg);
  }
  return { present, value, rest: out };
}

function takeBoolFlag(
  args: string[],
  name: string,
): { present: boolean; rest: string[]; dup: boolean } {
  const out: string[] = [];
  let present = false;
  for (const arg of args) {
    if (arg === name) {
      if (present) return { present: true, rest: out, dup: true };
      present = true;
      continue;
    }
    out.push(arg);
  }
  return { present, rest: out, dup: false };
}

/** Shared Phase B argv parser — local before AWS and remote envelope. */
export function parsePhaseBArgv(
  argv: readonly string[],
):
  | { ok: true; command: PhaseBParsedCommand }
  | { ok: false; result: PhaseBOperatorResult } {
  if (argv.length === 0) {
    return { ok: false, result: usageResult('unknown') };
  }
  const action = argv[0]!;
  let rest = argv.slice(1);

  if (action === 'doctor') {
    const jsonF = takeBoolFlag(rest, '--json');
    if (jsonF.dup) return { ok: false, result: usageResult('doctor') };
    rest = jsonF.rest;
    const offlineF = takeBoolFlag(rest, '--offline');
    if (offlineF.dup) return { ok: false, result: usageResult('doctor') };
    rest = offlineF.rest;
    const toolF = takeFlag(rest, '--tool');
    if (toolF.rest[0] === '__dup__' || toolF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult('doctor') };
    }
    rest = toolF.rest;
    const waveF = takeFlag(rest, '--wave');
    if (waveF.rest[0] === '__dup__' || waveF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult('doctor') };
    }
    rest = waveF.rest;
    const actionF = takeFlag(rest, '--action');
    if (actionF.rest[0] === '__dup__' || actionF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult('doctor') };
    }
    rest = actionF.rest;
    if (rest.length > 0) return { ok: false, result: usageResult('doctor') };
    if (toolF.present && waveF.present) {
      return { ok: false, result: usageResult('doctor') };
    }
    if (actionF.present && !toolF.present) {
      return { ok: false, result: usageResult('doctor') };
    }
    if (toolF.present && !isReadToolId(toolF.value!)) {
      return { ok: false, result: usageResult('doctor') };
    }
    if (waveF.present && !isWaveId(waveF.value!)) {
      return { ok: false, result: usageResult('doctor') };
    }
    if (actionF.present && !isPhaseBReadAction(actionF.value!)) {
      return { ok: false, result: usageResult('doctor') };
    }
    return {
      ok: true,
      command: {
        action: 'doctor',
        toolId: toolF.present ? (toolF.value as ReadToolId) : undefined,
        waveId: waveF.present ? (waveF.value as PhaseBWaveId) : undefined,
        doctorAction: actionF.present
          ? (actionF.value as PhaseBReadAction)
          : undefined,
        offline: offlineF.present,
        json: jsonF.present,
      },
    };
  }

  if (action === 'status') {
    const jsonF = takeBoolFlag(rest, '--json');
    if (jsonF.dup) return { ok: false, result: usageResult('status') };
    rest = jsonF.rest;
    const toolF = takeFlag(rest, '--tool');
    if (toolF.rest[0] === '__dup__' || toolF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult('status') };
    }
    rest = toolF.rest;
    const waveF = takeFlag(rest, '--wave');
    if (waveF.rest[0] === '__dup__' || waveF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult('status') };
    }
    rest = waveF.rest;
    const opF = takeFlag(rest, '--operation');
    if (opF.rest[0] === '__dup__' || opF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult('status') };
    }
    rest = opF.rest;
    if (rest.length > 0) return { ok: false, result: usageResult('status') };
    const scopes = [toolF.present, waveF.present, opF.present].filter(Boolean);
    if (scopes.length > 1) return { ok: false, result: usageResult('status') };
    if (toolF.present && !isReadToolId(toolF.value!)) {
      return { ok: false, result: usageResult('status') };
    }
    if (waveF.present && !isWaveId(waveF.value!)) {
      return { ok: false, result: usageResult('status') };
    }
    if (opF.present && !UUID_RE.test(opF.value!)) {
      return { ok: false, result: usageResult('status') };
    }
    return {
      ok: true,
      command: {
        action: 'status',
        toolId: toolF.present ? (toolF.value as ReadToolId) : undefined,
        waveId: waveF.present ? (waveF.value as PhaseBWaveId) : undefined,
        operationId: opF.present ? opF.value : undefined,
        json: jsonF.present,
      },
    };
  }

  if (isPhaseBReadAction(action)) {
    if (rest.length === 0) return { ok: false, result: usageResult(action) };
    const toolId = rest[0]!;
    rest = rest.slice(1);
    if (!isReadToolId(toolId)) return { ok: false, result: usageResult(action) };
    if (action === 'read-discovery' && toolId === 'mail_read_artifact') {
      return { ok: false, result: usageResult(action) };
    }
    const jsonF = takeBoolFlag(rest, '--json');
    if (jsonF.dup) return { ok: false, result: usageResult(action) };
    rest = jsonF.rest;
    const resumeF = takeFlag(rest, '--resume');
    if (resumeF.rest[0] === '__dup__' || resumeF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = resumeF.rest;
    const releaseF = takeFlag(rest, '--release');
    if (releaseF.rest[0] === '__dup__' || releaseF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = releaseF.rest;
    if (rest.length > 0) return { ok: false, result: usageResult(action) };
    if (resumeF.present && !UUID_RE.test(resumeF.value!)) {
      return { ok: false, result: usageResult(action) };
    }
    if (action === 'read-promote') {
      if (!releaseF.present || !UUID_RE.test(releaseF.value!)) {
        return { ok: false, result: usageResult(action) };
      }
    } else if (releaseF.present) {
      return { ok: false, result: usageResult(action) };
    }
    return {
      ok: true,
      command: {
        action,
        toolId,
        resumeOperationId: resumeF.present ? resumeF.value : undefined,
        releaseId: releaseF.present ? releaseF.value : undefined,
        json: jsonF.present,
      },
    };
  }

  if (action === 'read-wave') {
    if (rest.length === 0) return { ok: false, result: usageResult(action) };
    const waveId = rest[0]!;
    rest = rest.slice(1);
    if (!isWaveId(waveId)) return { ok: false, result: usageResult(action) };
    const jsonF = takeBoolFlag(rest, '--json');
    if (jsonF.dup) return { ok: false, result: usageResult(action) };
    rest = jsonF.rest;
    const resumeF = takeFlag(rest, '--resume');
    if (resumeF.rest[0] === '__dup__' || resumeF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = resumeF.rest;
    // Legacy bare --resume (no UUID) rejected — must be --resume <uuid>.
    const bareResume = takeBoolFlag(rest, '--resume');
    if (bareResume.present || bareResume.dup) {
      return { ok: false, result: usageResult(action) };
    }
    rest = bareResume.rest;
    if (rest.length > 0) return { ok: false, result: usageResult(action) };
    if (resumeF.present && !UUID_RE.test(resumeF.value!)) {
      return { ok: false, result: usageResult(action) };
    }
    return {
      ok: true,
      command: {
        action: 'read-wave',
        waveId,
        resumeOperationId: resumeF.present ? resumeF.value : undefined,
        json: jsonF.present,
      },
    };
  }

  if (action === 'artifacts') {
    if (rest.length === 0) return { ok: false, result: usageResult(action) };
    const toolId = rest[0]!;
    rest = rest.slice(1);
    if (!isReadToolId(toolId)) return { ok: false, result: usageResult(action) };
    const jsonF = takeBoolFlag(rest, '--json');
    if (jsonF.dup) return { ok: false, result: usageResult(action) };
    rest = jsonF.rest;
    const latestF = takeBoolFlag(rest, '--latest-usable');
    if (latestF.dup) return { ok: false, result: usageResult(action) };
    rest = latestF.rest;
    // Keep legacy --latest as alias for usability during Task 12 transition.
    const legacyLatest = takeBoolFlag(rest, '--latest');
    if (legacyLatest.dup) return { ok: false, result: usageResult(action) };
    rest = legacyLatest.rest;
    const opF = takeFlag(rest, '--operation');
    if (opF.rest[0] === '__dup__' || opF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = opF.rest;
    const relF = takeFlag(rest, '--release');
    if (relF.rest[0] === '__dup__' || relF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = relF.rest;
    if (rest.length > 0) return { ok: false, result: usageResult(action) };
    const scopes = [
      latestF.present || legacyLatest.present,
      opF.present,
      relF.present,
    ].filter(Boolean);
    if (scopes.length > 1) return { ok: false, result: usageResult(action) };
    if (opF.present && !UUID_RE.test(opF.value!)) {
      return { ok: false, result: usageResult(action) };
    }
    if (relF.present && !UUID_RE.test(relF.value!)) {
      return { ok: false, result: usageResult(action) };
    }
    return {
      ok: true,
      command: {
        action: 'artifacts',
        toolId,
        operationId: opF.present ? opF.value : undefined,
        releaseId: relF.present ? relF.value : undefined,
        latestUsable: latestF.present || legacyLatest.present,
        json: jsonF.present,
      },
    };
  }

  if (action === 'fetch-artifact') {
    if (rest.length < 2 || rest.length > 3) {
      return { ok: false, result: usageResult(action) };
    }
    const artifactId = rest[0]!;
    const kind = rest[1]!;
    const confirm = rest[2];
    if (!UUID_RE.test(artifactId)) {
      return { ok: false, result: usageResult(action) };
    }
    if (kind !== 'receipt' && kind !== 'video' && kind !== 'trace') {
      return { ok: false, result: usageResult(action) };
    }
    if (kind === 'receipt' || kind === 'video') {
      if (confirm !== undefined) {
        return { ok: false, result: usageResult(action) };
      }
      return {
        ok: true,
        command: {
          action: 'fetch-artifact',
          artifactId,
          kind,
          confirmSensitive: false,
        },
      };
    }
    if (confirm !== '--confirm-sensitive') {
      return { ok: false, result: usageResult(action) };
    }
    return {
      ok: true,
      command: {
        action: 'fetch-artifact',
        artifactId,
        kind: 'trace',
        confirmSensitive: true,
      },
    };
  }

  if (action === 'rearm') {
    if (rest.length === 0) return { ok: false, result: usageResult(action) };
    const toolId = rest[0]!;
    rest = rest.slice(1);
    if (!isReadToolId(toolId)) return { ok: false, result: usageResult(action) };
    const jsonF = takeBoolFlag(rest, '--json');
    if (jsonF.dup) return { ok: false, result: usageResult(action) };
    rest = jsonF.rest;
    const opF = takeFlag(rest, '--operation');
    if (opF.rest[0] === '__dup__' || opF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = opF.rest;
    const afterF = takeFlag(rest, '--after-source');
    if (afterF.rest[0] === '__dup__' || afterF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = afterF.rest;
    const resumeF = takeFlag(rest, '--resume');
    if (resumeF.rest[0] === '__dup__' || resumeF.rest[0] === '__missing__') {
      return { ok: false, result: usageResult(action) };
    }
    rest = resumeF.rest;
    if (rest.length > 0) return { ok: false, result: usageResult(action) };
    if (!opF.present || !UUID_RE.test(opF.value!)) {
      return { ok: false, result: usageResult(action) };
    }
    if (!afterF.present || !afterF.value) {
      return { ok: false, result: usageResult(action) };
    }
    if (resumeF.present && !UUID_RE.test(resumeF.value!)) {
      return { ok: false, result: usageResult(action) };
    }
    return {
      ok: true,
      command: {
        action: 'rearm',
        toolId,
        supersededOperationId: opF.value!,
        afterSource: afterF.value!,
        resumeOperationId: resumeF.present ? resumeF.value : undefined,
        json: jsonF.present,
      },
    };
  }

  return { ok: false, result: usageResult(action) };
}

/** One canonical remote envelope — no second Phase B case grammar. */
export type PhaseBCanonicalEnvelope = {
  schemaVersion: 1;
  kind: 'phase_b_operator';
  awsAccountId: string;
  awsRegion: string;
  instanceId: string;
  sourceRevision: string;
  operationId: string;
  command: PhaseBParsedCommand;
  inputSha256: string;
};

export function buildCanonicalCommandEnvelope(input: {
  command: PhaseBParsedCommand;
  operationId: string;
  sourceRevision: string;
  awsAccountId: string;
  awsRegion: string;
  instanceId: string;
}): PhaseBCanonicalEnvelope {
  const body = {
    schemaVersion: 1 as const,
    kind: 'phase_b_operator' as const,
    awsAccountId: input.awsAccountId,
    awsRegion: input.awsRegion,
    instanceId: input.instanceId,
    sourceRevision: input.sourceRevision,
    operationId: input.operationId,
    command: input.command,
  };
  return {
    ...body,
    inputSha256: sha256Hex(JSON.stringify(body)),
  };
}

export function resolveClosedDiscoveryOperation(
  toolId: HmsReadToolId,
  discoveryOperationId: string,
):
  | { ok: true; discoveryOperationId: DiscoveryOperationId }
  | { ok: false; code: 'UNKNOWN_DISCOVERY_OPERATION' | 'TOOL_DISCOVERY_MISMATCH' } {
  if (!isDiscoveryOperationId(discoveryOperationId)) {
    return { ok: false, code: 'UNKNOWN_DISCOVERY_OPERATION' };
  }
  const tool = READ_TOOLS[toolId];
  if (!('discoveryOperationIds' in tool) || !tool.discoveryOperationIds) {
    return { ok: false, code: 'TOOL_DISCOVERY_MISMATCH' };
  }
  if (!tool.discoveryOperationIds.includes(discoveryOperationId)) {
    return { ok: false, code: 'TOOL_DISCOVERY_MISMATCH' };
  }
  return { ok: true, discoveryOperationId };
}

export function rejectArbitraryDiscoveryCliInput(input: {
  url?: string;
  selector?: string;
  method?: string;
  body?: string;
  action?: string;
}): PhaseBOperatorResult | null {
  if (
    input.url !== undefined ||
    input.selector !== undefined ||
    input.method !== undefined ||
    input.body !== undefined ||
    (input.action !== undefined &&
      !isDiscoveryOperationId(input.action) &&
      !isPhaseBReadAction(input.action))
  ) {
    return buildPhaseBOperatorResult({
      code: 'USAGE_ERROR',
      action: 'read-discovery',
      stage: 'parse',
    });
  }
  return null;
}

export function structuralSignatureSha256(
  capture: Omit<RedactedStructuralCapture, 'structuralSignatureSha256'>,
): string {
  return sha256Hex(
    JSON.stringify({
      method: capture.method,
      origin: capture.origin,
      path: capture.path,
      resourceType: capture.resourceType,
      queryKeys: [...capture.queryKeys].sort(),
      bodyKeys: [...capture.bodyKeys].sort(),
      bodyBytes: capture.bodyBytes,
    }),
  );
}

export function abortUnknownRequest(input: {
  method: string;
  origin: string;
  path: string;
  resourceType: string;
  queryKeys?: string[];
  bodyKeys?: string[];
  bodyBytes?: number;
}): {
  aborted: true;
  capture: RedactedStructuralCapture;
} {
  const base = {
    method: input.method,
    origin: input.origin,
    path: input.path,
    resourceType: input.resourceType,
    queryKeys: input.queryKeys ?? [],
    bodyKeys: input.bodyKeys ?? [],
    bodyBytes: input.bodyBytes ?? 0,
  };
  return {
    aborted: true,
    capture: {
      ...base,
      structuralSignatureSha256: structuralSignatureSha256(base),
    },
  };
}

export function evaluatePreTransmissionEvidence(input: {
  evidence: PreTransmissionEvidence | null;
  observedStructuralSignatureSha256: string;
}):
  | { ok: true }
  | { ok: false; code: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN' } {
  if (!input.evidence) {
    return { ok: false, code: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN' };
  }
  if (
    input.evidence.structuralSignatureSha256 !==
    input.observedStructuralSignatureSha256
  ) {
    return { ok: false, code: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN' };
  }
  const allowed: PreTransmissionEvidenceSource[] = [
    'prior_same_fingerprint_no_write_proof',
    'official_semantics_plus_static_handler_map',
    'same_version_nonprod_no_mutation_audit',
  ];
  if (!allowed.includes(input.evidence.source)) {
    return { ok: false, code: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN' };
  }
  return { ok: true };
}

export type ControlOracleAcquisition = {
  kind: 'authorized_source_artifact' | 'preexisting_record' | 'independent_rendered_observation';
  acquisitionOperationId: DiscoveryOperationId;
  sealedAt: string;
  provenanceSha256: string;
  freshnessExpiresAt: string;
  bindings: {
    buildCommit: string;
    credentialVersionHmacSha256: string;
    runtimeFingerprintSha256: string;
    propertyCode: string;
    roleSurfaceId: string;
    branchId: string;
    candidateKind: string;
    envelopeClass: string;
  };
};

export function acquireControlOracle(input: {
  toolId: HmsReadToolId;
  branchId: string;
  /** Injected sealed observation — never call extractor/driver under test. */
  sealedObservation: {
    observedAt: string;
    provenanceMaterial: string;
  } | null;
  buildCommit: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  now?: Date;
}):
  | { ok: true; oracle: ControlOracleAcquisition }
  | { ok: false; code: 'BLOCKED_NO_POSITIVE_CONTROL' } {
  const tool = READ_TOOLS[input.toolId];
  if (!('requestBranches' in tool) || !tool.requestBranches) {
    return { ok: false, code: 'BLOCKED_NO_POSITIVE_CONTROL' };
  }
  const branch = tool.requestBranches.find((b) => b.id === input.branchId);
  if (!branch || !input.sealedObservation) {
    return { ok: false, code: 'BLOCKED_NO_POSITIVE_CONTROL' };
  }
  const now = input.now ?? new Date();
  const sealedAt = new Date(input.sealedObservation.observedAt);
  if (Number.isNaN(sealedAt.getTime())) {
    return { ok: false, code: 'BLOCKED_NO_POSITIVE_CONTROL' };
  }
  const age = now.getTime() - sealedAt.getTime();
  if (age < 0 || age > branch.controlOracle.maxAgeMs) {
    return { ok: false, code: 'BLOCKED_NO_POSITIVE_CONTROL' };
  }
  return {
    ok: true,
    oracle: {
      kind: branch.controlOracle.kind,
      acquisitionOperationId: branch.controlOracle.acquisitionOperationId,
      sealedAt: sealedAt.toISOString(),
      provenanceSha256: sha256Hex(input.sealedObservation.provenanceMaterial),
      freshnessExpiresAt: new Date(
        sealedAt.getTime() + branch.controlOracle.maxAgeMs,
      ).toISOString(),
      bindings: {
        buildCommit: input.buildCommit,
        credentialVersionHmacSha256: input.credentialVersionHmacSha256,
        runtimeFingerprintSha256: input.runtimeFingerprintSha256,
        propertyCode: 'HRCEN',
        roleSurfaceId: branch.requiredRoleSurfaces[0]!,
        branchId: branch.id,
        candidateKind: 'exact',
        envelopeClass: 'control_oracle_v1',
      },
    },
  };
}

export type OperationLease = {
  operationId: string;
  leaseEpoch: number;
  ownerToken: string;
  expiresAt: string;
  stage: PhaseBOperationStage;
};

export type PhaseBOperationStoreOptions = {
  rootDir: string;
  now?: () => Date;
  leaseTtlMs?: number;
};

type StoredTerminal = {
  inputSha256: string;
  result: PhaseBOperatorResult;
};

type StoredOperation = {
  operation: PhaseBOperationV1;
  lease: OperationLease | null;
  terminal: StoredTerminal | null;
  snapshot: CandidateSnapshotV1 | null;
  policyUnresolved: boolean;
};

function stageIndex(stage: PhaseBOperationStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** Atomic on-disk operation ledger with fenced lease claim/reclaim. */
export class PhaseBOperationStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;

  constructor(options: PhaseBOperationStoreOptions) {
    this.root = options.rootDir;
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 15 * 60 * 1000;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private opDir(operationId: string): string {
    return join(this.root, 'operations', operationId);
  }

  private opPath(operationId: string): string {
    return join(this.opDir(operationId), 'operation.v1.json');
  }

  private writeAtomic(path: string, value: unknown, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode, flag: 'w' });
    renameSync(tmp, path);
    chmodSync(path, mode);
  }

  private readStored(operationId: string): StoredOperation | null {
    const path = this.opPath(operationId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as StoredOperation;
  }

  private writeStored(stored: StoredOperation): void {
    this.writeAtomic(this.opPath(stored.operation.operationId), stored);
  }

  create(input: {
    operationId?: string;
    action: PhaseBReadAction | 'read-wave' | 'rearm';
    target:
      | { toolId: ReadToolId }
      | { waveId: PhaseBWaveId; toolIds: readonly ReadToolId[] };
    sourceRevision: string;
    inputDigestMaterial: unknown;
    supersedesOperationId?: string | null;
  }): PhaseBOperationV1 {
    const now = this.now().toISOString();
    const operationId = input.operationId ?? randomUUID();
    const operation: PhaseBOperationV1 = {
      schemaVersion: 1,
      operationId,
      supersedesOperationId: input.supersedesOperationId ?? null,
      action: input.action,
      target: input.target,
      sourceRevision: input.sourceRevision,
      inputSha256: sha256Hex(JSON.stringify(input.inputDigestMaterial)),
      candidateSnapshotArtifactId: null,
      candidateSnapshotSha256: null,
      cursor: 0,
      stage: 'created',
      leaseEpoch: 0,
      lastCode: 'CREATED',
      createdAt: now,
      updatedAt: now,
    };
    this.writeStored({
      operation,
      lease: null,
      terminal: null,
      snapshot: null,
      policyUnresolved: false,
    });
    return operation;
  }

  /**
   * Same operation ID + input digest attaches or returns cached terminal.
   * Live lease attaches/polls — never launches duplicate browser work.
   */
  attachOrCachedTerminal(input: {
    operationId: string;
    inputSha256: string;
    ownerToken: string;
  }):
    | { kind: 'cached'; result: PhaseBOperatorResult }
    | { kind: 'attached'; operation: PhaseBOperationV1; lease: OperationLease }
    | { kind: 'busy'; operation: PhaseBOperationV1 }
    | { kind: 'missing' }
    | { kind: 'input_mismatch' } {
    const stored = this.readStored(input.operationId);
    if (!stored) return { kind: 'missing' };
    if (stored.operation.inputSha256 !== input.inputSha256) {
      return { kind: 'input_mismatch' };
    }
    if (stored.terminal) {
      return { kind: 'cached', result: stored.terminal.result };
    }
    const now = this.now();
    if (
      stored.lease &&
      new Date(stored.lease.expiresAt).getTime() > now.getTime() &&
      stored.lease.ownerToken !== input.ownerToken
    ) {
      return { kind: 'busy', operation: stored.operation };
    }
    if (
      stored.lease &&
      new Date(stored.lease.expiresAt).getTime() <= now.getTime()
    ) {
      // Stale lease — fenced reclaim bumps epoch.
      stored.operation.leaseEpoch += 1;
    } else if (!stored.lease) {
      stored.operation.leaseEpoch = Math.max(1, stored.operation.leaseEpoch);
    }
    const lease: OperationLease = {
      operationId: stored.operation.operationId,
      leaseEpoch: stored.operation.leaseEpoch,
      ownerToken: input.ownerToken,
      expiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
      stage: stored.operation.stage,
    };
    stored.lease = lease;
    stored.operation.updatedAt = now.toISOString();
    this.writeStored(stored);
    return { kind: 'attached', operation: stored.operation, lease };
  }

  transitionStage(input: {
    operationId: string;
    ownerToken: string;
    expectedEpoch: number;
    nextStage: PhaseBOperationStage;
    cursor?: number;
    lastCode?: string;
  }):
    | { ok: true; operation: PhaseBOperationV1 }
    | {
        ok: false;
        code:
          | 'LEASE_MISMATCH'
          | 'STAGE_SKIP'
          | 'STAGE_REWIND'
          | 'CURSOR_DRIFT'
          | 'MISSING';
      } {
    const stored = this.readStored(input.operationId);
    if (!stored) return { ok: false, code: 'MISSING' };
    if (
      !stored.lease ||
      stored.lease.ownerToken !== input.ownerToken ||
      stored.lease.leaseEpoch !== input.expectedEpoch
    ) {
      return { ok: false, code: 'LEASE_MISMATCH' };
    }
    if (stored.operation.stage === 'terminal') {
      return { ok: false, code: 'STAGE_REWIND' };
    }
    const cur = stageIndex(stored.operation.stage);
    const next = stageIndex(input.nextStage);
    if (next < cur) return { ok: false, code: 'STAGE_REWIND' };
    if (next > cur + 1) return { ok: false, code: 'STAGE_SKIP' };
    if (
      input.cursor !== undefined &&
      input.cursor !== stored.operation.cursor &&
      input.cursor !== stored.operation.cursor + 1
    ) {
      return { ok: false, code: 'CURSOR_DRIFT' };
    }
    stored.operation.stage = input.nextStage;
    if (input.cursor !== undefined) stored.operation.cursor = input.cursor;
    if (input.lastCode) stored.operation.lastCode = input.lastCode;
    stored.operation.updatedAt = this.now().toISOString();
    stored.lease.stage = input.nextStage;
    this.writeStored(stored);
    return { ok: true, operation: stored.operation };
  }

  writeCandidateSnapshot(input: {
    operationId: string;
    ownerToken: string;
    expectedEpoch: number;
    snapshot: Omit<CandidateSnapshotV1, 'schemaVersion' | 'operationId' | 'createdAt'>;
  }):
    | { ok: true; snapshot: CandidateSnapshotV1; sha256: string }
    | {
        ok: false;
        code: 'LEASE_MISMATCH' | 'SOURCE_ACCOUNTING_GAP' | 'MISSING' | 'STAGE_SKIP';
      } {
    const stored = this.readStored(input.operationId);
    if (!stored) return { ok: false, code: 'MISSING' };
    if (
      !stored.lease ||
      stored.lease.ownerToken !== input.ownerToken ||
      stored.lease.leaseEpoch !== input.expectedEpoch
    ) {
      return { ok: false, code: 'LEASE_MISMATCH' };
    }
    if (
      stored.operation.stage !== 'preflight' &&
      stored.operation.stage !== 'candidate_snapshot'
    ) {
      return { ok: false, code: 'STAGE_SKIP' };
    }
    const ordinals = new Set(input.snapshot.sources.map((s) => s.ordinal));
    for (let i = 0; i < input.snapshot.sources.length; i++) {
      if (!ordinals.has(i)) return { ok: false, code: 'SOURCE_ACCOUNTING_GAP' };
    }
    for (const candidate of input.snapshot.candidates) {
      const source = input.snapshot.sources.find(
        (s) => s.ordinal === candidate.sourceOrdinal,
      );
      if (!source || !source.candidateIds.includes(candidate.candidateId)) {
        return { ok: false, code: 'SOURCE_ACCOUNTING_GAP' };
      }
    }
    const snapshot: CandidateSnapshotV1 = {
      schemaVersion: 1,
      operationId: input.operationId,
      createdAt: this.now().toISOString(),
      ...input.snapshot,
    };
    const sha256 = sha256Hex(JSON.stringify(snapshot));
    const artifactId = randomUUID();
    const snapPath = join(
      this.opDir(input.operationId),
      'candidate-snapshot.v1.json',
    );
    // Root-owned protected sidecar semantics: mode 0444 after write.
    this.writeAtomic(snapPath, snapshot, 0o444);
    stored.snapshot = snapshot;
    stored.operation.candidateSnapshotArtifactId = artifactId;
    stored.operation.candidateSnapshotSha256 = sha256;
    stored.operation.stage = 'candidate_snapshot';
    stored.operation.updatedAt = this.now().toISOString();
    stored.lease.stage = 'candidate_snapshot';
    this.writeStored(stored);
    return { ok: true, snapshot, sha256 };
  }

  /**
   * Resume reauthorizes opaque source refs, reloads credential/key/runtime,
   * reruns same extractor version, verifies HMACs, restores UUID mapping.
   */
  resumeFromSnapshot(input: {
    operationId: string;
    authorizedSourceSnapshotSha256: string;
    extractorVersion: string;
    privateDigestKeyVersion: string;
    credentialVersionHmacSha256: string;
    runtimeFingerprintSha256: string;
    reauthorize: (privateSourceRefId: string) => string | null;
    canonicalValueFor: (candidateId: string) => string | null;
    hmacKey: string | Buffer;
  }):
    | { ok: true; snapshot: CandidateSnapshotV1; mapping: Map<string, string> }
    | {
        ok: false;
        code:
          | 'MISSING'
          | 'SNAPSHOT_DRIFT'
          | 'SOURCE_REAUTH_FAILED'
          | 'HMAC_MISMATCH'
          | 'CREDENTIAL_DRIFT'
          | 'KEY_DRIFT'
          | 'RUNTIME_DRIFT'
          | 'EXTRACTOR_DRIFT';
      } {
    const stored = this.readStored(input.operationId);
    if (!stored?.snapshot) return { ok: false, code: 'MISSING' };
    const snap = stored.snapshot;
    if (
      snap.authorizedSourceSnapshotSha256 !==
      input.authorizedSourceSnapshotSha256
    ) {
      return { ok: false, code: 'SNAPSHOT_DRIFT' };
    }
    if (snap.extractorVersion !== input.extractorVersion) {
      return { ok: false, code: 'EXTRACTOR_DRIFT' };
    }
    if (snap.privateDigestKeyVersion !== input.privateDigestKeyVersion) {
      return { ok: false, code: 'KEY_DRIFT' };
    }
    if (
      snap.credentialVersionHmacSha256 !== input.credentialVersionHmacSha256
    ) {
      return { ok: false, code: 'CREDENTIAL_DRIFT' };
    }
    if (snap.runtimeFingerprintSha256 !== input.runtimeFingerprintSha256) {
      return { ok: false, code: 'RUNTIME_DRIFT' };
    }
    const mapping = new Map<string, string>();
    for (const source of snap.sources) {
      const reauthed = input.reauthorize(source.privateSourceRefId);
      if (!reauthed) return { ok: false, code: 'SOURCE_REAUTH_FAILED' };
      mapping.set(source.privateSourceRefId, reauthed);
    }
    for (const candidate of snap.candidates) {
      const value = input.canonicalValueFor(candidate.candidateId);
      if (value == null) return { ok: false, code: 'HMAC_MISMATCH' };
      const digest = hmacSha256Hex(input.hmacKey, value);
      if (digest !== candidate.canonicalValueHmacSha256) {
        return { ok: false, code: 'HMAC_MISMATCH' };
      }
    }
    return { ok: true, snapshot: snap, mapping };
  }

  completeTerminal(input: {
    operationId: string;
    ownerToken: string;
    expectedEpoch: number;
    result: PhaseBOperatorResult;
    policyUnresolved?: boolean;
  }):
    | { ok: true }
    | { ok: false; code: 'LEASE_MISMATCH' | 'MISSING' } {
    const stored = this.readStored(input.operationId);
    if (!stored) return { ok: false, code: 'MISSING' };
    if (
      !stored.lease ||
      stored.lease.ownerToken !== input.ownerToken ||
      stored.lease.leaseEpoch !== input.expectedEpoch
    ) {
      return { ok: false, code: 'LEASE_MISMATCH' };
    }
    stored.operation.stage = 'terminal';
    stored.operation.lastCode = input.result.code;
    stored.operation.updatedAt = this.now().toISOString();
    stored.terminal = {
      inputSha256: stored.operation.inputSha256,
      result: input.result,
    };
    stored.lease = null;
    stored.policyUnresolved =
      input.policyUnresolved ?? stored.policyUnresolved;
    this.writeStored(stored);
    return { ok: true };
  }

  markPolicyUnresolved(operationId: string, unresolved: boolean): void {
    const stored = this.readStored(operationId);
    if (!stored) return;
    stored.policyUnresolved = unresolved;
    this.writeStored(stored);
  }

  /**
   * Scoped rearm after source change. Never waives unresolved policy/evidence.
   * Requires changed deployed revision; closes old; returns successor.
   */
  rearmAfterSource(input: {
    supersededOperationId: string;
    toolId: ReadToolId;
    newSourceRevision: string;
    newOperationId?: string;
    inputDigestMaterial: unknown;
  }):
    | { ok: true; successor: PhaseBOperationV1 }
    | {
        ok: false;
        code:
          | 'MISSING'
          | 'SOURCE_UNCHANGED'
          | 'POLICY_UNRESOLVED'
          | 'TOOL_MISMATCH';
      } {
    const stored = this.readStored(input.supersededOperationId);
    if (!stored) return { ok: false, code: 'MISSING' };
    if (stored.policyUnresolved) {
      return { ok: false, code: 'POLICY_UNRESOLVED' };
    }
    if (
      stored.operation.target &&
      'toolId' in stored.operation.target &&
      stored.operation.target.toolId !== input.toolId
    ) {
      return { ok: false, code: 'TOOL_MISMATCH' };
    }
    if (stored.operation.sourceRevision === input.newSourceRevision) {
      return { ok: false, code: 'SOURCE_UNCHANGED' };
    }
    if (stored.operation.stage !== 'terminal') {
      const result = buildPhaseBOperatorResult({
        code: 'COMPLETE',
        action: 'rearm',
        toolId: input.toolId,
        operationId: stored.operation.operationId,
        sourceRevision: stored.operation.sourceRevision,
        stage: 'terminal',
      });
      stored.operation.stage = 'terminal';
      stored.operation.lastCode = 'SUPERSEDED';
      stored.operation.updatedAt = this.now().toISOString();
      stored.terminal = {
        inputSha256: stored.operation.inputSha256,
        result,
      };
      stored.lease = null;
      this.writeStored(stored);
    } else {
      stored.operation.lastCode = 'SUPERSEDED';
      stored.operation.updatedAt = this.now().toISOString();
      this.writeStored(stored);
    }
    const successor = this.create({
      operationId: input.newOperationId,
      action: 'rearm',
      target: { toolId: input.toolId },
      sourceRevision: input.newSourceRevision,
      inputDigestMaterial: input.inputDigestMaterial,
      supersedesOperationId: input.supersededOperationId,
    });
    return { ok: true, successor };
  }

  get(operationId: string): PhaseBOperationV1 | null {
    return this.readStored(operationId)?.operation ?? null;
  }

  getSnapshot(operationId: string): CandidateSnapshotV1 | null {
    return this.readStored(operationId)?.snapshot ?? null;
  }

  listOperationIds(): string[] {
    const dir = join(this.root, 'operations');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) =>
      existsSync(join(dir, name, 'operation.v1.json')),
    );
  }
}

export type ProofInstallCounters = {
  unknownRequests: number;
  mutationRequests: number;
  popupCount: number;
  downloadCount: number;
  webSocketCount: number;
};

/** Atomic root 0444 proof install only after zero unsafe counters. */
export function installRoleProofAtomic(input: {
  path: string;
  body: unknown;
  counters: ProofInstallCounters;
  requireRoot?: boolean;
}):
  | { ok: true }
  | { ok: false; code: 'UNSAFE_COUNTERS' | 'ROOT_REQUIRED' } {
  const c = input.counters;
  if (
    c.unknownRequests !== 0 ||
    c.mutationRequests !== 0 ||
    c.popupCount !== 0 ||
    c.downloadCount !== 0 ||
    c.webSocketCount !== 0
  ) {
    return { ok: false, code: 'UNSAFE_COUNTERS' };
  }
  if (
    input.requireRoot &&
    typeof process.getuid === 'function' &&
    process.getuid() !== 0
  ) {
    return { ok: false, code: 'ROOT_REQUIRED' };
  }
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o755 });
  const tmp = `${input.path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(input.body)}\n`, { mode: 0o444 });
  renameSync(tmp, input.path);
  chmodSync(input.path, 0o444);
  return { ok: true };
}

export function rejectCrossDiscoveryOperationSwap(input: {
  toolId: HmsReadToolId;
  receiptDiscoveryOperationId: DiscoveryOperationId;
  sessionDiscoveryOperationId: DiscoveryOperationId;
}): PhaseBOperatorResult | null {
  if (input.receiptDiscoveryOperationId === input.sessionDiscoveryOperationId) {
    return null;
  }
  // Same tool, different discovery op — reject.
  void input.toolId;
  return buildPhaseBOperatorResult({
    code: 'POLICY_OR_EVIDENCE_REJECTED',
    action: 'read-proof',
    toolId: input.toolId,
    stage: 'receipt',
  });
}

export type ProtectedArtifactGcPolicy = {
  mediaTtlMs: number;
  metadataRetentionMs: number;
};

export const PHASE_B_ARTIFACT_GC_POLICY: ProtectedArtifactGcPolicy = {
  mediaTtlMs: 24 * 60 * 60 * 1000,
  metadataRetentionMs: 90 * 24 * 60 * 60 * 1000,
};

export function shouldRetainProtectedMetadata(input: {
  referencedByActiveOrPredecessor: boolean;
  retiredAt: string | null;
  now: Date;
  policy?: ProtectedArtifactGcPolicy;
}): boolean {
  const policy = input.policy ?? PHASE_B_ARTIFACT_GC_POLICY;
  if (input.referencedByActiveOrPredecessor) return true;
  if (!input.retiredAt) return true;
  const retired = new Date(input.retiredAt).getTime();
  return input.now.getTime() - retired < policy.metadataRetentionMs;
}

export function shouldPurgeSensitiveMedia(input: {
  sensitiveMediaExpiresAt: string;
  now: Date;
}): boolean {
  return input.now.getTime() >= new Date(input.sensitiveMediaExpiresAt).getTime();
}

/** Map preflight blockers onto the canonical terminal ownership matrix. */
export function mapPreflightBlockToTerminal(
  code: PhaseBPreflightBlockCode,
): PhaseBTerminalCode {
  switch (code) {
    case 'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST':
      return 'MANIFEST_SOURCE_CHANGE_REQUIRED';
    case 'BLOCKED_NO_DRIVER_OR_CONTROLS':
      return 'BLOCKED_NO_POSITIVE_CONTROL';
    case 'BLOCKED_ROLE_PROOF_V2_INSECURE':
    case 'BLOCKED_MAIL_ARTIFACT_DISCOVERY':
    case 'BLOCKED_MAIL_ARTIFACT_PROOF':
      return 'POLICY_OR_EVIDENCE_REJECTED';
    case 'BLOCKED_UNKNOWN_TOOL':
      return 'USAGE_ERROR';
    case 'BLOCKED_NO_SEALED_FIXTURE':
    case 'BLOCKED_NO_SAFE_BOOTSTRAP':
    case 'BLOCKED_NO_ROLE_PROOF_V2':
    case 'BLOCKED_NO_DISCOVERY_EVIDENCE':
    case 'BLOCKED_NO_IMMUTABLE_RELEASE':
    case 'BLOCKED_NO_LOADABLE_HANDLER':
    case 'BLOCKED_NO_ACTIVE_REGISTRY':
    case 'BLOCKED_REGISTRY_CUTOVER_PENDING':
      return 'BLOCKED_EXTERNAL';
    default:
      return 'AGENT_REPAIR_REQUIRED';
  }
}

function phaseBLocalOperationRoot(): string {
  return (
    process.env.HMS_PHASE_B_OPERATION_ROOT?.trim() ||
    join(
      process.env.HMS_SHARED_DIR?.trim() || '/opt/nava/shared/hms-runtime',
      'phase-b-operations',
    )
  );
}

function resumeIdFromCommand(command: PhaseBParsedCommand): string | undefined {
  return 'resumeOperationId' in command ? command.resumeOperationId : undefined;
}

/**
 * Create or attach via durable store for claim/resume/cache.
 * Returns a cached terminal result when one already exists.
 */
function ensureStoreOperation(input: {
  store: PhaseBOperationStore;
  command: PhaseBParsedCommand;
  operationId: string;
  sourceRevision: string;
}):
  | { kind: 'cached'; result: PhaseBOperatorResult }
  | { kind: 'ready'; operationId: string }
  | { kind: 'fail'; result: PhaseBOperatorResult } {
  const { store, command, sourceRevision } = input;
  const inputSha256 = sha256Hex(JSON.stringify(command));
  const ownerToken = randomUUID();
  const resumeId = resumeIdFromCommand(command);

  if (resumeId) {
    const attach = store.attachOrCachedTerminal({
      operationId: resumeId,
      inputSha256,
      ownerToken,
    });
    if (attach.kind === 'cached') {
      return { kind: 'cached', result: attach.result };
    }
    if (attach.kind === 'attached') {
      return { kind: 'ready', operationId: attach.operation.operationId };
    }
    if (attach.kind === 'busy') {
      return {
        kind: 'fail',
        result: buildPhaseBOperatorResult({
          code: 'BLOCKED_EXTERNAL',
          action: command.action,
          operationId: resumeId,
          sourceRevision,
          toolId: 'toolId' in command ? command.toolId ?? null : null,
          waveId: 'waveId' in command ? command.waveId ?? null : null,
        }),
      };
    }
    return {
      kind: 'fail',
      result: buildPhaseBOperatorResult({
        code: 'AGENT_REPAIR_REQUIRED',
        action: command.action,
        operationId: resumeId,
        sourceRevision,
        toolId: 'toolId' in command ? command.toolId ?? null : null,
        waveId: 'waveId' in command ? command.waveId ?? null : null,
      }),
    };
  }

  if (
    command.action === 'read-discovery' ||
    command.action === 'read-proof' ||
    command.action === 'read-promote' ||
    command.action === 'read-rollback'
  ) {
    store.create({
      operationId: input.operationId,
      action: command.action,
      target: { toolId: command.toolId },
      sourceRevision,
      inputDigestMaterial: command,
    });
  } else if (command.action === 'read-wave') {
    store.create({
      operationId: input.operationId,
      action: 'read-wave',
      target: {
        waveId: command.waveId,
        toolIds: PHASE_B_WAVE_TOOLS[command.waveId],
      },
      sourceRevision,
      inputDigestMaterial: command,
    });
  } else {
    return { kind: 'ready', operationId: input.operationId };
  }

  const attach = store.attachOrCachedTerminal({
    operationId: input.operationId,
    inputSha256,
    ownerToken,
  });
  if (attach.kind === 'cached') {
    return { kind: 'cached', result: attach.result };
  }
  if (attach.kind === 'attached') {
    return { kind: 'ready', operationId: attach.operation.operationId };
  }
  return { kind: 'ready', operationId: input.operationId };
}

/** Local offline operator path for doctor/status + unit-testable actions. */
export function runPhaseBLocalOperator(input: {
  command: PhaseBParsedCommand;
  operationId: string;
  sourceRevision: string;
  store?: PhaseBOperationStore;
  startedAt?: number;
}): PhaseBOperatorResult {
  const started = input.startedAt ?? Date.now();
  const elapsed = () => Date.now() - started;
  const { command } = input;
  let operationId = input.operationId;

  if (command.action === 'doctor' || command.action === 'status') {
    return buildPhaseBOperatorResult({
      code: 'COMPLETE',
      action: command.action,
      stage: command.action,
      operationId: null,
      sourceRevision: input.sourceRevision,
      toolId: 'toolId' in command ? command.toolId ?? null : null,
      waveId: 'waveId' in command ? command.waveId ?? null : null,
      elapsedMs: elapsed(),
    });
  }

  // Durable store: create/attach for claim/resume/cache on mutating actions.
  if (
    input.store &&
    (command.action === 'read-discovery' ||
      command.action === 'read-proof' ||
      command.action === 'read-promote' ||
      command.action === 'read-rollback' ||
      command.action === 'read-wave')
  ) {
    const ensured = ensureStoreOperation({
      store: input.store,
      command,
      operationId,
      sourceRevision: input.sourceRevision,
    });
    if (ensured.kind === 'cached') return ensured.result;
    if (ensured.kind === 'fail') {
      return { ...ensured.result, elapsedMs: elapsed() };
    }
    operationId = ensured.operationId;
  }

  if (
    command.action === 'read-discovery' ||
    command.action === 'read-proof' ||
    command.action === 'read-promote' ||
    command.action === 'read-rollback'
  ) {
    const preflight = runPhaseBReadPreflight({
      action: command.action,
      toolId: command.toolId,
    });
    if (!preflight.ok) {
      return buildPhaseBOperatorResult({
        code: mapPreflightBlockToTerminal(preflight.code),
        action: command.action,
        stage: 'preflight',
        operationId,
        sourceRevision: input.sourceRevision,
        toolId: command.toolId,
        elapsedMs: elapsed(),
      });
    }
    if (command.action === 'read-discovery') {
      return buildPhaseBOperatorResult({
        code: 'NEXT_ACTION_READY',
        action: command.action,
        stage: 'preflight',
        operationId,
        sourceRevision: input.sourceRevision,
        toolId: command.toolId,
        nextAction: 'read-proof',
        nextToolId: command.toolId,
        elapsedMs: elapsed(),
      });
    }
    return buildPhaseBOperatorResult({
      code: 'COMPLETE',
      action: command.action,
      stage: 'preflight',
      operationId,
      sourceRevision: input.sourceRevision,
      toolId: command.toolId,
      releaseId: command.action === 'read-promote' ? command.releaseId : null,
      elapsedMs: elapsed(),
    });
  }

  if (command.action === 'read-wave') {
    const toolIds = PHASE_B_WAVE_TOOLS[command.waveId];
    return buildPhaseBOperatorResult({
      code: 'NEXT_ACTION_READY',
      action: 'read-wave',
      stage: 'preflight',
      operationId,
      sourceRevision: input.sourceRevision,
      waveId: command.waveId,
      nextAction: toolIds[0] ? 'read-discovery' : 'status',
      nextToolId: toolIds[0] ?? null,
      nextWaveId: command.waveId,
      elapsedMs: elapsed(),
    });
  }

  if (command.action === 'artifacts') {
    return buildPhaseBOperatorResult({
      code: 'COMPLETE',
      action: 'artifacts',
      stage: 'terminal',
      operationId: command.operationId ?? operationId,
      sourceRevision: input.sourceRevision,
      toolId: command.toolId,
      releaseId: command.releaseId ?? null,
      elapsedMs: elapsed(),
    });
  }

  if (command.action === 'fetch-artifact') {
    if (
      (command.kind === 'trace' || command.kind === 'video') &&
      command.kind === 'trace' &&
      !command.confirmSensitive
    ) {
      return buildPhaseBOperatorResult({
        code: 'POLICY_OR_EVIDENCE_REJECTED',
        action: 'fetch-artifact',
        stage: 'terminal',
        operationId,
        elapsedMs: elapsed(),
      });
    }
    return buildPhaseBOperatorResult({
      code: 'COMPLETE',
      action: 'fetch-artifact',
      stage: 'terminal',
      operationId,
      artifactIds: [command.artifactId],
      elapsedMs: elapsed(),
    });
  }

  if (command.action === 'rearm') {
    if (!input.store) {
      return buildPhaseBOperatorResult({
        code: 'AGENT_REPAIR_REQUIRED',
        action: 'rearm',
        toolId: command.toolId,
        operationId,
        elapsedMs: elapsed(),
      });
    }
    const result = input.store.rearmAfterSource({
      supersededOperationId: command.supersededOperationId,
      toolId: command.toolId,
      newSourceRevision: command.afterSource,
      newOperationId: command.resumeOperationId ?? operationId,
      inputDigestMaterial: command,
    });
    if (!result.ok) {
      if (result.code === 'POLICY_UNRESOLVED') {
        return buildPhaseBOperatorResult({
          code: 'POLICY_OR_EVIDENCE_REJECTED',
          action: 'rearm',
          toolId: command.toolId,
          operationId: command.supersededOperationId,
          elapsedMs: elapsed(),
        });
      }
      return buildPhaseBOperatorResult({
        code: 'AGENT_REPAIR_REQUIRED',
        action: 'rearm',
        toolId: command.toolId,
        operationId: command.supersededOperationId,
        elapsedMs: elapsed(),
      });
    }
    return buildPhaseBOperatorResult({
      code: 'COMPLETE',
      action: 'rearm',
      toolId: command.toolId,
      operationId: result.successor.operationId,
      sourceRevision: result.successor.sourceRevision,
      elapsedMs: elapsed(),
    });
  }

  return buildPhaseBOperatorResult({
    code: 'USAGE_ERROR',
    action: 'unknown',
    elapsedMs: elapsed(),
  });
}

export function assertNoPhaseBBlockedInSource(source: string): boolean {
  const needle = ['PHASE', 'B', 'BLOCKED'].join('_');
  return !source.includes(needle);
}

export { isHmsReadToolId, isDiscoveryOperationId, sha256Hex, hmacSha256Hex };

function parseCliMain(argv: string[]): number {
  if (argv[0] === 'parse') {
    const json = argv.includes('--json');
    const args = argv.filter((a) => a !== 'parse' && a !== '--json');
    const parsed = parsePhaseBArgv(args);
    if (!parsed.ok) {
      if (json) process.stdout.write(`${JSON.stringify(parsed.result)}\n`);
      else process.stderr.write(`HMS_FAIL code=${parsed.result.code}\n`);
      return parsed.result.exitCode;
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, command: parsed.command })}\n`,
      );
    }
    return 0;
  }
  if (argv[0] === 'local-operator') {
    const json = argv.includes('--json');
    const args = argv.filter((a) => a !== 'local-operator' && a !== '--json');
    const parsed = parsePhaseBArgv(args);
    if (!parsed.ok) {
      if (json) process.stdout.write(`${JSON.stringify(parsed.result)}\n`);
      else process.stderr.write(`HMS_FAIL code=${parsed.result.code}\n`);
      return parsed.result.exitCode;
    }
    // Honor --resume and mount durable store (same contract as hms-live-proof).
    const resumeId = resumeIdFromCommand(parsed.command);
    const operationId = resumeId || randomUUID();
    const sourceRevision = process.env.NAVA_SOURCE_REVISION?.trim() || 'local';
    const store = new PhaseBOperationStore({
      rootDir: phaseBLocalOperationRoot(),
    });
    const result = runPhaseBLocalOperator({
      command: parsed.command,
      operationId,
      sourceRevision,
      store,
    });
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      const tag =
        result.outcome === 'ok'
          ? 'HMS_OK'
          : result.outcome === 'wait'
            ? 'HMS_WAIT'
            : 'HMS_FAIL';
      process.stderr.write(`${tag} code=${result.code}\n`);
    }
    return result.exitCode;
  }
  process.stderr.write(
    'usage: phase-b-operation.ts parse|local-operator [--json] -- <phase-b-argv...>\n',
  );
  return 2;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  process.exit(parseCliMain(process.argv.slice(2)));
}
