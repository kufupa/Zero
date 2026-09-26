/**
 * Unique-email soft gate for group/company leftovers.
 * Surface-only probes (n paths, no email ids) never pass.
 */

export type UniqueEmailRow = {
  emailId: string;
  code: string;
  lstHit: boolean;
};

export function uniqueEmailSoftPass(
  rows: ReadonlyArray<UniqueEmailRow>,
  minUnique = 10,
): { uniqueOk: number; pass: boolean } {
  const ok = new Set(rows.filter((r) => r.lstHit && r.emailId && r.code).map((r) => r.emailId));
  return { uniqueOk: ok.size, pass: ok.size >= minUnique };
}

/** 4 surface probes without email binding → fail. */
export function surfaceOnlyProbesPass(probeCount: number, emailBoundUniqueOk: number): boolean {
  if (probeCount > 0 && emailBoundUniqueOk === 0) return false;
  return emailBoundUniqueOk >= 10;
}
