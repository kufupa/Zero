/** A consumed terminal run is uncertain until reconciliation, even after a pre-Save refusal. */
export function terminalWriteRequiresReconciliation(input: {
  state: string;
  failureClass: string | null;
  consumed: boolean;
}): boolean {
  return input.failureClass === 'LEASE_LOST' || (input.state !== 'succeeded' && input.consumed);
}
