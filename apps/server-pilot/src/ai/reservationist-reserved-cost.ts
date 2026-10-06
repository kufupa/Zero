export type PaidContinuationAuthorization = { source: string; startedAt: string; expiresAt: string; cumulativeCapUsd: number };
export type ReservedPaidAttempt = { requestId: string; reservedUsd: number; estimatedUsd: number | null; state: 'reserved' | 'reported' | 'failed_unknown'; boundViolated?: true };
export type RequestCostBound = { version: string; sourceHash: string; maxInputTokens: number; maxOutputTokens: number; inputUsdPerMillion: number; outputUsdPerMillion: number };
const positive = (value: number) => Number.isFinite(value) && value > 0;
const money = (value: number) => Math.round(value * 1e10) / 1e10;

/** The input bound is provider evidence, never an estimate from PDF bytes. */
export function validatedRequestReservation(bound: RequestCostBound): number {
  if (!bound.version || !/^[a-f0-9]{64}$/.test(bound.sourceHash) || !Number.isSafeInteger(bound.maxInputTokens) || bound.maxInputTokens < 1 || bound.maxInputTokens > 922000 || !Number.isSafeInteger(bound.maxOutputTokens) || bound.maxOutputTokens < 1 || bound.maxOutputTokens > 32768 || ![bound.inputUsdPerMillion, bound.outputUsdPerMillion].every(value => Number.isFinite(value) && value >= 0)) throw new Error('paid_request_bound_invalid');
  const reservation = (bound.maxInputTokens * bound.inputUsdPerMillion + bound.maxOutputTokens * bound.outputUsdPerMillion) / 1e6;
  if (!positive(reservation)) throw new Error('paid_request_bound_invalid');
  return reservation;
}

/** Local evaluation accounting only. An unknown invoice remains unknown after its maximum debit. */
export class ConservativePaidLedger {
  private readonly authorization: PaidContinuationAuthorization;
  private readonly attempts: ReservedPaidAttempt[];
  private boundViolated = false;
  constructor(authorization: PaidContinuationAuthorization, previous: readonly ReservedPaidAttempt[], private readonly now: () => number = Date.now, maximumAuthorizedUsd = 25) {
    const start = Date.parse(authorization.startedAt), end = Date.parse(authorization.expiresAt);
    if (!positive(maximumAuthorizedUsd) || !authorization.source || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 28800000 || !positive(authorization.cumulativeCapUsd) || authorization.cumulativeCapUsd > maximumAuthorizedUsd) throw new Error('paid_authorization_invalid');
    if (new Set(previous.map(row => row.requestId)).size !== previous.length || previous.some(row => {
      if (!row.requestId || !positive(row.reservedUsd) || !['reserved', 'reported', 'failed_unknown'].includes(row.state)) return true;
      return row.state === 'reported' ? row.estimatedUsd === null || !Number.isFinite(row.estimatedUsd) || row.estimatedUsd < 0 || row.estimatedUsd > row.reservedUsd : row.estimatedUsd !== null;
    })) throw new Error('paid_prior_evidence_invalid');
    this.authorization = structuredClone(authorization); this.attempts = structuredClone([...previous]);
    this.boundViolated = previous.some(row => row.boundViolated === true);
    if (this.accounted() > authorization.cumulativeCapUsd) throw new Error('paid_cumulative_cap_exceeded');
  }
  private accounted(): number { return money(this.attempts.reduce((sum, row) => sum + (row.state === 'reported' ? row.estimatedUsd! : row.reservedUsd), 0)); }
  private assertActive(): void {
    if (this.boundViolated) throw new Error('paid_bound_violation_terminal');
    const now = this.now();
    if (!Number.isFinite(now) || now < Date.parse(this.authorization.startedAt) || now >= Date.parse(this.authorization.expiresAt)) throw new Error('paid_continuation_window_expired');
    if (!Number.isFinite(this.accounted()) || this.accounted() > this.authorization.cumulativeCapUsd) throw new Error('paid_cumulative_cap_exceeded');
  }
  /** Read-only check at dispatch; a held reservation never renews authorization. */
  assertDispatchAllowed(requestId: string): void {
    this.assertActive();
    if (!requestId || !this.attempts.some(row => row.requestId === requestId && row.state === 'reserved')) throw new Error('paid_dispatch_reserved_identity_unavailable');
  }
  reserve(requestId: string, reservedUsd: number): void {
    this.assertActive();
    if (!requestId || this.attempts.some(row => row.requestId === requestId)) throw new Error('paid_request_identity_invalid');
    if (!positive(reservedUsd)) throw new Error('paid_request_reservation_invalid');
    if (money(this.accounted() + reservedUsd) > this.authorization.cumulativeCapUsd) throw new Error('paid_cumulative_cap_exceeded');
    this.attempts.push({ requestId, reservedUsd, estimatedUsd: null, state: 'reserved' });
  }
  settle(requestId: string, estimatedUsd: number | null): void {
    const row = this.attempts.find(row => row.requestId === requestId);
    if (!row || row.state !== 'reserved') throw new Error('paid_request_already_settled_or_missing');
    if (estimatedUsd !== null && (!Number.isFinite(estimatedUsd) || estimatedUsd < 0 || estimatedUsd > row.reservedUsd)) {
      row.state = 'failed_unknown'; row.boundViolated = true; this.boundViolated = true; throw new Error('paid_reported_cost_exceeds_bound');
    }
    row.estimatedUsd = estimatedUsd; row.state = estimatedUsd === null ? 'failed_unknown' : 'reported';
  }
  snapshot() { return { authorization: structuredClone(this.authorization), attempts: structuredClone(this.attempts), accountedUsd: this.accounted(), actualCostUnknown: this.attempts.some(row => row.state !== 'reported'), boundViolated: this.boundViolated }; }
}
