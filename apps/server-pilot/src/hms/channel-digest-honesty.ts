/**
 * Channel live digest row honesty: envelope-ok with zero fields is not ok.
 */
export function channelDigestRowOk(row: {
  ok?: boolean;
  fields?: Record<string, boolean | null | undefined>;
}): boolean {
  if (!row.ok) return false;
  const fields = row.fields ?? {};
  return Object.values(fields).some((v) => v === true);
}
