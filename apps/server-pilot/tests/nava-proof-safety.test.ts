import { describe, expect, it } from 'vitest';
import {
  allowEditsFrom,
  mailboxFailures,
  MailboxSwitchError,
  needsEditsMessage,
  newMailboxPermit,
  newMailboxSwitch,
  takeMailboxPermit,
  withActiveMailbox,
  withMailboxPermit,
  type MailboxApi,
} from '../scripts/nava-proof-safety';
import { classifyAe4Request } from '../scripts/nava-ae4-override-proof';

const BASE = 'https://nava.example.test';
const SET_DEFAULT = `${BASE}/api/trpc/connections.setDefault?batch=1`;
const body = (connectionId: string) => JSON.stringify({ 0: { json: { connectionId } } });

/** A mocked account: two linked mailboxes, one default, and a log of every call. */
function account(options: { default?: string; linked?: string[]; failSet?: (id: string, n: number) => boolean } = {}) {
  let current = options.default ?? 'transport-nava';
  const linked = options.linked ?? ['transport-nava', 'transport-centurion'];
  const calls: string[] = [];
  let sets = 0;
  const api: MailboxApi = {
    async getDefault() {
      calls.push('getDefault');
      return current;
    },
    async list() {
      calls.push('list');
      return linked;
    },
    async setDefault(id) {
      sets += 1;
      calls.push(`setDefault:${id}`);
      if (options.failSet?.(id, sets)) throw new Error('connections.setDefault: INTERNAL_SERVER_ERROR');
      current = id;
    },
  };
  return { api, calls, current: () => current };
}

const quiet = () => undefined;

