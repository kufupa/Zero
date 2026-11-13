const LEGACY_REQUEST_AGENCY = /^(requests\[[a-f0-9]{64}\]\.(?:rows\[[A-Za-z0-9_-]{1,40}\]\.rooms\[[0-7]\]\.)?parties)\.agency$/;
const REQUEST_BOOKING_AGENCY = /^(requests\[[a-f0-9]{64}\]\.(?:rows\[[A-Za-z0-9_-]{1,40}\]\.rooms\[[0-7]\]\.)?parties)\.bookingAgency$/;
const LEGACY_ROW_BOARD = /^(stays\[[A-Za-z0-9_-]{1,40}\]\.rows\[[A-Za-z0-9_-]{1,40}\])\.board$/;

/** Convert only persisted field paths; active requests must already use canonical paths. */
export function hydrateStoredFieldPath(path: string): string {
  if (path === 'contact.company') return 'contact.bookingAgency';
  if (path === 'contact.endClient') return 'contact.organization';
  return path.replace(LEGACY_ROW_BOARD, '$1.mealPlan').replace(LEGACY_REQUEST_AGENCY, '$1.bookingAgency');
}

export function storedFieldPathAliases(path: string): string[] {
  if (path === 'contact.bookingAgency') return [path, 'contact.company'];
  if (path === 'contact.organization') return [path, 'contact.endClient'];
  if (REQUEST_BOOKING_AGENCY.test(path)) return [path, path.replace(REQUEST_BOOKING_AGENCY, '$1.agency')];
  return [path, path.replace(/^(stays\[[A-Za-z0-9_-]{1,40}\]\.rows\[[A-Za-z0-9_-]{1,40}\])\.mealPlan$/, '$1.board')];
}

export function hydrateStoredWorkState(state: Record<string, unknown>): Record<string, unknown> {
  const hydrated = { ...state };
  for (const [path, value] of Object.entries(state)) {
    const canonical = hydrateStoredFieldPath(path);
    if (canonical === path) continue;
    if (!Object.hasOwn(hydrated, canonical)) hydrated[canonical] = value;
    delete hydrated[path];
  }
  return hydrated;
}
