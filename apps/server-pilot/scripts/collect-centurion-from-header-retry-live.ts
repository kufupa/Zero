import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.private');
const RANGE_SIZE = 100;
const DEFAULT_SSM_WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deploy/ssm-run-command.sh');
type JsonRecord = Record<string, unknown>;
type RetryStatus = 'match' | 'no_match' | 'not_stored' | 'missing' | 'unreadable' | 'read_failed';
type RetryEvidence = { status: RetryStatus; headerSha256?: string };

export const compactRangeReader = [
  'const fs = require("node:fs");',
  'const crypto = require("node:crypto");',
  'const rows = fs.readFileSync(process.argv[1], "utf8").split("\\n").filter(Boolean).map(JSON.parse);',
  'const ids = rows.map(({ messageDbId }) => typeof messageDbId === "string" ? messageDbId.trim() : "");',
  'if (ids.some((id) => !id)) throw new Error("evidence_message_ids_invalid");',
  'const messageIdsOrderSha256 = crypto.createHash("sha256").update(ids.join("\\n")).digest("hex");',
  'const start = Number(process.argv[2]);',
  'const limit = Number(process.argv[3]);',
  'const evidence = rows.slice(start, start + limit).map(({ status, headerSha256 }) => {',
  '  if (!["match", "no_match", "not_stored", "missing", "unreadable", "read_failed"].includes(status)) throw new Error("invalid_status");',
  '  if (headerSha256 !== undefined && (typeof headerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(headerSha256))) throw new Error("invalid_header_hash");',
  '  return { status, ...(headerSha256 ? { headerSha256 } : {}) };',
  '});',
  'process.stdout.write(JSON.stringify({ start, count: evidence.length, messageIdsOrderSha256, evidence }));',
].join(' ');

function argument(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseInvocation(output: string): string {
  const invocation = asRecord(JSON.parse(output));
  if (invocation.ResponseCode !== 0 || typeof invocation.Stdout !== 'string') {
    throw new Error('ssm_range_failed');
  }
  return invocation.Stdout;
}

async function main(): Promise<void> {
  const sourceAttachments = argument('--source-attachments');
  const expectedSourceSha256 = argument('--expected-source-sha256');
  const remoteEvidencePath = argument('--remote-evidence-file');
  const outputPath = argument('--output-file');
  const wrapperPath = argument('--ssm-wrapper') ?? DEFAULT_SSM_WRAPPER;
  if (!sourceAttachments || !expectedSourceSha256 || !remoteEvidencePath || !outputPath) {
    throw new Error('configuration_missing');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256)) throw new Error('source_sha256_invalid');
  const resolvedOutput = path.resolve(outputPath);
  if (!resolvedOutput.startsWith(`${OUTPUT_ROOT}${path.sep}`)) throw new Error('output_path_invalid');
  const [realOutputRoot, realOutputParent] = await Promise.all([
    realpath(OUTPUT_ROOT), realpath(path.dirname(resolvedOutput)),
  ]);
  if (realOutputParent !== realOutputRoot && !realOutputParent.startsWith(`${realOutputRoot}${path.sep}`)) {
    throw new Error('output_path_invalid');
  }

  const sourceBytes = await readFile(sourceAttachments);
  if (sha256(sourceBytes) !== expectedSourceSha256) throw new Error('source_snapshot_changed');
  const messageIds = new Set<string>();
  for (const line of sourceBytes.toString('utf8').split('\n').filter(Boolean)) {
    const row = asRecord(JSON.parse(line));
    const evidence = asRecord(row.fromHeaderEvidence);
    const parent = asRecord(row.parentMessage);
    if (evidence.status === 'missing' && typeof parent.messageDbId === 'string' && parent.messageDbId.trim()) {
      messageIds.add(parent.messageDbId.trim());
    }
  }
  const orderedMessageIds = [...messageIds].sort();
  if (orderedMessageIds.length === 0) throw new Error('no_missing_header_candidates');
  const messageIdsOrderSha256 = sha256(orderedMessageIds.join('\n'));

  const rows: RetryEvidence[] = [];
  for (let start = 0; start < orderedMessageIds.length; start += RANGE_SIZE) {
    const remoteCommand = [
      'node -e',
      shellQuote(compactRangeReader),
      shellQuote(remoteEvidencePath),
      String(start),
      String(RANGE_SIZE),
    ].join(' ');
    const output = execFileSync('bash', [wrapperPath, remoteCommand], {
      encoding: 'utf8',
      env: { ...process.env, SSM_EXECUTION_TIMEOUT_SECONDS: '60' },
      maxBuffer: 1024 * 1024,
    });
    const payload = asRecord(JSON.parse(parseInvocation(output)));
    if (payload.messageIdsOrderSha256 !== messageIdsOrderSha256) {
      throw new Error('ssm_message_order_mismatch');
    }
    const evidence = Array.isArray(payload.evidence) ? payload.evidence.map(asRecord) : [];
    const expectedCount = Math.min(RANGE_SIZE, orderedMessageIds.length - start);
    if (payload.start !== start || payload.count !== expectedCount || evidence.length !== expectedCount) {
      throw new Error('ssm_range_shape_invalid');
    }
    for (const item of evidence) {
      const status = item.status;
      const headerSha256 = typeof item.headerSha256 === 'string' ? item.headerSha256 : undefined;
      if (!['match', 'no_match', 'not_stored', 'missing', 'unreadable', 'read_failed'].includes(String(status))) {
        throw new Error('ssm_range_status_invalid');
      }
      if (headerSha256 && !/^[a-f0-9]{64}$/.test(headerSha256)) throw new Error('ssm_range_hash_invalid');
      rows.push({
        status: status as RetryStatus,
        ...(headerSha256 ? { headerSha256 } : {}),
      });
    }
  }
  if (rows.length !== orderedMessageIds.length) throw new Error('ssm_range_total_invalid');

  const lines = rows.map((row, index) => JSON.stringify({
    messageDbId: orderedMessageIds[index],
    status: row.status,
    ...(row.headerSha256 ? { headerSha256: row.headerSha256 } : {}),
  }));
  await writeFile(resolvedOutput, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(resolvedOutput, 0o600);
  const statusCounts: Record<string, number> = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  process.stdout.write(`${JSON.stringify({ retryMessages: rows.length, statusCounts, outputFile: resolvedOutput })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`${JSON.stringify({ event: 'centurion_from_header_retry_collect.failed', error: name })}\n`);
    process.exitCode = 1;
  });
}
