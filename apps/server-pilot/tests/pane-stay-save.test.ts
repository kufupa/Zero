import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLabStayGuard,
  paneStaySaveEnabled,
  paneStaySaveLoaders,
  runPaneStay,
} from '../src/ai/pane-stay-save.js';

const labStay = {
  firstName: 'Pat',
  lastName: 'Labtest',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  roomType: 'SUITE',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Awaiting Voucher',
};

describe('pane stay save guards', () => {
  afterEach(() => {
    paneStaySaveLoaders.spawn = null;
    paneStaySaveLoaders.lock = null;
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.enabled = null;
  });

  it('is off unless RESERVATIONIST_PANE_SAVE is on', () => {
    expect(paneStaySaveEnabled({})).toBe(false);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(false);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe(true);
  });

  it('requires Labtest last name and arrival in 2027 or later', () => {
    expect(() =>
      assertLabStayGuard({ lastName: 'Labtest', arrivalDate: '2027-01-01' }),
    ).not.toThrow();
    expect(() =>
      assertLabStayGuard({ lastName: 'Guest', arrivalDate: '2027-01-01' }),
    ).toThrow(/labtest/i);
    expect(() =>
      assertLabStayGuard({ lastName: 'Labtest', arrivalDate: '2026-12-31' }),
    ).toThrow(/2027/);
  });

  it('refuses preview and commit when the flag is unset', async () => {
    paneStaySaveLoaders.enabled = () => false;
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(runPaneStay({ mode: 'preview', stay: labStay })).resolves.toMatchObject({
      status: 'refused',
      reason: 'pane_save_flag_off',
    });
    await expect(runPaneStay({ mode: 'commit', stay: labStay })).resolves.toMatchObject({
      status: 'refused',
      reason: 'pane_save_flag_off',
    });
  });

  it('preview fills and checks availability under the property lock without saving', async () => {
    const seen: string[] = [];
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.lock = {
      withLock: async (fn) => {
        seen.push('lock');
        return fn();
      },
    };
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input.stopBefore ?? 'none');
      expect(input.paneCommit).toBeFalsy();
      return { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    };
    const result = await runPaneStay({ mode: 'preview', stay: labStay });
    expect(result).toMatchObject({ status: 'ok', outcome: 'previewed' });
    expect(seen).toEqual(['lock', 'save']);
  });

  it('commit refuses when OSRESS finds a duplicate stay', async () => {
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'duplicate';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(runPaneStay({ mode: 'commit', stay: labStay })).resolves.toMatchObject({
      status: 'refused',
      reason: 'osress_duplicate',
    });
  });

  it('commit refuses when the OSRESS guest-date reader is parked', async () => {
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(runPaneStay({ mode: 'commit', stay: labStay })).resolves.toMatchObject({
      status: 'refused',
      reason: 'osress_reader_parked',
    });
  });

  it('commit spawns a fresh fill under lock and returns the confirmation', async () => {
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'clear';
    paneStaySaveLoaders.lock = {
      withLock: async (fn) => fn(),
    };
    paneStaySaveLoaders.spawn = async (input) => {
      expect(input.paneCommit).toBe(true);
      expect(input.stopBefore).toBeNull();
      return { outcome: 'committed', clickedSave: true, confirmationNumber: '46184891-1' };
    };
    const result = await runPaneStay({ mode: 'commit', stay: labStay });
    expect(result).toMatchObject({
      status: 'ok',
      outcome: 'committed',
      confirmationNumber: '46184891-1',
    });
  });

  it('does not reuse a preview session for commit', async () => {
    const sessions: string[] = [];
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'clear';
    paneStaySaveLoaders.lock = {
      withLock: async (fn) => fn(),
    };
    paneStaySaveLoaders.spawn = async (input) => {
      sessions.push(input.paneCommit ? 'commit' : 'preview');
      return {
        outcome: input.paneCommit ? 'committed' : 'previewed',
        clickedSave: Boolean(input.paneCommit),
        confirmationNumber: input.paneCommit ? '1' : '',
      };
    };
    await runPaneStay({ mode: 'preview', stay: labStay });
    await runPaneStay({ mode: 'commit', stay: labStay });
    expect(sessions).toEqual(['preview', 'commit']);
  });
});
