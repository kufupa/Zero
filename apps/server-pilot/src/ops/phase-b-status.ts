/**
 * Phase B capability status.
 * Static READ_TOOLS = contract + fixture evidence only.
 * Production activation + private artifact IDs come from registry + index snapshot.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadProtectedArtifactIndexSync,
  privateArtifactIdsForTool,
} from '../hms/artifact-index.js';
import { hmsActiveRegistryV2Schema } from '../hms/release-kernel.js';
import {
  READ_TOOL_IDS,
  READ_TOOLS,
  capabilityStateFor,
  type CapabilityState,
  type PromotionEvidenceFlags,
  type ReadToolId,
} from '../hms/read-tools.js';

export const PHASE_B_WAVE_IDS = [
  'B0',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
] as const;

export type PhaseBWaveId = (typeof PHASE_B_WAVE_IDS)[number];

/** Subwave tool sets from Phase B release plan. Unknown wave rejected by CLI. */
export const PHASE_B_WAVE_TOOLS: Readonly<
  Record<PhaseBWaveId, readonly ReadToolId[]>
> = {
  B0: [],
  B1: ['hms_find_reservation', 'hms_quote_stay'],
  B2: ['hms_list_documents', 'hms_sent_email_audit'],
  B3: ['hms_read_folio'],
  B4: ['hms_company_account_read'],
  B5: ['hms_group_block_read', 'hms_event_read'],
  B6: [...READ_TOOL_IDS],
};

/**
 * Explicit release/capability snapshot — sole production-activation authority
 * for status/doctor. Never derived from static READ_TOOLS digests alone.
 */
export type PhaseBReleaseCapabilitySnapshot = {
  productionActiveReadToolIds: readonly ReadToolId[];
  /** Active release UUID per tool (registry). Absent tool → null. */
  activeReleaseIdByTool?: ReadonlyMap<ReadToolId, string>;
  /** Private artifact UUIDs per tool (index). Empty array when none yet. */
  privateArtifactIdsByTool?: ReadonlyMap<ReadToolId, readonly string[]>;
  /**
   * How the snapshot was loaded. Laptop without /opt/nava path → missing
   * (empty actives are NOT a live wipe). Invalid JSON/schema → invalid.
   */
  registryLoadState?: 'ok' | 'missing' | 'invalid';
};

export const EMPTY_PHASE_B_RELEASE_CAPABILITY_SNAPSHOT: PhaseBReleaseCapabilitySnapshot =
  {
    productionActiveReadToolIds: [],
    registryLoadState: 'missing',
  };

export type PhaseBToolStatusRow = {
  id: ReadToolId;
  version: string;
  capabilityState: CapabilityState;
  promotionEvidence: PromotionEvidenceFlags;
  fixtureDigestPresent: boolean;
  discoveryDigestPresent: boolean;
  liveProofDigestPresent: boolean;
  /** Registry active release UUID; null when not promoted. */
  activeReleaseId: string | null;
  /** Current private artifact UUIDs (receipt/trace); empty if none. */
  privateArtifactIds: string[];
};

export type PhaseBStatusReport = {
  schemaVersion: 1;
  productionActiveReadToolIds: ReadToolId[];
  /** Laptop without EC2 registry path → missing (empty ≠ wipe). */
  registryLoadState: 'ok' | 'missing' | 'invalid';
  tools: PhaseBToolStatusRow[];
};

export type PhaseBStatusFilter =
  | { kind: 'all' }
  | { kind: 'tool'; toolId: ReadToolId }
  | { kind: 'wave'; waveId: PhaseBWaveId };

function isReadToolId(value: string): value is ReadToolId {
  return (READ_TOOL_IDS as readonly string[]).includes(value);
}

function isWaveId(value: string): value is PhaseBWaveId {
  return (PHASE_B_WAVE_IDS as readonly string[]).includes(value);
}

