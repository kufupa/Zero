/** HMS conf = `<base 6-10 digits>-<leg 1-2 digits>`. Guests often write the base only. */

const LEG_FORM = /^(\d{6,10})-(\d{1,2})$/;
const BARE_BASE = /^\d{6,10}$/;

export type ConfirmationMatchStrategy = 'confirmation' | 'confirmation_leg_retry';

export function confirmationBase(value: string): string {
  const trimmed = value.trim().toUpperCase();
  const dashed = LEG_FORM.exec(trimmed);
  return dashed ? dashed[1]! : trimmed;
}

export function confirmationHasLeg(value: string): boolean {
  return LEG_FORM.test(value.trim().toUpperCase());
}

/** Exact equality wins. Bare candidate (no leg) also matches rows with the same base. */
export function confirmationMatches(candidate: string, rowConf: string): boolean {
  const target = candidate.trim().toUpperCase();
  const row = rowConf.trim().toUpperCase();
  if (!target || !row) return false;
  if (target === row) return true;
  if (confirmationHasLeg(candidate)) return false;
  return confirmationBase(row) === target;
}

export function confirmationSearchValues(
  value: string,
): Array<{ searchValue: string; matchedBy: ConfirmationMatchStrategy }> {
  const trimmed = value.trim();
  if (BARE_BASE.test(trimmed)) {
    return [
      { searchValue: trimmed, matchedBy: 'confirmation' },
      { searchValue: `${trimmed}-1`, matchedBy: 'confirmation_leg_retry' },
    ];
  }
  return [{ searchValue: trimmed, matchedBy: 'confirmation' }];
}
