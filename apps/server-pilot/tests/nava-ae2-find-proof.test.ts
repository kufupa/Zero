import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ae2Failures,
  CARD,
  FIND_BUTTON,
  amendmentOf,
  classifyAe2Request,
  findJobOf,
  isSettledJob,
  lookupDatesUsed,
  newAe2GuardState,
  parseAe2Config,
  shownDateToIso,
  type Ae2Summary,
} from '../scripts/nava-ae2-find-proof';
import { KNOWN_WRITE_PROCEDURES } from '../scripts/nava-preview-run';

const BASE = 'https://nava.example.test';
const url = (procedures: string) => `${BASE}/api/trpc/${procedures}?batch=1`;
const body = (...inputs: unknown[]) =>
  JSON.stringify(Object.fromEntries(inputs.map((input, index) => [String(index), { json: input }])));
const FIND = { threadId: 't-1', confirmation: '57291630-1', arrival: '2026-11-01' };
/** The French amendment: booked 1-6 Nov, the guest wants 31 Oct-7 Nov. */
const AE2_AMENDMENT = {
  kind: 'amend',
  confirmationNumber: '57291630-1',
  guestLastName: 'Fixturemann',
  arrival: '2026-11-01',
  departure: '2026-11-06',
  requestedArrival: '2026-10-31',
  requestedDeparture: '2026-11-07',
  requestedChange: 'Add the night of 31 Oct and late checkout',
};

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-ae2-'));
  statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('request guard', () => {
  it('lets reads, the job status and one queued find through, and keeps the arrival it sent', () => {
    const state = newAe2GuardState();
    expect(classifyAe2Request(url('mail.get,workItems.getByMessage'), null, state).allowed).toBe(true);
    expect(classifyAe2Request(url('paneStayLookup.jobStatus,paneStayLookup.screenshot'), null, state).allowed).toBe(true);
    expect(classifyAe2Request(url('paneStayLookup.queueFind'), body(FIND), state).allowed).toBe(true);
    expect(state).toMatchObject({ queueFinds: 1, sentArrival: '2026-11-01' });
    const second = classifyAe2Request(url('paneStayLookup.queueFind'), body(FIND), state);
    expect(second.blocked).toEqual([{ procedure: 'paneStayLookup.queueFind', reason: 'second_find' }]);
  });

  it('records a find with no arrival as none', () => {
    const state = newAe2GuardState();
    classifyAe2Request(url('paneStayLookup.queueFind'), body({ threadId: 't', confirmation: '1234567-1' }), state);
    expect(state.sentArrival).toBeNull();
  });

  it('lets the synchronous find through only after a queueFind with the queue off, once', () => {
    const state = newAe2GuardState();
    expect(classifyAe2Request(url('paneStayLookup.findStay'), body(FIND), state).blocked[0]?.reason).toBe(
      'sync_find_with_queue',
    );
    classifyAe2Request(url('paneStayLookup.queueFind'), body(FIND), state);
    state.queueOff = true;
    expect(classifyAe2Request(url('paneStayLookup.findStay'), body(FIND), state).allowed).toBe(true);
    expect(classifyAe2Request(url('paneStayLookup.findStay'), body(FIND), state).blocked[0]?.reason).toBe('second_find');
    expect(state.syncFinds).toBe(1);
  });

  it('allows the action-ledger support write and blocks every other write and unknown call', () => {
    const allowed = new Set(['paneStayLookup.queueFind', 'paneStayLookup.findStay', 'workItems.recordActions']);
    expect(classifyAe2Request(url('workItems.recordActions'), null, newAe2GuardState()).allowed).toBe(true);
    const writes = [...KNOWN_WRITE_PROCEDURES].filter((name) => !allowed.has(name));
    expect(writes).toEqual(
      expect.arrayContaining([
        'paneStayLookup.queueSearchGuest',
        'paneStayLookup.searchGuest',
        'paneStayCancel.previewCancel',
        'paneStayCancel.commitCancel',
        'quoteWorkflow.commitStay',
        'drafts.saveReply',
        'workItems.open',
        'workItems.recordEvent',
        'workstation.executeStaffQuote',
      ]),
    );
    for (const name of writes) {
      const decision = classifyAe2Request(url(name), null, newAe2GuardState());
      expect(decision.allowed, name).toBe(false);
      expect(decision.blocked[0]?.reason).toBe('write');
    }
    expect(classifyAe2Request(url('secret.thing'), null, newAe2GuardState()).blocked[0]?.reason).toBe('unknown');
  });

  it('counts nothing from a batch it blocks', () => {
    const state = newAe2GuardState();
    const decision = classifyAe2Request(url('paneStayLookup.queueFind,workItems.open'), body(FIND, {}), state);
    expect(decision.allowed).toBe(false);
    expect(state.queueFinds).toBe(0);
    expect(state.sentArrival).toBeUndefined();
  });
});