export function defaultPhaseBRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.HMS_ACTIVE_REGISTRY_PATH?.trim() ||
    '/opt/nava/shared/hms-active-registry/active.json'
  );
}

export function defaultPhaseBArtifactIndexPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.HMS_PROTECTED_ARTIFACT_INDEX_PATH?.trim() ||
    '/opt/nava/shared/hms-browser-artifacts/index.v1.json'
  );
}

/**
 * Load registry + protected index for status binding.
 * Missing registry → empty activation (fixture contract rows only).
 * Invalid registry → empty (fail soft for offline laptop; promote stays fail-closed elsewhere).
 */
export function loadPhaseBReleaseCapabilitySnapshotFromDisk(
  env: NodeJS.ProcessEnv = process.env,
): PhaseBReleaseCapabilitySnapshot {
  const registryPath = defaultPhaseBRegistryPath(env);
  const indexPath = defaultPhaseBArtifactIndexPath(env);
  const activeReleaseIdByTool = new Map<ReadToolId, string>();
  const privateArtifactIdsByTool = new Map<ReadToolId, string[]>();
  const productionActiveReadToolIds: ReadToolId[] = [];

  if (!existsSync(registryPath)) {
    return {
      productionActiveReadToolIds: [],
      activeReleaseIdByTool,
      privateArtifactIdsByTool,
      registryLoadState: 'missing',
    };
  }

  let registryLoadState: 'ok' | 'invalid' = 'ok';
  try {
    const registry = hmsActiveRegistryV2Schema.parse(
      JSON.parse(readFileSync(registryPath, 'utf8')),
    );
    for (const [toolIdRaw, releaseId] of Object.entries(registry.active)) {
      if (!releaseId || !isReadToolId(toolIdRaw)) continue;
      productionActiveReadToolIds.push(toolIdRaw);
      activeReleaseIdByTool.set(toolIdRaw, releaseId);
    }
  } catch (error) {
    // Soft: status stays offline-fixture when registry unreadable.
    void error;
    registryLoadState = 'invalid';
  }

  const indexEntries = loadProtectedArtifactIndexSync(indexPath);
  for (const toolId of productionActiveReadToolIds) {
    privateArtifactIdsByTool.set(
      toolId,
      privateArtifactIdsForTool(indexEntries, toolId, {
        releaseId: activeReleaseIdByTool.get(toolId) ?? null,
      }),
    );
  }
  // Also surface index IDs for non-active tools when present (recovery).
  for (const toolId of READ_TOOL_IDS) {
    if (privateArtifactIdsByTool.has(toolId)) continue;
    const ids = privateArtifactIdsForTool(indexEntries, toolId);
    if (ids.length > 0) privateArtifactIdsByTool.set(toolId, ids);
  }

  return {
    productionActiveReadToolIds,
    activeReleaseIdByTool,
    privateArtifactIdsByTool,
    registryLoadState,
  };
}

export function toolStatusRow(
  toolId: ReadToolId,
  snapshot: PhaseBReleaseCapabilitySnapshot = EMPTY_PHASE_B_RELEASE_CAPABILITY_SNAPSHOT,
): PhaseBToolStatusRow {
  const tool = READ_TOOLS[toolId];
  const refs = tool.evidenceRefs;
  return {
    id: toolId,
    version: tool.version,
    capabilityState: capabilityStateFor(toolId),
    promotionEvidence: { ...tool.promotionEvidence },
    fixtureDigestPresent: Boolean(refs.fixtureDigest),
    discoveryDigestPresent: Boolean(refs.discoveryDigest),
    liveProofDigestPresent: Boolean(refs.liveProofDigest),
    activeReleaseId: snapshot.activeReleaseIdByTool?.get(toolId) ?? null,
    privateArtifactIds: [
      ...(snapshot.privateArtifactIdsByTool?.get(toolId) ?? []),
    ],
  };
}

