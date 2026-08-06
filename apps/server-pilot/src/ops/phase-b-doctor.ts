/**
 * Offline Phase B doctor: registry status + discovery preflight codes.
 * Production activation from explicit snapshot — not static READ_TOOLS.
 * No AWS, no HMS, no invented live proofs.
 */
import { fileURLToPath } from 'node:url';
import { READ_TOOL_IDS, type ReadToolId } from '../hms/read-tools.js';
import {
  runPhaseBReadPreflight,
  type PhaseBPreflightCode,
} from './phase-b-read-preflight.js';
import {
  EMPTY_PHASE_B_RELEASE_CAPABILITY_SNAPSHOT,
  toolStatusRow,
  type PhaseBReleaseCapabilitySnapshot,
  type PhaseBToolStatusRow,
} from './phase-b-status.js';

export type PhaseBDoctorToolRow = PhaseBToolStatusRow & {
  discoveryPreflightCode: PhaseBPreflightCode;
};

export type PhaseBDoctorReport = {
  schemaVersion: 1;
  liveReady: boolean;
  productionActiveReadToolIds: ReadToolId[];
  /**
   * Demotion-era signal: true only while snapshot productionActive is empty.
   * Flips false when any tool is snapshot-activated (real digests/releases later).
   */
  productionActiveReadDecoupled: boolean;
  uniqueBlockerCodes: PhaseBPreflightCode[];
  tools: PhaseBDoctorToolRow[];
};

export function buildPhaseBDoctorReport(input: {
  roleProofV2Path?: string | null;
  reviewedRequestManifestPath?: string | null;
  now?: Date;
  snapshot?: PhaseBReleaseCapabilitySnapshot;
} = {}): PhaseBDoctorReport {
  const now = input.now ?? new Date();
  const snapshot =
    input.snapshot ?? EMPTY_PHASE_B_RELEASE_CAPABILITY_SNAPSHOT;
  const productionIds = [...snapshot.productionActiveReadToolIds];
  // Demotion era: decoupled iff no production activation yet. Snapshot injection
  // of any active id means production is no longer fully decoupled from live path.
  const productionActiveReadDecoupled = productionIds.length === 0;

  const tools: PhaseBDoctorToolRow[] = READ_TOOL_IDS.map((toolId) => {
    const status = toolStatusRow(toolId);
    const preflight = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId,
      roleProofV2Path: input.roleProofV2Path,
      reviewedRequestManifestPath: input.reviewedRequestManifestPath,
      now,
    });
    return {
      ...status,
      discoveryPreflightCode: preflight.code,
    };
  });

  const uniqueBlockerCodes = [
    ...new Set(tools.map((t) => t.discoveryPreflightCode)),
  ].sort();

  // Live ready only when snapshot has at least one production activation and
  // every HMS tool clears discovery preflight (DISCOVERY_READY); mail stays non-HMS.
  const liveReady =
    productionIds.length > 0 &&
    tools.every((row) => {
      if (row.id === 'mail_read_artifact') {
        return row.discoveryPreflightCode === 'BLOCKED_MAIL_ARTIFACT_DISCOVERY';
      }
      return row.discoveryPreflightCode === 'DISCOVERY_READY';
    });

  return {
    schemaVersion: 1,
    liveReady,
    productionActiveReadToolIds: productionIds,
    productionActiveReadDecoupled,
    uniqueBlockerCodes,
    tools,
  };
}

export function formatPhaseBDoctorOkLine(): string {
  return 'HMS_OK code=DOCTOR_OK';
}

export function phaseBDoctorJsonRecord(report: PhaseBDoctorReport): {
  schemaVersion: 1;
  outcome: 'ok';
  stage: 'doctor';
  code: 'DOCTOR_OK';
  exitCode: 0;
  liveReady: boolean;
  productionActiveReadDecoupled: boolean;
  productionActiveReadToolIds: ReadToolId[];
  uniqueBlockerCodes: PhaseBPreflightCode[];
  tools: PhaseBDoctorToolRow[];
} {
  return {
    schemaVersion: report.schemaVersion,
    outcome: 'ok',
    stage: 'doctor',
    code: 'DOCTOR_OK',
    exitCode: 0,
    liveReady: report.liveReady,
    productionActiveReadDecoupled: report.productionActiveReadDecoupled,
    productionActiveReadToolIds: report.productionActiveReadToolIds,
    uniqueBlockerCodes: report.uniqueBlockerCodes,
    tools: report.tools,
  };
}

function parseArgv(argv: string[]): { json: boolean } | { error: 'usage' } {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      if (json) return { error: 'usage' };
      json = true;
      continue;
    }
    return { error: 'usage' };
  }
  return { json };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgv(argv);
  if ('error' in parsed) {
    process.stderr.write('usage: phase-b-doctor.ts [--json]\n');
    return 2;
  }
  const report = buildPhaseBDoctorReport();
  process.stderr.write(`${formatPhaseBDoctorOkLine()}\n`);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(phaseBDoctorJsonRecord(report))}\n`);
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
