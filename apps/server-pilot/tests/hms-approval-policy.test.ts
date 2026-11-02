import { describe, expect, it } from 'vitest';
import { terminalWriteRequiresReconciliation } from '../src/ai/hms-approval-policy.js';

describe('terminal HMS approval safety', () => {
  it.each(['NEEDS_CHECK', 'UNKNOWN', 'POLICY_BLOCK', null])(
    'blocks consumed unsuccessful runs with failure %s', (failureClass) => {
      expect(terminalWriteRequiresReconciliation({ state: 'dead_letter', failureClass, consumed: true })).toBe(true);
      expect(terminalWriteRequiresReconciliation({ state: 'dead_letter', failureClass, consumed: false })).toBe(false);
    },
  );
  it('keeps lost leases blocked even if no consumption is recorded', () => {
    expect(terminalWriteRequiresReconciliation({ state: 'dead_letter', failureClass: 'LEASE_LOST', consumed: false })).toBe(true);
  });
  it('does not block verified success because its grant was consumed', () => {
    expect(terminalWriteRequiresReconciliation({ state: 'succeeded', failureClass: null, consumed: true })).toBe(false);
  });
});
