import { INCLUDED_READ_TOOL_IDS, type IncludedReadToolId } from '../../../../../../apps/server-pilot/src/hms/read-tools.js';

/** Exact opt-in subset for connected diagnostics; identity reads always precede it. */
export function selectConnectedProbeTools(raw: string | undefined, allTools: boolean): IncludedReadToolId[] {
  const baseline: IncludedReadToolId[] = ['hms_find_reservation', 'hms_read_reservation'];
  if (raw === undefined) return allTools ? [...new Set([...baseline, ...INCLUDED_READ_TOOL_IDS])] : baseline;
  const requested = raw.split(',').map((value) => value.trim());
  if (requested.some((value) => !INCLUDED_READ_TOOL_IDS.some((toolId) => toolId === value))) {
    throw new Error('CONNECTED_TOOL_SELECTION');
  }
  return [...new Set([...baseline, ...requested as IncludedReadToolId[]])];
}
