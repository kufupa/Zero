import { describe, expect, it } from 'vitest';
import { analyseLocalEmail } from '../lib/quote-workflow/analyse-local';

describe('analyseLocalEmail', () => {
  it('does not invent a quoting workflow for a thanks note', () => {
    const analysis = analyseLocalEmail({
      subject: 'Thanks',
      bodyText: 'Thank you for your help yesterday.',
    });
    expect(analysis.intent).toBe('other');
    expect(analysis.groups).toEqual([]);
  });

  it('extracts ISO dates with year and does not default September', () => {
    const analysis = analyseLocalEmail({
      subject: 'Quote request',
      bodyText: 'Please quote 1 room from 2026-11-12 to 2026-11-14 for 2 adults.',
    });
    expect(analysis.intent).toBe('quote');
    expect(analysis.groups[0]?.arrivalDate).toBe('2026-11-12');
    expect(analysis.groups[0]?.departureDate).toBe('2026-11-14');
    expect(analysis.groups[0]?.adults).toBe(2);
  });

  it('ignores attachment filenames when bytes were not admitted', () => {
    const analysis = analyseLocalEmail({
      subject: 'Availability',
      bodyText: 'Please quote rooms.',
      attachmentBytes: [{ id: 'a1', filename: 'rooming-list-2026-09-15.pdf' }],
    });
    expect(analysis.groups[0]?.arrivalDate).toBeUndefined();
    expect(analysis.groups[0]?.fields.arrivalDate).toBe('missing');
  });
});
