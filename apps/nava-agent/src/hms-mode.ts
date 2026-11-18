import type { Workflow } from './schema.js';

const writeWorkflows = ['create','amend','cancel','filing'] as const;
export const maxStaffHmsSlots = 12;
export function staffSlotCount(value:string) {
  return /^[1-9]\d*$/.test(value) && Number(value)<=maxStaffHmsSlots;
}

export type WriteWorkflow = (typeof writeWorkflows)[number];
export function isWriteWorkflow(workflow: Workflow): workflow is WriteWorkflow {
  return writeWorkflows.some(value=>value===workflow);
}

export function staffPrepareOnly(): boolean {
  return process.env.NAVA_CREATE_PREPARE_ONLY === '1'; // staff mode; Go always available in it (ship mode)
}

export function createPilotRequested(): boolean {
  return staffPrepareOnly() || process.env.NAVA_CREATE_PILOT === '1';
}

export function hmsSaveEnabled(): boolean {
  return !staffPrepareOnly();
}

/** Staff Go: a signed staff click saves a prepared Create in HMS (real guest or Labtest). The model never saves. */
export function createGoEnabled(): boolean {
  return staffPrepareOnly();
}

export function createGoRealGuests(): boolean {
  return staffPrepareOnly();
}

export function nativeSaveAllowed(): boolean {
  return hmsSaveEnabled() || createGoEnabled();
}

export function configuredToolPacks(): string[] | undefined {
  if (process.env.NAVA_QUOTE_SKELETON === '1') return ['quote','skills'];
  if (staffPrepareOnly()) return ['quote','create','amend','cancel','filing','triage','skills'];
  if (createPilotRequested()) return ['create','skills'];
}
