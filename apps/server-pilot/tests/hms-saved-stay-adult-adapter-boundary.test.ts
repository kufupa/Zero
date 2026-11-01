import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  run: vi.fn(async (_page: unknown, _options: unknown) => ({ outcome: 'not_dispatched' })),
}));
vi.mock('../tooling/hms-cloud/labtest-amend-save.mjs', () => ({ runLabtestAmendSave: fixture.run }));

import { stageLabtestAdultAmendment } from '../tooling/hms-cloud/guest-stay-amend-adults.mjs';

describe('adult amendment save-helper boundary', () => {
  it('always invokes the shared lifecycle in prepare-only mode with no matching Save request', async () => {
    fixture.run.mockClear();
    const page = {};
    const expected = {
      confirmation: '12345678-1', guestId: '42', arrival: '2027-01-15', departure: '2027-01-16',
      roomType: 'DLX', ratePlan: 'BAR', note: '', adults: 1,
    };
    await stageLabtestAdultAmendment(page, expected, { adults: 2 });
    expect(fixture.run).toHaveBeenCalledOnce();
    const config = fixture.run.mock.calls[0]![1] as { prepareOnly: boolean; matches: () => boolean };
    expect(config.prepareOnly).toBe(true);
    expect(config.matches()).toBe(false);
  });
});
