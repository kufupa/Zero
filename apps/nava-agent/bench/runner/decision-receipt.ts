import {createHash} from 'node:crypto';
import {contentDigest, orderedBusinessValue} from '../twin/read-result.js';
import type {AttemptedState} from './replay-input.js';

export const DECISION_RECEIPT_SCHEMA = 'nava.decision_receipt/v1';
export const SCRUBBER_VERSION = 'payment-redact/v1';

export type ToolPairReceipt = {
  name: string;
  request_digest: string;
  response_digest: string;
  ok: boolean | null;
  twin_coverage: 'observed' | 'no_match' | 'unobserved' | null;
  /** Stable pairing index; retries keep distinct slots, not double-counted as hits. */
  attempt_index: number;
  status: 'ok' | 'error' | 'cancelled' | 'retried';
};

export type DecisionReceipt = {
  schema: typeof DECISION_RECEIPT_SCHEMA;
  scrubber_version: typeof SCRUBBER_VERSION;
  selected_id: string | null;
  scope: {property: string; mailbox: string | null};
  evidence_ids: string[];
  evidence_digest: string;
  agent_sha: string;
  model: {name: string; reasoning: string | null};
  skills_digest: string;
  world_content_digest: string;
  tool_pairs: ToolPairReceipt[];
  memory_refs: Array<{role: string; ref: string}>;
  proposal_raw_digest: string | null;
  proposal_staff_digest: string | null;
  elapsed_ms: number | null;
  disposition: string | null;
  workflow: string | null;
  attempted_state: AttemptedState;
  raw_prediction_sha: string;
  unavailable_classes: string[];
  network_disabled: true;
  writes_disabled: true;
};

function coverageOf(result: unknown): ToolPairReceipt['twin_coverage'] {
  if (!result || typeof result !== 'object') return null;
  const data = (result as {data?: unknown}).data;
  if (!data || typeof data !== 'object') return null;
  const tag = (data as {twin_coverage?: unknown}).twin_coverage;
  if (tag === 'observed' || tag === 'no_match' || tag === 'unobserved') return tag;
  return null;
}

/** Pair tool request/response once; mark retries distinctly (no double-count). */
export function pairToolAttempts(
  calls: Array<{name: string; input?: unknown; result?: {ok?: boolean; data?: unknown} | null}>,
): ToolPairReceipt[] {
  const seen = new Map<string, number>();
  return calls.map((call, index) => {
    const digestKey = `${call.name}:${contentDigest(call.input)}`;
    const prior = seen.get(digestKey) ?? 0;
    seen.set(digestKey, prior + 1);
    const status: ToolPairReceipt['status'] =
      prior > 0 ? 'retried' :
      call.result?.ok === false ? 'error' :
      call.result?.ok === true ? 'ok' : 'cancelled';
    return {
      name: call.name,
      request_digest: contentDigest(call.input ?? null),
      response_digest: contentDigest(call.result ?? null),
      ok: call.result?.ok ?? null,
      twin_coverage: coverageOf(call.result),
      attempt_index: index,
      status,
    };
  });
}

export function buildDecisionReceipt(args: {
  selected_id: string | null;
  property: string;
  mailbox?: string | null;
  evidence_ids?: string[];
  evidence_digest: string;
  agent_sha: string;
  model: string;
  reasoning?: string | null;
  skills_digest: string;
  world_content_digest: string;
  tool_calls: Array<{name: string; input?: unknown; result?: {ok?: boolean; data?: unknown} | null}>;
  memory_refs?: Array<{role: string; ref: string}>;
  proposal: unknown;
  proposal_raw: unknown;
  elapsed_ms?: number | null;
  disposition?: string | null;
  workflow?: string | null;
  attempted_state: AttemptedState;
  unavailable_classes?: string[];
}): DecisionReceipt {
  const tool_pairs = pairToolAttempts(args.tool_calls);
  const body = {
    schema: DECISION_RECEIPT_SCHEMA,
    scrubber_version: SCRUBBER_VERSION,
    selected_id: args.selected_id,
    scope: {property: args.property, mailbox: args.mailbox ?? null},
    evidence_ids: args.evidence_ids ?? [],
    evidence_digest: args.evidence_digest,
    agent_sha: args.agent_sha,
    model: {name: args.model, reasoning: args.reasoning ?? null},
    skills_digest: args.skills_digest,
    world_content_digest: args.world_content_digest,
    tool_pairs,
    memory_refs: args.memory_refs ?? [],
    proposal_raw_digest: args.proposal_raw == null ? null : contentDigest(args.proposal_raw),
    proposal_staff_digest: args.proposal == null ? null : contentDigest(args.proposal),
    elapsed_ms: args.elapsed_ms ?? null,
    disposition: args.disposition ?? null,
    workflow: args.workflow ?? null,
    attempted_state: args.attempted_state,
    unavailable_classes: args.unavailable_classes ?? [],
    network_disabled: true as const,
    writes_disabled: true as const,
  };
  const raw_prediction_sha = createHash('sha256')
    .update(JSON.stringify(orderedBusinessValue({
      evidence_digest: body.evidence_digest,
      world_content_digest: body.world_content_digest,
      skills_digest: body.skills_digest,
      model: body.model,
      tool_pairs: body.tool_pairs,
      proposal_raw_digest: body.proposal_raw_digest,
      proposal_staff_digest: body.proposal_staff_digest,
      attempted_state: body.attempted_state,
    })))
    .digest('hex');
  return {...body, raw_prediction_sha};
}
