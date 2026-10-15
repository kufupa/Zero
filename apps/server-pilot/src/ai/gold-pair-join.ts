/**
 * Join labelled staff_move + optional claimed ops into Promptfoo ops JSON.
 * Ops only. No mail bodies. No RDS.
 *
 * GoldOperation shape copied from same-move-ops (feat/promptfoo-gold-fixtures):
 * operation, needLevel, requiredFields, candidateTool, unknownReason.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { opsMatch } from './same-move-ops.js';

export const DEFAULT_SYNTHETIC_GOLD_PAIR_IN = 'evals/same-move/synthetic-gold-pair.json';
export const DEFAULT_JOINED_OPS_OUT = 'evals/same-move/joined-ops.jsonl';

const FORBIDDEN_MAIL_FIELDS = new Set(['textBody', 'htmlBody', 'from', 'to', 'subject']);

export type GoldOperation = {
  operation: string;
  needLevel: string;
  requiredFields: string[];
  candidateTool: string | null;
  unknownReason: string | null;
};

export type StaffMoveLabel = {
  messageId?: string;
  message_id?: string;
  threadId?: string;
  thread_id?: string;
  targetKey?: string;
  target_key?: string;
  staff_move: string;
  hms_work_implied?: readonly string[];
};

export type ClaimedOpsRow = {
  messageId?: string;
  threadId?: string;
  targetKey?: string;
  operations: GoldOperation[];
};

export type PredictedOpsRow = {
  messageId?: string;
  message_id?: string;
  threadId?: string;
  thread_id?: string;
  targetKey?: string;
  target_key?: string;
  operations?: GoldOperation[];
  action?: string;
};

export type SameMoveOpsRow = {
  id: string;
  expectPass: boolean;
  predicted: GoldOperation[];
  claimed: GoldOperation[];
};

export type GoldPairJoinInput = {
  labels: readonly StaffMoveLabel[];
  claimed?: readonly ClaimedOpsRow[];
  predicted?: readonly PredictedOpsRow[];
};

export type GoldPairJoinCli = {
  inPath: string;
  outPath: string;
  privateInPath: string | null;
};

const STAFF_MOVE_OPERATION: Record<string, string> = {
  booked_confirmed: 'create',
  cancel_done: 'cancel',
  amend_done: 'amend',
  priced_quote: 'quote',
  payment_ack: 'post_payment',
  invoice_or_folio_sent: 'document',
  acknowledge_only: 'none',
  ask_clarify: 'unknown',
  forward_redirect: 'partner',
  unavailable_offer_alt: 'unknown',
  other: 'unknown',
};

const R3_ACTION_OPERATION: Record<string, string> = {
  new_booking: 'create',
  quote_availability: 'quote',
  cancel: 'cancel',
  amend: 'amend',
  payment_proof: 'post_payment',
  billing: 'unknown',
  group_event: 'unknown',
  other_actionable: 'unknown',
  no_action: 'none',
};

const HMS_WORK_OPERATION: Record<string, string> = {
  create: 'create',
  amend: 'amend',
  cancel: 'cancel',
  payment_post: 'post_payment',
  folio_read: 'read',
  attach_doc: 'attachment',
  rates_read: 'quote',
  party_lookup: 'read',
};

const OPERATION_TOOL: Record<string, string | null> = {
  create: 'hms_create_reservation',
  cancel: 'hms_cancel_reservation',
  amend: 'hms_amend_reservation',
  quote: 'hms_quote_stay',
  post_payment: 'hms_post_payment',
  document: 'hms_generate_invoice',
  attachment: 'hms_attach_guest_stay_document',
  read: 'hms_read_reservation',
  refund: 'hms_refund_payment',
  none: null,
  unknown: null,
  partner: null,
  channel: null,
};

function goldOp(operation: string, unknownReason: string | null = null): GoldOperation {
  return {
    operation,
    needLevel: operation === 'none' || operation === 'unknown' ? 'not_needed' : 'required',
    requiredFields: [],
    candidateTool: OPERATION_TOOL[operation] ?? null,
    unknownReason,
  };
}

export function predictedActionToOperations(action: string): GoldOperation[] {
  const visible = R3_ACTION_OPERATION[action];
  if (!visible) return [goldOp('unknown', action)];
  return [goldOp(visible, visible === 'unknown' ? action : null)];
}

function predictedOpsFromRow(row: PredictedOpsRow): GoldOperation[] {
  if (row.operations && row.operations.length > 0) return cloneOps(row.operations);
  const action = text(row.action);
  if (action) return predictedActionToOperations(action);
  return [];
}

export function staffMoveToOperations(
  staffMove: string,
  hmsWorkImplied: readonly string[] = [],
): GoldOperation[] {
  const visible = STAFF_MOVE_OPERATION[staffMove];
  if (visible && staffMove !== 'no_visible_action' && staffMove !== 'silent_hms_work') {
    return [goldOp(visible, visible === 'unknown' ? staffMove : null)];
  }
  const implied = [
    ...new Set(
      hmsWorkImplied
        .filter((token) => token !== 'none')
        .map((token) => HMS_WORK_OPERATION[token])
        .filter((token): token is string => Boolean(token)),
    ),
  ];
  if (implied.length > 0) return implied.map((operation) => goldOp(operation));
  return [goldOp('none')];
}

function assertNoMailFields(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoMailFields(item, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_MAIL_FIELDS.has(key)) {
      throw new Error(`gold-pair join forbids mail field ${key} at ${trail}`);
    }
    assertNoMailFields(child, `${trail}.${key}`);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function labelKeys(label: StaffMoveLabel): {
  messageId?: string;
  threadId?: string;
  targetKey?: string;
} {
  return {
    messageId: text(label.messageId) ?? text(label.message_id),
    threadId: text(label.threadId) ?? text(label.thread_id),
    targetKey: text(label.targetKey) ?? text(label.target_key),
  };
}

function cloneOps(operations: readonly GoldOperation[]): GoldOperation[] {
  return operations.map((operation) => ({
    operation: operation.operation,
    needLevel: operation.needLevel,
    requiredFields: [...operation.requiredFields],
    candidateTool: operation.candidateTool,
    unknownReason: operation.unknownReason,
  }));
}

type IndexedOps = {
  byMessageId: Map<string, GoldOperation[]>;
  byTargetKey: Map<string, GoldOperation[]>;
  byThreadId: Map<string, GoldOperation[][]>;
};

function opsRowKeys(row: {
  messageId?: string;
  message_id?: string;
  threadId?: string;
  thread_id?: string;
  targetKey?: string;
  target_key?: string;
}): { messageId?: string; threadId?: string; targetKey?: string } {
  return {
    messageId: text(row.messageId) ?? text(row.message_id),
    threadId: text(row.threadId) ?? text(row.thread_id),
    targetKey: text(row.targetKey) ?? text(row.target_key),
  };
}

function indexOps(
  rows: readonly {
    messageId?: string;
    message_id?: string;
    threadId?: string;
    thread_id?: string;
    targetKey?: string;
    target_key?: string;
    operations?: GoldOperation[];
  }[],
): IndexedOps {
  const byMessageId = new Map<string, GoldOperation[]>();
  const byTargetKey = new Map<string, GoldOperation[]>();
  const byThreadId = new Map<string, GoldOperation[][]>();
  for (const row of rows) {
    const ops = cloneOps(row.operations ?? []);
    const keys = opsRowKeys(row);
    const messageId = keys.messageId;
    const targetKey = keys.targetKey;
    const threadId = keys.threadId;
    if (messageId) byMessageId.set(messageId, ops);
    if (targetKey) byTargetKey.set(targetKey, ops);
    if (threadId) {
      const list = byThreadId.get(threadId) ?? [];
      list.push(ops);
      byThreadId.set(threadId, list);
    }
  }
  return { byMessageId, byTargetKey, byThreadId };
}

function lookupOps(
  index: IndexedOps,
  keys: { messageId?: string; threadId?: string; targetKey?: string },
): GoldOperation[] | null {
  if (keys.messageId) {
    const hit = index.byMessageId.get(keys.messageId);
    if (hit) return hit;
  }
  if (keys.targetKey) {
    const hit = index.byTargetKey.get(keys.targetKey);
    if (hit) return hit;
  }
  if (keys.threadId) {
    const hits = index.byThreadId.get(keys.threadId);
    if (hits && hits.length === 1) return hits[0]!;
  }
  return null;
}

export function joinGoldPairOps(input: GoldPairJoinInput): SameMoveOpsRow[] {
  assertNoMailFields(input, 'join');
  const claimedIndex = indexOps(input.claimed ?? []);
  const predictedIndex = indexOps(
    (input.predicted ?? []).map((row) => ({
      ...opsRowKeys(row),
      operations: predictedOpsFromRow(row),
    })),
  );
  return input.labels.map((label) => {
    const keys = labelKeys(label);
    const id = keys.messageId ?? keys.targetKey ?? keys.threadId;
    if (!id) throw new Error('gold-pair join needs messageId, targetKey, or threadId');
    const claimed =
      lookupOps(claimedIndex, keys) ??
      staffMoveToOperations(label.staff_move, label.hms_work_implied ?? []);
    const predicted = lookupOps(predictedIndex, keys) ?? [];
    return {
      id,
      expectPass: opsMatch(predicted, claimed),
      predicted,
      claimed,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOperations(value: unknown): GoldOperation[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    return {
      operation: String(row.operation ?? 'unknown'),
      needLevel: String(row.needLevel ?? 'required'),
      requiredFields: Array.isArray(row.requiredFields)
        ? row.requiredFields.filter((field): field is string => typeof field === 'string')
        : [],
      candidateTool: typeof row.candidateTool === 'string' ? row.candidateTool : null,
      unknownReason: typeof row.unknownReason === 'string' ? row.unknownReason : null,
    };
  });
}

function readLabels(value: unknown): StaffMoveLabel[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    const staffMove = text(row.staff_move);
    if (!staffMove) throw new Error('gold-pair label missing staff_move');
    return {
      messageId: text(row.messageId),
      message_id: text(row.message_id),
      threadId: text(row.threadId),
      thread_id: text(row.thread_id),
      targetKey: text(row.targetKey),
      target_key: text(row.target_key),
      staff_move: staffMove,
      hms_work_implied: Array.isArray(row.hms_work_implied)
        ? row.hms_work_implied.filter((token): token is string => typeof token === 'string')
        : undefined,
    };
  });
}

function readOpsRows(value: unknown): ClaimedOpsRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    return {
      messageId: text(row.messageId) ?? text(row.message_id),
      threadId: text(row.threadId) ?? text(row.thread_id),
      targetKey: text(row.targetKey) ?? text(row.target_key),
      operations: readOperations(row.operations),
    };
  });
}

function readPredictedRows(value: unknown): PredictedOpsRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    const parsed: PredictedOpsRow = {
      messageId: text(row.messageId) ?? text(row.message_id),
      threadId: text(row.threadId) ?? text(row.thread_id),
      targetKey: text(row.targetKey) ?? text(row.target_key),
      operations: readOperations(row.operations),
      action: text(row.action),
    };
    return { ...parsed, operations: predictedOpsFromRow(parsed) };
  });
}

function fromJsonDocument(parsed: unknown): GoldPairJoinInput {
  assertNoMailFields(parsed, 'fixture');
  if (Array.isArray(parsed)) {
    return { labels: readLabels(parsed) };
  }
  const record = asRecord(parsed);
  return {
    labels: readLabels(record.labels),
    claimed: readOpsRows(record.claimed),
    predicted: readPredictedRows(record.predicted),
  };
}

function fromJsonlLines(trimmed: string): GoldPairJoinInput {
  const labels: StaffMoveLabel[] = [];
  const claimed: ClaimedOpsRow[] = [];
  const predicted: PredictedOpsRow[] = [];
  for (const line of trimmed.split(/\n/)) {
    if (!line.trim()) continue;
    const parsedLine = JSON.parse(line) as unknown;
    assertNoMailFields(parsedLine, 'fixture');
    if (Array.isArray(parsedLine)) {
      labels.push(...readLabels(parsedLine));
      continue;
    }
    const row = asRecord(parsedLine);
    const kind = text(row.kind) ?? 'label';
    if (kind === 'claimed') claimed.push(readOpsRows([row])[0]!);
    else if (kind === 'predicted') predicted.push(readPredictedRows([row])[0]!);
    else labels.push(readLabels([{ ...row, staff_move: row.staff_move }])[0]!);
  }
  return { labels, claimed, predicted };
}

export function parseGoldPairFixture(raw: string): GoldPairJoinInput {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('gold-pair fixture empty');
  try {
    return fromJsonDocument(JSON.parse(trimmed) as unknown);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return fromJsonlLines(trimmed);
}

export function parseGoldPairJoinCli(
  argv: readonly string[],
  serverRoot: string,
): GoldPairJoinCli {
  let inPath: string | undefined;
  let outPath: string | undefined;
  let privateInPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--in' && value && !value.startsWith('--')) {
      inPath = value;
      i += 1;
      continue;
    }
    if (flag === '--out' && value && !value.startsWith('--')) {
      outPath = value;
      i += 1;
      continue;
    }
    if (flag === '--private-in' && value && !value.startsWith('--')) {
      privateInPath = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown gold-pair join flag ${flag}`);
  }
  const resolvedPrivate = privateInPath ? path.resolve(serverRoot, privateInPath) : null;
  return {
    inPath: resolvedPrivate ?? path.resolve(serverRoot, inPath ?? DEFAULT_SYNTHETIC_GOLD_PAIR_IN),
    outPath: path.resolve(serverRoot, outPath ?? DEFAULT_JOINED_OPS_OUT),
    privateInPath: resolvedPrivate,
  };
}

export function writeJoinedOpsJsonl(outPath: string, rows: readonly SameMoveOpsRow[]): void {
  assertNoMailFields(rows, 'out');
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  renameSync(tmpPath, outPath);
}

export function runGoldPairJoin(args: {
  inPath: string;
  outPath: string;
  privateInPath?: string | null;
}): { written: number; outPath: string } {
  const raw = readFileSync(args.inPath, 'utf8');
  const rows = joinGoldPairOps(parseGoldPairFixture(raw));
  writeJoinedOpsJsonl(args.outPath, rows);
  return { written: rows.length, outPath: args.outPath };
}
