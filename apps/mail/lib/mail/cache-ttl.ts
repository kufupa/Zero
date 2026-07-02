/** TanStack persist: never discard hydrated cache on age alone. */
export const PERSIST_MAX_AGE = Infinity;

/** In-memory gc: disable age-based eviction (TanStack supports Infinity). */
export const QUERY_GC_TIME = Infinity;
