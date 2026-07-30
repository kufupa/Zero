export type RequiredRocketseedDbState = {
  required: boolean;
  databaseUrlConfigured: boolean;
  reachable: boolean;
};

export function assertRequiredRocketseedDbReachable(state: RequiredRocketseedDbState): void {
  if (!state.required) return;
  if (!state.databaseUrlConfigured) {
    throw new Error('REQUIRE_ROCKETSEED_DB_TESTS=1 requires DATABASE_URL — fail closed (no skip)');
  }
  if (!state.reachable) {
    throw new Error('Rocketseed required DB probe is unreachable — fail closed (no skip)');
  }
}
