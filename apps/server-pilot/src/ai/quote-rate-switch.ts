/**
 * Kill switch for HMS rate context. QUOTE_RATE_CONTEXT=off turns every party lookup off, so no quote sends a rate
 * context. Any other value, or none, keeps it on.
 */
export function quoteRateContextEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.QUOTE_RATE_CONTEXT?.trim().toLowerCase() !== 'off';
}
