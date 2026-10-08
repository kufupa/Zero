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
  // Pane Preview/Book in HMS stay off until the server flag RESERVATIONIST_PANE_SAVE is on.
  paneSave: false,
} satisfies PilotCapabilities;

export function canUseNaturalLanguageSearch(): boolean {
  return PILOT_CAPABILITIES.ai && PILOT_CAPABILITIES.gmailSearchGrammar;
}

export type LegacySurface = 'ai' | 'brain' | 'notes' | 'templates' | 'bimi';

export function shouldRenderLegacySurface(surface: LegacySurface): boolean {
  return PILOT_CAPABILITIES[surface];
}
