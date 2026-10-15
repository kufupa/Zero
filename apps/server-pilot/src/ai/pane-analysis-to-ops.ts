/**
 * Map lunaAnalysis.workflow onto same-move GoldOperation rows.
 * Offline pane replay only. No HMS. No mail bodies in the emitted ops.
 */
import {
  snapshotRowToAgentCase,
  type SnapshotRow,
} from './agent-decision-to-ops.js';
import { goldenSelection } from './reservationist-backtest.js';
import { TODO_TARGET_OPS, type LunaAnalysis } from './reservationist-decision.js';
import type { GoldOperation } from './same-move-ops.js';

/** Copied from gold-pair-join goldOp — that helper is not exported. */
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

const TODO_TARGET_SET = new Set<string>(TODO_TARGET_OPS);

const WORKFLOW_OPERATION: Record<LunaAnalysis['workflow'], string> = {
  quote: 'quote',
  create_booking: 'create',
  amend: 'amend',
  cancel: 'cancel',
  other: 'unknown',
  skip: 'none',
  forward_to_partner: 'partner',
  send_document: 'document',
  payment_ack: 'post_payment',
  acknowledge: 'none',
  clarify: 'unknown',
  hms_todo: 'unknown',
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

export function paneAnalysisToOperations(
  analysis: Pick<LunaAnalysis, 'workflow' | 'todoTarget'>,
): GoldOperation[] {
  if (analysis.workflow === 'hms_todo') {
    const target = analysis.todoTarget;
    if (target && TODO_TARGET_SET.has(target)) return [goldOp(target)];
    return [goldOp('unknown', 'hms_todo')];
  }
  const mapped = WORKFLOW_OPERATION[analysis.workflow];
  const operation = mapped ?? 'unknown';
  const unknownReason = operation === 'unknown' ? (analysis.workflow === 'other' ? 'other' : analysis.workflow) : null;
  return [goldOp(operation, unknownReason)];
}

/** Same causal case as replay-ops, then the --target pane selection. */
export function snapshotRowToPaneSelection(row: SnapshotRow) {
  return goldenSelection(snapshotRowToAgentCase(row));
}
