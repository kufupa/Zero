import { describe, expect, it } from 'vitest';
import { assertTrackReadyForGuarantee, matchTrackRow, parseTrackLookupText } from '../tooling/hms-cloud/create-request.mjs';

describe('Cloud create track business rules', () => {
  it('selects by description Best Available and stores code BAR', () => {
    const rows = [
      parseTrackLookupText('COR Corporate Rate'),
      parseTrackLookupText('BAR Best Available'),
    ];
    const picked = matchTrackRow(rows, 'Best Available');
    expect(picked?.description).toBe('Best Available');
    expect(picked?.code).toBe('BAR');
    expect(matchTrackRow(rows, 'BAR')?.code).toBe('BAR');
  });

  it('fails a red validation mark before guarantee is opened', () => {
    let guaranteeOpened = false;
    expect(() => {
      assertTrackReadyForGuarantee({
        validation: { invalid: true, messages: ['Invalid value'] },
        averageRate: '1250.00',
      });
      guaranteeOpened = true;
    }).toThrow(/track_invalid:Invalid value/);
    expect(guaranteeOpened).toBe(false);
  });

});
