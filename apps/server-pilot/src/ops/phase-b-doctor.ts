/**
 * Offline Phase B doctor: registry status + discovery preflight blockers.
 * No AWS, no HMS, no invented live proofs.
 */
import { fileURLToPath } from 'node:url';
import {
  READ_TOOL_IDS,
  productionActiveReadToolIds,
  type ReadToolId,
} from '../hms/read-tools.js';
import {
  runPhaseBReadPreflight,
  type PhaseBPreflightBlockCode,
} from './phase-b-read-preflight.js';
import { toolStatusRow, type PhaseBToolStatusRow } from './phase-b-status.js';

export type PhaseBDoctorToolRow = PhaseBToolStatusRow & {
  discoveryPreflightCode: PhaseBPreflightBlockCode;
};

export type PhaseBDoctorReport = {
  schemaVersion: 1;
  liveReady: boolean;
  productionActiveReadToolIds: ReadToolId[];
  /** True when production allowlist is only live_verified find (no fixture bleed). */
  productionActiveReadDecoupled: boolean;
  uniqueBlockerCodes: PhaseBPreflightBlockCode[];
  tools: PhaseBDoctorToolRow[];
};

export function buildPhaseBDoctorReport(input: {
  roleProofV2Path?: string | null;
  reviewedRequestManifestPath?: string | null;
  now?: Date;
} = {}): PhaseBDoctorReport {
  const now = input.now ?? new Date();
  const productionIds = productionActiveReadToolIds();
  const productionActiveReadDecoupled =
    productionIds.length === 1 && productionIds[0] === 'hms_find_reservation';

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

  // Live ready only when every HMS tool clears evidence preflight
  // (PHASE_B_BLOCKED = evidence ok, browser still unwired) and mail stays non-HMS.
  const liveReady = tools.every((row) => {
    if (row.id === 'mail_read_artifact') {
      return row.discoveryPreflightCode === 'BLOCKED_MAIL_ARTIFACT_DISCOVERY';
    }
    return row.discoveryPreflightCode === 'PHASE_B_BLOCKED';
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
  uniqueBlockerCodes: PhaseBPreflightBlockCode[];
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
