export function isNamedRefusal(outcome: string | null | undefined): boolean {
  const reason = /^refused:\s*(.+)$/i.exec(outcome?.trim() ?? '')?.[1]?.trim();
  return Boolean(reason && reason.length >= 8 && !/^(?:refused|failed|failure|error|unknown|unavailable|not available|timeout|timed out)\.?$/i.test(reason));
}

export function quoteProofPass(threads: readonly { rates: { outcome: string | null }; blocker: string | null }[]): boolean {
  return threads.length > 0 && threads.every((thread) =>
    thread.blocker === null && (thread.rates.outcome === 'priced' || isNamedRefusal(thread.rates.outcome)));
}
