/** A native notice is not evidence that HMS posted a charge. Keep the decimal as displayed. */
export function cancellationPenaltyNotice(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const match = /^Cancellation Penalty of (\d{1,12}\.\d{2}) may be added to account\.(?: OK)?$/.exec(value.replace(/\s+/g, ' ').trim());
  return match ? { text: `Cancellation Penalty of ${match[1]} may be added to account.`,
    amount: match[1], currency: null } : null;
}
