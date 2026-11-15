export type StaySearchCompleteness = {
  searchedDateRange: { from: string; to: string } | null;
  searchedRanges: Array<{ from: string; to: string }>;
  requestedDateHorizon: { from: string; to: string } | null;
  displayed: number | null;
  total: number | null;
  gridComplete: boolean;
  requestedDatesCovered: boolean;
  allChunksSearched: boolean;
  truncated: boolean;
};

function range(value: unknown): { from: string; to: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const day = (input: unknown): input is string => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) &&
    Number.isFinite(Date.parse(`${input}T00:00:00Z`)) && new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) === input;
  return day(item.from) && day(item.to) && item.from <= item.to ? { from: item.from, to: item.to } : null;
}

export function parseStaySearchCompleteness(value: unknown): StaySearchCompleteness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const searchedDateRange = item.searchedDateRange === null ? null : range(item.searchedDateRange);
  const requestedDateHorizon = item.requestedDateHorizon === null ? null : range(item.requestedDateHorizon);
  if ((item.searchedDateRange !== null && !searchedDateRange) ||
      (item.requestedDateHorizon !== null && !requestedDateHorizon) || !Array.isArray(item.searchedRanges)) return null;
  const searchedRanges = item.searchedRanges.map(range);
  if (searchedRanges.some((r) => !r)) return null;
  const count = (n: unknown): n is number | null => n === null || typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!count(item.displayed) || !count(item.total) || typeof item.gridComplete !== 'boolean' ||
      typeof item.requestedDatesCovered !== 'boolean' || typeof item.allChunksSearched !== 'boolean' ||
      typeof item.truncated !== 'boolean') return null;
  if (item.gridComplete && (item.displayed === null || item.total === null || item.displayed !== item.total)) return null;
  if (item.requestedDatesCovered && (!requestedDateHorizon || !searchedDateRange ||
      !searchedRanges.some((r) => r && r.from <= requestedDateHorizon.from && r.to >= requestedDateHorizon.from))) return null;
  return { searchedDateRange, searchedRanges: searchedRanges.filter((r): r is NonNullable<typeof r> => r !== null),
    requestedDateHorizon, displayed: item.displayed, total: item.total, gridComplete: item.gridComplete,
    requestedDatesCovered: item.requestedDatesCovered, allChunksSearched: item.allChunksSearched, truncated: item.truncated };
}

export function isStaySearchComplete(value: StaySearchCompleteness): boolean {
  return value.gridComplete && value.requestedDatesCovered && value.allChunksSearched && !value.truncated;
}

export function coversStaySearchHorizon(value: StaySearchCompleteness): boolean {
  if (!value.requestedDateHorizon) return false;
  let next = Date.parse(`${value.requestedDateHorizon.from}T00:00:00Z`);
  const end = Date.parse(`${value.requestedDateHorizon.to}T00:00:00Z`);
  for (const range of [...value.searchedRanges].sort((a, b) => a.from.localeCompare(b.from))) {
    const from = Date.parse(`${range.from}T00:00:00Z`);
    const to = Date.parse(`${range.to}T00:00:00Z`);
    if (from > next) return false;
    if (to >= next) next = to + 86_400_000;
    if (next > end) return true;
  }
  return false;
}