export function buildPhaseBStatusReport(
  filter: PhaseBStatusFilter = { kind: 'all' },
  snapshot: PhaseBReleaseCapabilitySnapshot = EMPTY_PHASE_B_RELEASE_CAPABILITY_SNAPSHOT,
): PhaseBStatusReport {
  let ids: readonly ReadToolId[];
  switch (filter.kind) {
    case 'all':
      ids = READ_TOOL_IDS;
      break;
    case 'tool':
      ids = [filter.toolId];
      break;
    case 'wave':
      ids = PHASE_B_WAVE_TOOLS[filter.waveId];
      break;
  }
  const productionActiveReadToolIds = snapshot.productionActiveReadToolIds.filter(
    (id) => isReadToolId(id),
  );
  return {
    schemaVersion: 1,
    productionActiveReadToolIds: [...productionActiveReadToolIds],
    registryLoadState: snapshot.registryLoadState ?? 'missing',
    tools: ids.map((id) => toolStatusRow(id, snapshot)),
  };
}

export function formatPhaseBStatusOkLine(): string {
  return 'HMS_OK code=STATUS_OK';
}

export function phaseBStatusJsonRecord(report: PhaseBStatusReport): {
  schemaVersion: 1;
  outcome: 'ok';
  stage: 'status';
  code: 'STATUS_OK';
  exitCode: 0;
  productionActiveReadToolIds: ReadToolId[];
  registryLoadState: 'ok' | 'missing' | 'invalid';
  tools: PhaseBToolStatusRow[];
} {
  return {
    schemaVersion: report.schemaVersion,
    outcome: 'ok',
    stage: 'status',
    code: 'STATUS_OK',
    exitCode: 0,
    productionActiveReadToolIds: report.productionActiveReadToolIds,
    registryLoadState: report.registryLoadState,
    tools: report.tools,
  };
}

function parseArgv(argv: string[]): {
  filter: PhaseBStatusFilter;
  json: boolean;
} | { error: 'usage' | 'unknown_wave' | 'unknown_tool' } {
  let json = false;
  let toolId: string | undefined;
  let waveId: string | undefined;
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === '--json') {
      if (json) return { error: 'usage' };
      json = true;
      continue;
    }
    if (arg === '--tool') {
      if (toolId !== undefined || waveId !== undefined || rest.length === 0) {
        return { error: 'usage' };
      }
      toolId = rest.shift();
      continue;
    }
    if (arg === '--wave') {
      if (waveId !== undefined || toolId !== undefined || rest.length === 0) {
        return { error: 'usage' };
      }
      waveId = rest.shift();
      continue;
    }
    return { error: 'usage' };
  }
  if (toolId !== undefined && waveId !== undefined) return { error: 'usage' };
  if (toolId !== undefined) {
    if (!isReadToolId(toolId)) return { error: 'unknown_tool' };
    return { filter: { kind: 'tool', toolId }, json };
  }
  if (waveId !== undefined) {
    if (!isWaveId(waveId)) return { error: 'unknown_wave' };
    return { filter: { kind: 'wave', waveId }, json };
  }
  return { filter: { kind: 'all' }, json };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgv(argv);
  if ('error' in parsed) {
    if (parsed.error === 'unknown_wave' || parsed.error === 'unknown_tool') {
      process.stderr.write(
        `usage: phase-b-status.ts [--tool <tool-id>|--wave <subwave-id>] [--json]\n`,
      );
      return 2;
    }
    process.stderr.write(
      'usage: phase-b-status.ts [--tool <tool-id>|--wave <subwave-id>] [--json]\n',
    );
    return 2;
  }
  const snapshot = loadPhaseBReleaseCapabilitySnapshotFromDisk();
  const report = buildPhaseBStatusReport(parsed.filter, snapshot);
  process.stderr.write(`${formatPhaseBStatusOkLine()}\n`);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(phaseBStatusJsonRecord(report))}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  process.exit(main());
}
