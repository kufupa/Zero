/**
 * Actionable inbound-untagged gate helpers for Centurion triage closeout.
 * Pure predicates — no DB. Used by quality audit + dead-letter repair emit.
 */

export type DeadLetterReasonBucket =
  | 'workflow_failed'
  | 'category_missing'
  | 'run_deadline'
  | 'other'
  | 'none';

export type ActionableUntaggedThreadInput = {
  threadId: string;
  spamAt: string | null;
  hasInbound: boolean;
  hasCategory: boolean;
  latestInboundFrom?: string | null;
  subject?: string | null;
};

/** July fixture / OVN test traffic — not production Centurion ops mail. */
export function isFixtureAllowlistedUntagged(input: {
  latestInboundFrom?: string | null;
  subject?: string | null;
}): boolean {
  const from = (input.latestInboundFrom ?? '').toLowerCase();
  const subject = input.subject ?? '';
  if (from === 'guest@example.com') return true;
  if (from === 'aroransh17@gmail.com') return true;
  if (from === 'coleddofficial@gmail.com') return true;
  if (/^OVN-/i.test(subject) || /^AE2-real-/i.test(subject)) return true;
  if (/^test(er\d*)?$/i.test(subject.trim())) return true;
  if (subject === 'test pdf') return true;
  return false;
}

/** True when inbox-visible inbound mail still has no durable triage tag. */
export function isActionableInboundUntagged(input: ActionableUntaggedThreadInput): boolean {
  if (input.spamAt != null) return false;
  if (!input.hasInbound) return false;
  if (input.hasCategory) return false;
  if (isFixtureAllowlistedUntagged(input)) return false;
  return true;
}

export function classifyDeadLetterReason(input: {
  lastError?: string | null;
  failureClass?: string | null;
}): DeadLetterReasonBucket {
  const failureClass = (input.failureClass ?? '').trim();
  const lastError = (input.lastError ?? '').trim();
  if (failureClass === 'RUN_DEADLINE' || lastError === 'RUN_DEADLINE') return 'run_deadline';
  if (lastError === 'mail triage workflow failed: failed') return 'workflow_failed';
  if (lastError.startsWith('AI category missing')) return 'category_missing';
  if (!lastError && !failureClass) return 'none';
  return 'other';
}

export function evaluateActionableInboundUntaggedGate(threads: ActionableUntaggedThreadInput[]): {
  ok: boolean;
  actionableCount: number;
  actionableThreadIds: string[];
  errors: string[];
} {
  const actionable = threads.filter(isActionableInboundUntagged);
  const errors: string[] = [];
  if (actionable.length > 0) {
    errors.push(
      `actionable inbound untagged=${actionable.length} (expected 0; sample=${actionable
        .slice(0, 5)
        .map((t) => t.threadId)
        .join(',')})`,
    );
  }
  return {
    ok: actionable.length === 0,
    actionableCount: actionable.length,
    actionableThreadIds: actionable.map((t) => t.threadId),
    errors,
  };
}
