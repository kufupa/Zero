import type { PilotCapabilities } from '@zero/server/driver/types';

export const PILOT_CAPABILITIES = {
  ai: false,
  brain: false,
  notes: false,
  templates: false,
  bimi: false,
  gmailSearchGrammar: false,
  hotelCategories: true,
  staleDraftWarning: true,
} satisfies PilotCapabilities;

export type LegacySurface = 'ai' | 'brain' | 'notes' | 'templates' | 'bimi';

export function shouldRenderLegacySurface(surface: LegacySurface): boolean {
  return PILOT_CAPABILITIES[surface];
}
