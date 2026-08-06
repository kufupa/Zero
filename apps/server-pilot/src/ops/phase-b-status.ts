/**
 * Offline Phase B capability status from READ_TOOLS registry.
 * No AWS, no HMS, no invented live proofs.
 */
import { fileURLToPath } from 'node:url';
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
  B1: ['hms_find_reservation', 'mail_read_artifact', 'hms_quote_stay'],
  B2: ['hms_list_documents', 'hms_sent_email_audit'],
  B3: ['hms_read_folio'],
  B4: ['hms_company_account_read'],
  B5: ['hms_group_block_read', 'hms_event_read'],
  B6: [...READ_TOOL_IDS],
};

export type PhaseBToolStatusRow = {
  id: ReadToolId;
  version: string;
  capabilityState: CapabilityState;
  promotionEvidence: PromotionEvidenceFlags;
  fixtureDigestPresent: boolean;
  discoveryDigestPresent: boolean;
  liveProofDigestPresent: boolean;
};

export type PhaseBStatusReport = {
  schemaVersion: 1;
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

export function toolStatusRow(toolId: ReadToolId): PhaseBToolStatusRow {
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
  };
}

export function buildPhaseBStatusReport(
  filter: PhaseBStatusFilter = { kind: 'all' },
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
  return {
    schemaVersion: 1,
    tools: ids.map(toolStatusRow),
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
  tools: PhaseBToolStatusRow[];
} {
  return {
    schemaVersion: report.schemaVersion,
    outcome: 'ok',
    stage: 'status',
    code: 'STATUS_OK',
    exitCode: 0,
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
  const report = buildPhaseBStatusReport(parsed.filter);
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
