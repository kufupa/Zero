export function createPilotRequested(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === '1' || process.env.NAVA_CREATE_PILOT === '1';
}

export function hmsSaveEnabled(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === undefined && process.env.NAVA_HMS_SAVE_ENABLED === '1';
}
