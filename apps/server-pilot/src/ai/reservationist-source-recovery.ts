export const VOUCHER_REVIEW_RECOVERY_REASON = 'voucher_request_needs_staff_review';

/** Stable staff-review identity for a validated, source-bound voucher citation. */
export function voucherReviewRecoveryId(value: unknown): string | undefined {
  const recovery = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const { sourceRef, sourceHash, messageId, page, start, end, quote } = recovery;
  if (recovery.kind !== 'voucher_review' || recovery.reason !== VOUCHER_REVIEW_RECOVERY_REASON ||
      recovery.disclosure !== 'staff_only' || recovery.sourceKind !== 'message' ||
      typeof messageId !== 'string' || !messageId || typeof sourceRef !== 'string' || sourceRef.length > 512 ||
      sourceRef !== `message:${messageId}` || typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash) ||
      page !== 1 || typeof start !== 'number' || !Number.isSafeInteger(start) ||
      typeof end !== 'number' || !Number.isSafeInteger(end) || start < 0 || end <= start ||
      typeof quote !== 'string' || !quote || quote.length > 4096 || end - start !== quote.length || !/\bvouchers?\b/i.test(quote)) {
    return undefined;
  }
  return `voucher:${sourceRef}:${sourceHash}:${start}:${end}`;
}
