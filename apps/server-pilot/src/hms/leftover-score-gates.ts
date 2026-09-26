/**
 * Diagnostic candidate gates. Historical email-bound scoring stays strict;
 * assisted tests may opt into their explicitly documented source labels.
 */

export type CandidateSrc =
  | 'email_own'
  | 'email_own_softok'
  | 'case_linked'
  | 'manual'
  | 'gold'
  | 'gold_derived'
  | 'assisted'
  | 'fallback'
  | 'provided'
  | 'no_conf'
  | 'softopen_ok_pool_rotate';

export function assertScorableCandidate(
  src: CandidateSrc | string,
  options: { allowAssisted?: boolean } = {},
): boolean {
  if (src === 'email_own' || src === 'email_own_softok' || src === 'case_linked') return true;
  return (
    options.allowAssisted === true &&
    new Set(['manual', 'gold', 'gold_derived', 'assisted', 'fallback', 'provided']).has(src)
  );
}

export function stayIdRateAmongHits(
  rows: ReadonlyArray<{ find: string; stayId: boolean }>,
): number {
  const hits = rows.filter((r) => r.find === 'hit');
  if (hits.length === 0) return 0;
  return hits.filter((r) => r.stayId).length / hits.length;
}

export function folioPayloadOk(input: {
  folioBalance: string | null | undefined;
  currency: string | null | undefined;
}): boolean {
  const bal = (input.folioBalance ?? '').trim();
  const cur = (input.currency ?? '').trim();
  return /^-?(?:0|[1-9]\d*)\.\d{2}$/.test(bal) && /^[A-Z]{3}$/.test(cur);
}

export function filterEmailOwnCandidates<T extends { src?: string }>(
  candidates: ReadonlyArray<T>,
): T[] {
  return candidates.filter((c) => assertScorableCandidate(c.src ?? ''));
}
