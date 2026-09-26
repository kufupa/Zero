export function emailsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = (left ?? '').trim().toLowerCase();
  const b = (right ?? '').trim().toLowerCase();
  return a.length > 0 && a === b;
}