describe('the amendment and the job', () => {
  it('reads the booked and requested dates from a stored or a live read, and nothing else', () => {
    const stored = amendmentOf({ status: 'ready', analysis: { amendment: AE2_AMENDMENT } });
    expect(stored).toEqual({
      kind: 'amend',
      booked: { arrival: '2026-11-01', departure: '2026-11-06' },
      requested: { arrival: '2026-10-31', departure: '2026-11-07' },
    });
    expect(JSON.stringify(stored)).not.toContain('Fixturemann');
    expect(JSON.stringify(stored)).not.toContain('57291630');
    expect(amendmentOf({ status: 'ready', amendment: { ...AE2_AMENDMENT, requestedArrival: undefined } })?.requested.arrival).toBeNull();
    expect(amendmentOf({ status: 'ready', analysis: { luna: {} } })).toBeNull();
    expect(amendmentOf(null)).toBeNull();
  });

  it('reads a find job without the guest or the booking number', () => {
    const job = findJobOf({
      runId: 'run-1',
      request: { kind: 'find', confirmation: '57291630-1', arrival: '2026-11-01' },
      prefetch: false,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: '2026-10-10T08:00:00Z',
      result: {
        outcome: 'found',
        stay: { arrival: '2026-11-01', departure: '2026-11-06', lastName: 'Fixturemann', confirmation: '57291630-1' },
        screenshots: ['record.png'],
        runId: 'cli-1',
      },
    });
    expect(job).toEqual({
      runId: 'run-1',
      status: 'done',
      prefetch: false,
      attempts: 1,
      failureClass: null,
      requestArrival: '2026-11-01',
      outcome: 'found',
      stayArrival: '2026-11-01',
      stayDeparture: '2026-11-06',
      arrivalMismatch: false,
    });
    expect(isSettledJob(job)).toBe(true);
    expect(isSettledJob(findJobOf({ status: 'running', request: { kind: 'find' } }))).toBe(false);
    expect(findJobOf({ status: 'done', request: { kind: 'search_guest' } })).toBeNull();
    expect(findJobOf(null)).toBeNull();
  });

  it('reads the dates the card shows', () => {
    expect(shownDateToIso('1 Nov 2026')).toBe('2026-11-01');
    expect(shownDateToIso('14 Oct 2026')).toBe('2026-10-14');
    expect(shownDateToIso('2026-11-06')).toBe('2026-11-06');
    expect(shownDateToIso('Not shown')).toBeNull();
    expect(shownDateToIso('1 Foo 2026')).toBeNull();
  });

  it('tells booked from requested dates', () => {
    const amendment = amendmentOf({ amendment: AE2_AMENDMENT });
    expect(lookupDatesUsed('2026-11-01', amendment)).toBe('booked');
    expect(lookupDatesUsed('2026-10-31', amendment)).toBe('requested');
    expect(lookupDatesUsed('2026-12-01', amendment)).toBe('other');
    expect(lookupDatesUsed(null, amendment)).toBe('none');
    const same = amendmentOf({ amendment: { ...AE2_AMENDMENT, requestedArrival: '2026-11-01' } });
    expect(lookupDatesUsed('2026-11-01', same)).toBe('indistinct');
  });
});

