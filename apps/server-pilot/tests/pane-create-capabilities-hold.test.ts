import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPilotCapabilities } from '../src/trpc/routes/brain.js';

const writeFlags = ['PANE_WRITE_CREATE', 'PANE_WRITE_AMEND_UNPAID', 'PANE_WRITE_AMEND_PAID',
  'PANE_WRITE_CANCEL_UNPAID', 'PANE_WRITE_CANCEL_PAID', 'PANE_WRITE_ATTACH'] as const;

afterEach(() => vi.unstubAllEnvs());

describe('held pane create capability', () => {
  it('reports create off while preserving independent amendment and cancellation modes', () => {
    for (const flag of writeFlags) vi.stubEnv(flag, undefined);
    vi.stubEnv('PANE_WRITE_CREATE', 'on');
    vi.stubEnv('PANE_WRITE_AMEND_UNPAID', 'lab');
    vi.stubEnv('PANE_WRITE_CANCEL_UNPAID', 'on');
    expect(getPilotCapabilities()).toMatchObject({ paneSave: false, paneSaveMode: 'off',
      paneWrite: { create: 'off', amendUnpaid: 'lab', cancelUnpaid: 'on' } });
  });

  it('does not advertise legacy create even when the legacy setting is enabled', () => {
    for (const flag of writeFlags) vi.stubEnv(flag, undefined);
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    expect(getPilotCapabilities()).toMatchObject({ paneSave: false, paneSaveMode: 'off',
      paneWrite: { create: 'off', amendUnpaid: 'lab', cancelUnpaid: 'lab' }, paneAttach: 'lab' });
  });

  it('advertises only the independently enabled Labtest attachment mode', () => {
    for (const flag of writeFlags) vi.stubEnv(flag, undefined);
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'off');
    for (const [value, expected] of [['off', 'off'], ['lab', 'lab'], ['on', 'off'], ['invalid', 'off']] as const) {
      vi.stubEnv('PANE_WRITE_ATTACH', value);
      expect(getPilotCapabilities()).toMatchObject({ paneSave: false, paneAttach: expected, paneWrite: { create: 'off' } });
    }
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    vi.stubEnv('PANE_WRITE_ATTACH', 'off');
    expect(getPilotCapabilities()).toMatchObject({ paneSave: false, paneAttach: 'off' });
  });

});
