export function staffPrepareOnly(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === '1';
}

export function createPilotRequested(): boolean {
  return staffPrepareOnly() || process.env.NAVA_CREATE_PILOT === '1';
}

export function hmsSaveEnabled(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === undefined && process.env.NAVA_HMS_SAVE_ENABLED === '1';
}

/** Staff Go: a signed staff click saves a prepared Create in HMS (real guest or Labtest). The model never saves. */
// NAVA_CREATE_GO=labtest: staff Go saves only Proof Labtest 2027+ stays (CMS off). NAVA_CREATE_GO=on: real guests too.
export function createGoEnabled(): boolean {
  return staffPrepareOnly() && (process.env.NAVA_CREATE_GO === 'labtest' || process.env.NAVA_CREATE_GO === 'on');
}

export function createGoRealGuests(): boolean {
  return staffPrepareOnly() && process.env.NAVA_CREATE_GO === 'on';
}

export function nativeSaveAllowed(): boolean {
  return hmsSaveEnabled() || createGoEnabled();
}

export function configuredToolPacks(): string[] | undefined {
  if (process.env.NAVA_QUOTE_SKELETON === '1') return ['quote','skills'];
  if (staffPrepareOnly()) return ['quote','create','amend','cancel','filing','triage','skills'];
  if (createPilotRequested()) return ['create','skills'];
}
