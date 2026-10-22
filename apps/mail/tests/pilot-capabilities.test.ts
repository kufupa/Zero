import { describe, expect, it } from 'vitest';
import { PILOT_CAPABILITIES, shouldRenderLegacySurface } from '../lib/pilot/capabilities';

describe('pilot capabilities', () => {
  it('hides legacy-only surfaces in pilot mode', () => {
    expect(PILOT_CAPABILITIES).toMatchObject({
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
      paneSaveMode: 'off',
      paneWrite: {
        create: 'off',
        amendUnpaid: 'off',
        amendPaid: 'off',
        cancelUnpaid: 'off',
        cancelPaid: 'off',
      },
    });

    expect(shouldRenderLegacySurface('ai')).toBe(false);
    expect(shouldRenderLegacySurface('notes')).toBe(false);
    expect(shouldRenderLegacySurface('templates')).toBe(false);
    expect(shouldRenderLegacySurface('bimi')).toBe(false);
  });
});