describe('withActiveMailbox', () => {
  it('switches to the run transport for the body and restores the previous default after', async () => {
    const mock = account();
    const record = newMailboxSwitch();
    let during: string | null = null;
    const value = await withActiveMailbox(mock.api, 'transport-centurion', record, quiet, async () => {
      during = mock.current();
      return 'done';
    });
    expect(value).toBe('done');
    expect(during).toBe('transport-centurion');
    expect(mock.current()).toBe('transport-nava');
    expect(record).toEqual({
      activeMailboxSwitched: true,
      restored: true,
      target: 'transport-centurion',
      previousDefault: 'transport-nava',
      restoreError: null,
    });
    expect(mock.calls.filter((call) => call.startsWith('setDefault'))).toEqual([
      'setDefault:transport-centurion',
      'setDefault:transport-nava',
    ]);
    expect(mailboxFailures(record)).toEqual([]);
  });

  it('switches nothing when the run transport is already the default', async () => {
    const mock = account({ default: 'transport-centurion' });
    const record = newMailboxSwitch();
    await withActiveMailbox(mock.api, 'transport-centurion', record, quiet, async () => undefined);
    expect(record).toMatchObject({ activeMailboxSwitched: false, restored: false, previousDefault: 'transport-centurion' });
    expect(mock.calls).toEqual(['getDefault']);
    expect(mailboxFailures(record)).toEqual([]);
  });

  it('switches nothing without a run transport', async () => {
    const mock = account();
    const record = newMailboxSwitch();
    await withActiveMailbox(mock.api, null, record, quiet, async () => undefined);
    expect(mock.calls).toEqual([]);
    expect(record.activeMailboxSwitched).toBe(false);
  });

  it('restores the default when the body fails, and passes the failure on', async () => {
    const mock = account();
    const record = newMailboxSwitch();
    await expect(
      withActiveMailbox(mock.api, 'transport-centurion', record, quiet, async () => {
        throw new Error('timed out: the PDF');
      }),
    ).rejects.toThrow('timed out: the PDF');
    expect(mock.current()).toBe('transport-nava');
    expect(record).toMatchObject({ activeMailboxSwitched: true, restored: true });
  });

  it('refuses a transport the account is not linked to, without a write', async () => {
    const mock = account({ linked: ['transport-nava'] });
    const record = newMailboxSwitch();
    let ran = false;
    await expect(
      withActiveMailbox(mock.api, 'transport-centurion', record, quiet, async () => {
        ran = true;
      }),
    ).rejects.toThrow(MailboxSwitchError);
    expect(ran).toBe(false);
    expect(mock.calls.some((call) => call.startsWith('setDefault'))).toBe(false);
    expect(record.activeMailboxSwitched).toBe(false);
  });

  it('stops before the body when the switch fails, and checks the default is still the old one', async () => {
    const mock = account({ failSet: (id) => id === 'transport-centurion' });
    const record = newMailboxSwitch();
    let ran = false;
    await expect(
      withActiveMailbox(mock.api, 'transport-centurion', record, quiet, async () => {
        ran = true;
      }),
    ).rejects.toThrow('mailbox_switch_failed');
    expect(ran).toBe(false);
    expect(mock.current()).toBe('transport-nava');
    // Tried, and the default is confirmed back (it never moved), so the run is not failed for the restore.
    expect(record).toMatchObject({ activeMailboxSwitched: true, restored: true });
  });

  it('retries a failed restore once', async () => {
    const mock = account({ failSet: (id, n) => id === 'transport-nava' && n === 2 });
    const record = newMailboxSwitch();
    await withActiveMailbox(mock.api, 'transport-centurion', record, quiet, async () => undefined);
    expect(mock.current()).toBe('transport-nava');
    expect(record.restored).toBe(true);
  });

  it('records and logs a restore that fails, and the summary fails the run', async () => {
    const mock = account({ failSet: (id) => id === 'transport-nava' });
    const record = newMailboxSwitch();
    const lines: string[] = [];
    await withActiveMailbox(mock.api, 'transport-centurion', record, (line) => lines.push(line), async () => undefined);
    expect(mock.current()).toBe('transport-centurion');
    expect(record).toMatchObject({ activeMailboxSwitched: true, restored: false });
    expect(record.restoreError).toContain('INTERNAL_SERVER_ERROR');
    expect(lines.some((line) => line.includes('RESTORE FAILED'))).toBe(true);
    expect(mailboxFailures(record)).toEqual(['the default mailbox was not restored after the run']);
  });

  it('does not leave signal handlers behind', async () => {
    const before = process.listenerCount('SIGTERM');
    await withActiveMailbox(account().api, 'transport-centurion', newMailboxSwitch(), quiet, async () => undefined);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('the setDefault permit', () => {
  it('lets through only the armed setDefault, once', () => {
    const permit = newMailboxPermit();
    expect(takeMailboxPermit(SET_DEFAULT, body('transport-centurion'), permit)).toBe(false);
    permit.connectionId = 'transport-centurion';
    expect(takeMailboxPermit(SET_DEFAULT, body('transport-nava'), permit)).toBe(false);
    expect(takeMailboxPermit(`${BASE}/api/trpc/connections.setDefault,mail.get?batch=1`, body('transport-centurion'), permit)).toBe(
      false,
    );
    expect(takeMailboxPermit(SET_DEFAULT, body('transport-centurion'), permit)).toBe(true);
    expect(permit.connectionId).toBeNull();
    expect(takeMailboxPermit(SET_DEFAULT, body('transport-centurion'), permit)).toBe(false);
  });

  it('caps the driver at the switch, the restore and one retry', () => {
    const permit = newMailboxPermit();
    for (let i = 0; i < 3; i++) {
      permit.connectionId = 'transport-nava';
      expect(takeMailboxPermit(SET_DEFAULT, body('transport-nava'), permit)).toBe(true);
    }
    permit.connectionId = 'transport-nava';
    expect(takeMailboxPermit(SET_DEFAULT, body('transport-nava'), permit)).toBe(false);
  });

  it("keeps the driver's guard for everything else: a setDefault from the pane is blocked", () => {
    const permit = newMailboxPermit();
    const classify = withMailboxPermit((url, postData) => classifyAe4Request(url, postData, { hmsReads: 0 }), permit);
    expect(classify(SET_DEFAULT, body('transport-centurion'))).toMatchObject({
      allowed: false,
      blocked: [{ procedure: 'connections.setDefault' }],
    });
    permit.connectionId = 'transport-centurion';
    expect(classify(SET_DEFAULT, body('transport-centurion')).allowed).toBe(true);
    expect(classify(`${BASE}/api/trpc/mail.get?batch=1`, null).allowed).toBe(true);
  });
});

describe('edits to a real thread', () => {
  it('are off unless NAVA_PROOF_ALLOW_EDITS=1', () => {
    expect(allowEditsFrom({})).toBe(false);
    expect(allowEditsFrom({ NAVA_PROOF_ALLOW_EDITS: 'true' })).toBe(false);
    expect(allowEditsFrom({ NAVA_PROOF_ALLOW_EDITS: ' 1 ' })).toBe(true);
  });

  it('name the fields in the blocker', () => {
    expect(needsEditsMessage(['rooms', 'adults'])).toBe('needs_edits:rooms,adults');
  });
});
