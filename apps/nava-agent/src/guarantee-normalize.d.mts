export const CREATE_GUARANTEES: Readonly<Record<string, string>>;
/** Accept native codes + display labels; map legacy aliases; refuse unknown. */
export function normalizeGuaranteeCode(raw: unknown): string | null;
