import type { PilotCapabilities } from '@zero/server/driver/types';

export const PILOT_CAPABILITIES = {
  ai: false,
  brain: false,
  notes: false,
  templates: false,
  bimi: false,
  gmailSearchGrammar: true,
  hotelCategories: true,
  staleDraftWarning: true,
  catchupUpload: false,
  paneSave: false,
} satisfies PilotCapabilities;

export function canUseNaturalLanguageSearch(): boolean {
  return PILOT_CAPABILITIES.ai && PILOT_CAPABILITIES.gmailSearchGrammar;
}

export type LegacySurface = 'ai' | 'brain' | 'notes' | 'templates' | 'bimi';

export function shouldRenderLegacySurface(surface: LegacySurface): boolean {
  return PILOT_CAPABILITIES[surface];
}
