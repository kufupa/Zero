/**
 * Classify a trusted native runner's result before reconciliation. This is not an
 * approval, dispatch fence, browser-closure proof, or permission to retry.
 * No result can be successful here: matching fresh readback and safe browser
 * closure must be established by the future durable lifecycle first.
 */
export function classifyUnreconciledCloudAmend(result: unknown): {
  failureClass: 'NEEDS_CHECK' | 'UNKNOWN'; reason: 'AMEND_NOT_DISPATCHED' | 'AMEND_OUTCOME_UNKNOWN';
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { failureClass: 'UNKNOWN', reason: 'AMEND_OUTCOME_UNKNOWN' };
  }
  const value = result as Record<string, unknown>;
  const dispatchSignals = ['possiblyDispatched', 'dispatched', 'saveAttempted', 'saveDispatched', 'clickedSave'];
  const possibleDispatch = dispatchSignals.some((key) => value[key] !== undefined && value[key] !== false);
  if (value.outcome === 'not_dispatched' && !possibleDispatch) {
    return { failureClass: 'NEEDS_CHECK', reason: 'AMEND_NOT_DISPATCHED' };
  }
  return { failureClass: 'UNKNOWN', reason: 'AMEND_OUTCOME_UNKNOWN' };
}