describe('config', () => {
  it('runs on exactly one thread', () => {
    const env = { NAVA_PREVIEW_BASE_URL: BASE, NAVA_PREVIEW_STORAGE_STATE: statePath };
    expect(parseAe2Config(['--threads', 't-1', '--out', dir], env, dir).threadId).toBe('t-1');
    expect(() => parseAe2Config(['--threads', 'a,b'], env, dir)).toThrow('exactly one thread');
    expect(() => parseAe2Config(['--latest', '2'], env, dir)).toThrow('exactly one thread');
  });
});

describe('verdict', () => {
  const passing: Omit<Ae2Summary, 'ok' | 'failures'> = {
    run: 'ae2-find-x',
    threadId: 't',
    paneType: 'Amendment',
    amendmentKind: 'amend',
    requestFrom: 'pane',
    queue: 'on',
    findCalls: 1,
    hmsReads: 1,
    jobStatus: 'done',
    jobOutcome: 'found',
    failureClass: null,
    attempts: 1,
    found: true,
    lookupArrival: '2026-11-01',
    lookupDates: 'booked',
    emailBooked: { arrival: '2026-11-01', departure: '2026-11-06' },
    emailRequested: { arrival: '2026-10-31', departure: '2026-11-07' },
    hmsArrival: '2026-11-01',
    hmsDeparture: '2026-11-06',
    shownArrival: '2026-11-01',
    shownDeparture: '2026-11-06',
    arrivalMismatch: false,
    screenshots: { amend: true, pane: true },
    activeMailboxSwitched: false,
    restored: false,
    blocked: ['workItems.open (write)'],
    blocker: null,
  };

  it('passes only when the find used the booked dates and found the booking', () => {
    expect(ae2Failures(passing)).toEqual([]);
    expect(ae2Failures({ ...passing, lookupDates: 'requested' })).toEqual([
      'the find used the requested arrival, not the booked one',
    ]);
    expect(ae2Failures({ ...passing, lookupDates: 'none' })).toEqual(['the find sent no arrival']);
    expect(ae2Failures({ ...passing, found: false, jobOutcome: 'not_found' })).toEqual([
      'the booking was not found in HMS (not_found)',
    ]);
    expect(ae2Failures({ ...passing, shownDeparture: null })).toEqual([
      '"Booking in HMS now" does not show the dates the job read',
    ]);
    expect(ae2Failures({ ...passing, screenshots: { amend: false, pane: true } })).toEqual([
      'the amendment card screenshot is missing',
    ]);
  });

  it('fails on a block the pane should not have caused', () => {
    expect(ae2Failures({ ...passing, blocked: ['paneStayCancel.previewCancel (write)'] })).toEqual([
      'the guard blocked: paneStayCancel.previewCancel (write)',
    ]);
  });

  it('accepts a stored job the card read back', () => {
    expect(ae2Failures({ ...passing, requestFrom: 'stored_job', queue: null, findCalls: 0, hmsReads: 0 })).toEqual([]);
  });
});

describe('the pane markup the driver reads', () => {
  it('matches the mail code', () => {
    const mailRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mail');
    const panel = readFileSync(join(mailRoot, 'components', 'quote-workflow', 'amend-lookup-panel.tsx'), 'utf8');
    const find = readFileSync(join(mailRoot, 'lib', 'quote-workflow', 'amend-find.ts'), 'utf8');
    expect(CARD).toContain('[data-testid="amend-lookup-panel"]');
    expect(panel).toContain('data-testid="amend-lookup-panel"');
    expect(panel).toContain(FIND_BUTTON);
    expect(panel).toContain('<HmsRow field="arrival" label="Arrival" value={shownDate(stay.arrival)}');
    expect(panel).toContain('<HmsRow field="departure" label="Departure" value={shownDate(stay.departure)}');
    // The value is the row's second paragraph: the label, then the value.
    expect(panel).toMatch(/<p className=\{headingClass\}>\{label\}<\/p>\s*<p data-pii=\{pii \|\| undefined\} className=\{valueClass\}>/);
    expect(find).toContain("const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];");
    expect(find).toContain('return `${Number(match[3])} ${month} ${match[1]}`;');
  });
});
