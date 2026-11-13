const LEGACY_ROW_BOARD = /^(stays\[[A-Za-z0-9_-]{1,40}\]\.rows\[[A-Za-z0-9_-]{1,40}\])\.board$/;

/** Convert only persisted field paths; active requests must already use canonical paths. */
export function hydrateStoredFieldPath(path: string): string {
  return path.replace(LEGACY_ROW_BOARD, '$1.mealPlan');
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
