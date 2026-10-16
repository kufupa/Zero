export type TreatAsChoice = 'quote' | 'create_booking';

/** Same per-mail key as pane-edits (`paneEditKey`); own prefix so group JSON stays v1. */
const PREFIX = 'nava.treat-as:';

export function rememberTreatAs(mailKey: string, treatAs: TreatAsChoice): void {
  if (!mailKey) return;
  try {
    sessionStorage.setItem(`${PREFIX}${mailKey}`, treatAs);
  } catch {
    // Choice lasts this mount only when storage is blocked.
  }
}

export function readTreatAs(mailKey: string): TreatAsChoice | null {
  if (!mailKey) return null;
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${mailKey}`);
    return raw === 'quote' || raw === 'create_booking' ? raw : null;
  } catch {
    return null;
  }
}
