export function staffPrepareOnly(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === '1';
}

export function createPilotRequested(): boolean {
  return staffPrepareOnly() || process.env.NAVA_CREATE_PILOT === '1';
}

export function hmsSaveEnabled(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === undefined && process.env.NAVA_HMS_SAVE_ENABLED === '1';
}

export function configuredToolPacks(): string[] | undefined {
  if (process.env.NAVA_QUOTE_SKELETON === '1') return ['quote','skills'];
  if (staffPrepareOnly()) return ['quote','create','amend','cancel','filing','triage','skills'];
  if (createPilotRequested()) return ['create','skills'];
}
