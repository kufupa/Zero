import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ae1Failures,
  DOCUMENTS_SECTION,
  RATES_SECTION,
  READ_ROWS_JS,
  RUN_STEP,
  AE1_WRITE_PROCEDURES,
  blockerOfPlan,
  classifyAe1Request,
  classifyDryPlanRequest,
  documentStayCount,
  dryPlanLines,
  filledFieldsOf,
  fillKindsOf,
  newAe1GuardState,
  parseAe1Config,
  pickRoomOption,
  planRoomRows,
  roomRuleOf,
  stayKeyOfRatesInput,
  type Ae1DryPlan,
  type Ae1Summary,
  type PaneRoomRow,
  type SelectOption,
} from '../scripts/nava-ae1-rates-proof';
import { KNOWN_WRITE_PROCEDURES } from '../scripts/nava-preview-run';

const BASE = 'https://nava.example.test';
const here = dirname(fileURLToPath(import.meta.url));
const mailRoot = join(here, '..', '..', 'mail');
const mail = (...parts: string[]) => readFileSync(join(mailRoot, ...parts), 'utf8');
const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find(existsSync);
const url = (procedures: string) => `${BASE}/api/trpc/${procedures}?batch=1`;
const body = (...inputs: unknown[]) =>
  JSON.stringify(Object.fromEntries(inputs.map((input, index) => [String(index), { json: input }])));
const stay = (arrival: string, departure: string, extra: Record<string, unknown> = {}) => ({
  messageId: 'm1',
  groups: [
    { id: 'g1', arrivalDate: arrival, departureDate: departure },
    { id: 'g2', arrivalDate: arrival, departureDate: departure },
  ],
  ...extra,
});

/** The room select as requirement-card.tsx renders it: blank, the email's ask, then the HMS room types. */
const ROOM_OPTIONS = (asked?: string): SelectOption[] => [
  { value: '', label: 'Choose a room type' },
  ...(asked ? [{ value: asked, label: `Email asked for ${asked} — pick a room type` }] : []),
  { value: 'STWN', label: 'Standard Twin (STWN)' },
  { value: 'STQN', label: 'Standard Queen (STQN)' },
  { value: 'SKNG', label: 'Standard King (SKNG)' },
  { value: 'DLXTWN', label: 'Deluxe Twin (DLXTWN)' },
  { value: 'SUITE', label: 'Suite (SUITE)' },
];

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-ae1-'));
  statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('request guard', () => {
  it('lets reads, the analysis, the edit events and the documents through', () => {
    const state = newAe1GuardState();
    expect(classifyAe1Request(url('mail.get,workItems.getByMessage'), null, state).allowed).toBe(true);
    expect(classifyAe1Request(url('quoteWorkflow.analyseSelection'), null, state).allowed).toBe(true);
    expect(classifyAe1Request(url('workItems.open,workItems.recordEvent'), null, state).allowed).toBe(true);
    const combined = { workflowRunId: 'r1', additionalStays: [{ workflowRunId: 'r2' }] };
    expect(classifyAe1Request(url('workstation.qualifiedQuoteProposalPdf'), body(combined), state).allowed).toBe(true);
    expect(classifyAe1Request(url('workstation.quoteWorkbook'), body(combined), state).allowed).toBe(true);
    expect(state).toMatchObject({ pdfs: 1, workbooks: 1, pdfStays: 2, workbookStays: 2, ratedStayKeys: [] });
  });

  it('allows one rates run per stay, only once the stays are known', () => {
    const state = newAe1GuardState();
    const first = body(stay('2026-10-26', '2026-10-27'));
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), first, state).blocked).toEqual([
      { procedure: 'workstation.executeStaffQuote', reason: 'stays_unknown' },
    ]);
    state.expectedStays = 2;
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), first, state).allowed).toBe(true);
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), first, state).blocked[0]?.reason).toBe(
      'stay_already_rated',
    );
    const second = body(stay('2026-11-17', '2026-11-18'));
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), second, state).allowed).toBe(true);
    const third = body(stay('2026-12-01', '2026-12-02'));
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), third, state).blocked[0]?.reason).toBe(
      'extra_rates_run',
    );
    expect(state.ratedStayKeys).toEqual(['2026-10-26:2026-10-27', '2026-11-17:2026-11-18']);
  });

  it('refuses a rates run without one stay, and counts the party checks a run carries', () => {
    const state = { ...newAe1GuardState(), expectedStays: 2 };
    const spanning = { groups: [{ arrivalDate: '2026-10-26', departureDate: '2026-10-27' }, { arrivalDate: '2026-11-17', departureDate: '2026-11-18' }] };
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), body(spanning), state).blocked[0]?.reason).toBe(
      'rates_without_stay',
    );
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), null, state).blocked[0]?.reason).toBe(
      'rates_without_stay',
    );
    const withAgency = stay('2026-10-26', '2026-10-27', { parties: { agency: { kind: 'agency', nativeId: '7', name: 'Org' } } });
    expect(classifyAe1Request(url('workstation.executeStaffQuote'), body(withAgency), state).allowed).toBe(true);
    expect(state.partyChecks).toBe(1);
  });

  it('allows one party search and one of each document', () => {
    const state = newAe1GuardState();
    expect(classifyAe1Request(url('panePartyLookup.findParty'), null, state).allowed).toBe(true);
    expect(classifyAe1Request(url('panePartyLookup.findParty'), null, state).blocked[0]?.reason).toBe('second_party_lookup');
    expect(classifyAe1Request(url('workstation.quoteWorkbook'), null, state).allowed).toBe(true);
    expect(classifyAe1Request(url('workstation.quoteWorkbook'), null, state).blocked[0]?.reason).toBe('second_document');
    expect(state.partyLookups).toBe(1);
  });

  it('counts nothing from a batch it blocks', () => {
    const state = { ...newAe1GuardState(), expectedStays: 2 };
    const decision = classifyAe1Request(
      url('workstation.executeStaffQuote,drafts.saveReply'),
      body(stay('2026-10-26', '2026-10-27'), {}),
      state,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toEqual([{ procedure: 'drafts.saveReply', reason: 'write' }]);
    expect(state.ratedStayKeys).toEqual([]);
  });

  it('blocks every HMS and mailbox write and unknown calls', () => {
    const writes = [...KNOWN_WRITE_PROCEDURES].filter((name) => !AE1_WRITE_PROCEDURES.has(name));
    expect(writes).toEqual(
      expect.arrayContaining([
        'quoteWorkflow.commitStay',
        'hmsApproval.approve',
        'paneStayCancel.commitCancel',
        'workstation.prepareBookingDraft',
        'workstation.bridgeTicket',
        'drafts.saveReply',
        'paneStayLookup.queueFind',
      ]),
    );
    for (const name of writes) {
      const decision = classifyAe1Request(url(name), null, newAe1GuardState());
      expect(decision.allowed, name).toBe(false);
      expect(decision.blocked[0]?.reason).toBe('write');
    }
    expect(classifyAe1Request(url('secret.thing'), null, newAe1GuardState()).blocked[0]?.reason).toBe('unknown');
    expect(classifyAe1Request(`${BASE}/api/trpc/`, null, newAe1GuardState()).allowed).toBe(false);
  });

  it('reads the stay of a rates run and the stays of a document request', () => {
    expect(stayKeyOfRatesInput(stay('2026-10-26', '2026-10-27'))).toBe('2026-10-26:2026-10-27');
    expect(stayKeyOfRatesInput({ groups: [] })).toBeNull();
    expect(stayKeyOfRatesInput(undefined)).toBeNull();
    expect(documentStayCount({ workflowRunId: 'r' })).toBe(1);
    expect(documentStayCount({ additionalStays: [{}, {}] })).toBe(3);
    expect(documentStayCount(undefined)).toBeNull();
  });
});

describe('room types', () => {
  it('picks the first listed type the ask names, then its usual bed', () => {
    expect(pickRoomOption('Double/Twin', ROOM_OPTIONS('Double/Twin'))?.value).toBe('STWN');
    expect(pickRoomOption('double or twin room', ROOM_OPTIONS())?.value).toBe('STWN');
    expect(pickRoomOption('Single', ROOM_OPTIONS('Single'))?.value).toBe('STQN');
    expect(pickRoomOption('SGL', ROOM_OPTIONS())?.value).toBe('STQN');
    expect(pickRoomOption('King', ROOM_OPTIONS())?.value).toBe('SKNG');
    expect(pickRoomOption('Family room', ROOM_OPTIONS())).toBeNull();
    // The email's own option is never a pick, even though its label carries the asked words.
    expect(pickRoomOption('Twin', [{ value: 'Twin', label: 'Email asked for Twin — pick a room type' }])).toBeNull();
  });
});

describe('room rows', () => {
  const row = (extra: Partial<PaneRoomRow>): PaneRoomRow => ({
    stay: 1,
    room: 1,
    roomValue: '',
    roomOptions: ROOM_OPTIONS(),
    rooms: null,
    adults: null,
    board: 'unknown',
    ...extra,
  });
  // No default count: a run uses the read's counts, and NAVA_AE1_ROOMS only where the read has none.
  const inputs = { roomSplit: [] as number[], adultsSplit: [], board: 'bb' as const, allowEdits: true };

  it('fills the rows NAVA_AE1_ROOMS counts 15 + 15 for, and records what it used', () => {
    const rows = [1, 2].flatMap((stayNumber) => [
      row({ stay: stayNumber, room: 1, roomValue: 'Single', roomOptions: ROOM_OPTIONS('Single') }),
      row({ stay: stayNumber, room: 2, roomValue: 'Double/twin', roomOptions: ROOM_OPTIONS('Double/twin'), board: 'bb' }),
    ]);
    const { plans, split } = planRoomRows(rows, { ...inputs, roomSplit: [15, 15] });
    expect(split.rule).toBe('NAVA_AE1_ROOMS 15/15 where the read has no count');
    expect(split.rows.every((used) => used.roomsSource === 'NAVA_AE1_ROOMS')).toBe(true);
    expect(split.rows.map((used) => [used.stay, used.room, used.askedType, used.roomType, used.rooms, used.adults, used.board])).toEqual([
      [1, 1, 'Single', 'STQN', 15, 1, 'bb'],
      [1, 2, 'Double/twin', 'STWN', 15, 2, 'bb'],
      [2, 1, 'Single', 'STQN', 15, 1, 'bb'],
      [2, 2, 'Double/twin', 'STWN', 15, 2, 'bb'],
    ]);
    expect(split.rows[1]).toMatchObject({ roomTypeFilled: true, roomsFilled: true, boardFilled: false });
    expect(plans[0]).toEqual({ index: 0, roomType: 'STQN', rooms: 15, adults: 1, board: 'bb' });
    expect(plans[1]).toEqual({ index: 1, roomType: 'STWN', rooms: 15, adults: 2, board: null });
  });

  it('keeps what the pane already has', () => {
    const { plans, split } = planRoomRows([row({ roomValue: 'SKNG', rooms: 4, adults: 3, board: 'dinner_bb' })], inputs);
    expect(plans).toEqual([{ index: 0, roomType: null, rooms: null, adults: null, board: null }]);
    expect(split.rows[0]).toMatchObject({ askedType: null, roomType: 'SKNG', rooms: 4, adults: 3, board: 'dinner_bb' });
  });

  it('never overwrites a value the pane has, row by row and field by field', () => {
    const full = { roomValue: 'STWN', rooms: 7, adults: 1, board: 'room_only' };
    const rows = [
      row({ room: 1, ...full }),
      row({ room: 2, ...full, rooms: null }),
      row({ room: 3, ...full, adults: null }),
      row({ room: 4, ...full, board: 'unknown' }),
      row({ room: 5, ...full, roomValue: 'Single', roomOptions: ROOM_OPTIONS('Single') }),
    ];
    const { plans, split } = planRoomRows(rows, { ...inputs, roomSplit: [15, 15, 15, 15, 15], adultsSplit: [2, 2, 2, 2, 2] });
    // Each row fills only its one missing value; every present value comes back unchanged.
    expect(plans).toEqual([
      { index: 0, roomType: null, rooms: null, adults: null, board: null },
      { index: 1, roomType: null, rooms: 15, adults: null, board: null },
      { index: 2, roomType: null, rooms: null, adults: 2, board: null },
      { index: 3, roomType: null, rooms: null, adults: null, board: 'bb' },
      { index: 4, roomType: 'STQN', rooms: null, adults: null, board: null },
    ]);
    for (const used of split.rows) {
      if (!used.roomTypeFilled) expect(used.roomType).toBe('STWN');
      if (!used.roomsFilled) expect(used.rooms).toBe(7);
      if (!used.adultsFilled) expect(used.adults).toBe(1);
      if (!used.boardFilled) expect(used.board).toBe('room_only');
    }
    expect(filledFieldsOf(split)).toEqual([
      'stay1.room2.rooms',
      'stay1.room3.adults',
      'stay1.room4.board',
      'stay1.room5.roomType',
    ]);
  });

  it('uses the read counts as they are, and no default', () => {
    const rows = [
      row({ roomValue: 'STWN', rooms: 30, adults: 2, board: 'bb' }),
      row({ room: 2, roomValue: 'STQN', rooms: 30, adults: 1, board: 'bb' }),
    ];
    const { plans, split } = planRoomRows(rows, inputs);
    expect(split.rule).toBe("the read's counts only (NAVA_AE1_ROOMS unset)");
    expect(split.rows.map((used) => [used.rooms, used.roomsSource, used.roomsFilled])).toEqual([
      [30, 'read', false],
      [30, 'read', false],
    ]);
    expect(plans.map((plan) => plan.rooms)).toEqual([null, null]);
    expect(filledFieldsOf(split)).toEqual([]);
  });

  it('marks a row no count reaches as missing, and that row blocks the run with or without edits', () => {
    const { plans, split } = planRoomRows([row({ roomValue: 'STWN', adults: 2, board: 'bb' })], inputs);
    expect(split.rows[0]).toMatchObject({ rooms: null, roomsFilled: true, roomsSource: 'missing' });
    expect(plans[0]?.rooms).toBeNull();
    expect(filledFieldsOf(split)).toEqual(['stay1.room1.rooms']);
    expect(blockerOfPlan(split, { allowEdits: false })).toBe('needs_edits:rooms');
    expect(blockerOfPlan(split, { allowEdits: true })).toBe('needs_edits:rooms');
  });

  it('fills only the rows the read leaves without a count', () => {
    const rows = [
      row({ room: 1, roomValue: 'STWN', rooms: 30, adults: 2, board: 'bb' }),
      row({ room: 2, roomValue: 'STQN', adults: 1, board: 'bb' }),
    ];
    const { split } = planRoomRows(rows, { ...inputs, roomSplit: [15, 15] });
    expect(split.rows.map((used) => [used.rooms, used.roomsSource])).toEqual([
      [30, 'read'],
      [15, 'NAVA_AE1_ROOMS'],
    ]);
    expect(filledFieldsOf(split)).toEqual(['stay1.room2.rooms']);
  });

  it('leaves a count missing when NAVA_AE1_ROOMS covers only some rows', () => {
    const rows = [
      row({ room: 1, roomValue: 'STWN', adults: 2, board: 'bb' }),
      row({ room: 3, roomValue: 'STQN', adults: 1, board: 'bb' }),
    ];
    const { split } = planRoomRows(rows, { ...inputs, roomSplit: [15, 15] });
    expect(split.rows.map((used) => [used.rooms, used.roomsSource])).toEqual([
      [15, 'NAVA_AE1_ROOMS'],
      [null, 'missing'],
    ]);
    expect(blockerOfPlan(split, { allowEdits: true })).toBe('needs_edits:rooms');
  });

  it('lists no fills for a complete pane', () => {
    const { split } = planRoomRows([row({ roomValue: 'SKNG', rooms: 4, adults: 3, board: 'dinner_bb' })], inputs);
    expect(filledFieldsOf(split)).toEqual([]);
  });

  it('takes adults from NAVA_AE1_ADULTS when given', () => {
    const { split } = planRoomRows([row({ roomValue: 'STQN' })], { ...inputs, adultsSplit: [2] });
    expect(split.rows[0]?.adults).toBe(2);
  });

  it('stops on a row it cannot fill', () => {
    expect(() => planRoomRows([row({})], inputs)).toThrow('stay 1 room 1 has no room type and the email names none');
    expect(() => planRoomRows([row({ roomValue: 'Family', roomOptions: ROOM_OPTIONS('Family') })], inputs)).toThrow(
      'no listed HMS room type matches "Family"',
    );
  });
});

describe('the blocker a run stops with', () => {
  const inputs = { roomSplit: [] as number[], adultsSplit: [], board: 'bb' as const, allowEdits: false };
  const pane = (extra: Partial<PaneRoomRow>): PaneRoomRow => ({
    stay: 1,
    room: 1,
    roomValue: 'STWN',
    roomOptions: ROOM_OPTIONS(),
    rooms: 30,
    adults: 2,
    board: 'bb',
    ...extra,
  });

  it('lists the kinds of value a run would type, rooms first', () => {
    const { split } = planRoomRows(
      [pane({ roomValue: 'Single', roomOptions: ROOM_OPTIONS('Single'), rooms: null, adults: null, board: 'unknown' })],
      { ...inputs, roomSplit: [15] },
    );
    expect(fillKindsOf(split)).toEqual(['rooms', 'roomType', 'adults', 'board']);
  });

  it('is null for a complete pane', () => {
    const { split } = planRoomRows([pane({})], inputs);
    expect(blockerOfPlan(split, inputs)).toBeNull();
  });

  it('names the fills without edits, and runs them with edits allowed', () => {
    const { split } = planRoomRows(
      [pane({ roomValue: 'Single', roomOptions: ROOM_OPTIONS('Single'), board: 'unknown' })],
      inputs,
    );
    expect(blockerOfPlan(split, { allowEdits: false })).toBe('needs_edits:roomType,board');
    expect(blockerOfPlan(split, { allowEdits: true })).toBeNull();
  });

  it('states where the counts came from', () => {
    expect(roomRuleOf({ roomSplit: [] })).toBe("the read's counts only (NAVA_AE1_ROOMS unset)");
    expect(roomRuleOf({ roomSplit: [15, 15] })).toBe('NAVA_AE1_ROOMS 15/15 where the read has no count');
  });
});

describe('dry plan', () => {
  it('lets reads and the analysis through, and refuses every write and HMS request', () => {
    expect(classifyDryPlanRequest(url('mail.get,workItems.getByMessage')).allowed).toBe(true);
    expect(classifyDryPlanRequest(url('quoteWorkflow.analyseSelection')).allowed).toBe(true);
    expect(classifyDryPlanRequest(url('drafts.saveReply')).blocked).toEqual([{ procedure: 'drafts.saveReply', reason: 'write' }]);
    expect(classifyDryPlanRequest(url('secret.thing')).blocked).toEqual([{ procedure: 'secret.thing', reason: 'unknown' }]);
    expect(classifyDryPlanRequest(url('panePartyLookup.findParty')).blocked).toEqual([
      { procedure: 'panePartyLookup.findParty', reason: 'hms' },
    ]);
    expect(classifyDryPlanRequest(url('workstation.executeStaffQuote')).blocked).toEqual([
      { procedure: 'workstation.executeStaffQuote', reason: 'hms' },
    ]);
  });

  it('prints each room count with its source and what a run would fill', () => {
    const plan: Ae1DryPlan = {
      dryPlan: true,
      threadId: 't',
      storedWorkflow: 'quote',
      paneRows: 2,
      roomSplit: {
        rule: "the read's counts only (NAVA_AE1_ROOMS unset)",
        rows: [
          {
            stay: 1,
            room: 1,
            askedType: 'Single',
            roomType: 'STQN',
            roomTypeFilled: true,
            rooms: 30,
            roomsFilled: false,
            roomsSource: 'read',
            adults: 1,
            adultsFilled: true,
            board: 'bb',
            boardFilled: false,
          },
          {
            stay: 1,
            room: 2,
            askedType: null,
            roomType: 'STWN',
            roomTypeFilled: false,
            rooms: null,
            roomsFilled: true,
            roomsSource: 'missing',
            adults: 2,
            adultsFilled: false,
            board: 'bb',
            boardFilled: false,
          },
        ],
      },
      wouldFill: ['stay1.room1.roomType', 'stay1.room1.adults', 'stay1.room2.rooms'],
      editsAllowed: false,
      blocker: 'needs_edits:rooms',
      blocked: ['panePartyLookup.findParty (hms)'],
      activeMailboxSwitched: false,
      restored: false,
    };
    expect(dryPlanLines(plan)).toEqual([
      "dry plan: 2 room rows; rooms are the read's counts only (NAVA_AE1_ROOMS unset)",
      'stay 1 room 1: rooms 30 from read; room type STQN (fill); adults 1 (fill); meal plan bb',
      'stay 1 room 2: rooms none from missing; room type STWN; adults 2; meal plan bb',
      'would fill: stay1.room1.roomType stay1.room1.adults stay1.room2.rooms',
      'blocker: needs_edits:rooms',
      'refused by the dry-plan guard: panePartyLookup.findParty (hms)',
    ]);
    expect(dryPlanLines({ ...plan, roomSplit: null, paneRows: 0, wouldFill: [], blocker: null, blocked: [] })).toEqual([
      'dry plan: 0 room rows; rooms are not planned',
      'would fill: nothing',
      'blocker: none',
    ]);
  });
});

describe('config', () => {
  const env = (extra: Record<string, string> = {}) => ({
    NAVA_PREVIEW_BASE_URL: BASE,
    NAVA_PREVIEW_STORAGE_STATE: statePath,
    ...extra,
  });

  it('has no default room count, and defaults the meal plan to bed and breakfast', () => {
    const config = parseAe1Config(['--threads', 't-1', '--out', dir], env(), dir);
    expect(config.threadId).toBe('t-1');
    expect(config.inputs).toEqual({ roomSplit: [], adultsSplit: [], board: 'bb', allowEdits: false });
    expect(config.dryPlan).toBe(false);
  });

  it('reads --dry-plan', () => {
    expect(parseAe1Config(['--threads', 'a', '--dry-plan'], env(), dir).dryPlan).toBe(true);
  });

  it('allows edits only with NAVA_PROOF_ALLOW_EDITS=1', () => {
    expect(parseAe1Config(['--threads', 'a'], env({ NAVA_PROOF_ALLOW_EDITS: '1' }), dir).inputs.allowEdits).toBe(true);
    expect(parseAe1Config(['--threads', 'a'], env({ NAVA_PROOF_ALLOW_EDITS: 'yes' }), dir).inputs.allowEdits).toBe(false);
  });

  it('reads the split and refuses bad inputs', () => {
    expect(parseAe1Config(['--threads', 'a'], env({ NAVA_AE1_ROOMS: '20/10', NAVA_AE1_ADULTS: '1/2' }), dir).inputs).toMatchObject({
      roomSplit: [20, 10],
      adultsSplit: [1, 2],
    });
    expect(() => parseAe1Config(['--threads', 'a,b'], env(), dir)).toThrow('exactly one thread');
    expect(() => parseAe1Config(['--threads', 'a'], env({ NAVA_AE1_ROOMS: 'half' }), dir)).toThrow('NAVA_AE1_ROOMS');
    expect(() => parseAe1Config(['--threads', 'a'], env({ NAVA_AE1_ROOMS: '0/30' }), dir)).toThrow('1 to 99');
    expect(() => parseAe1Config(['--threads', 'a'], env({ NAVA_AE1_ADULTS: '12' }), dir)).toThrow('1 to 9');
    expect(() => parseAe1Config(['--threads', 'a'], env({ NAVA_AE1_BOARD: 'all' }), dir)).toThrow('NAVA_AE1_BOARD');
  });
});

describe('verdict', () => {
  const passing: Omit<Ae1Summary, 'ok' | 'failures'> = {
    run: 'ae1-rates-x',
    threadId: 't',
    storedWorkflow: 'quote',
    stays: 2,
    paneRows: 4,
    staysRated: 2,
    ratesRuns: 2,
    hmsReads: 3,
    partyLookups: 1,
    partyChecks: 0,
    pdf: true,
    pdfStays: 2,
    xlsx: true,
    xlsxStays: 2,
    xlsxRows: 4,
    expectedXlsxRows: 4,
    xlsxExtraRows: 0,
    xlsxTotalRow: true,
    roomSplitUsed: { rule: '15/15 rooms per stay where the pane has none', rows: [] },
    editsAllowed: true,
    filledFields: [],
    activeMailboxSwitched: true,
    restored: true,
    screenshots: { rates: true, documents: true, pane: true },
    workflowRunIds: ['r1', 'r2'],
    blocked: ['panePartyLookup.findParty (second_party_lookup)'],
    blocker: null,
  };

  it('passes only when every AE1 point holds', () => {
    expect(ae1Failures(passing)).toEqual([]);
    expect(ae1Failures({ ...passing, ratesRuns: 1, staysRated: 1 })).toEqual([
      'expected one rates run per stay (2), saw 1',
      '1 of 2 stays rated',
    ]);
    expect(ae1Failures({ ...passing, xlsxRows: 2 })).toEqual(['the Excel has 2 stay x room rows, expected 4']);
    expect(ae1Failures({ ...passing, xlsxTotalRow: false })).toEqual(['the Excel has no single total row that adds up']);
    expect(ae1Failures({ ...passing, pdfStays: 1 })).toEqual(['the PDF covers 1 of 2 stays']);
    expect(ae1Failures({ ...passing, pdf: false, xlsx: false })).toEqual(['no PDF', 'no Excel']);
    expect(ae1Failures({ ...passing, stays: 1, ratesRuns: 1, staysRated: 1, pdfStays: 1, xlsxStays: 1 })).toEqual([
      'AE1 needs at least two stays; the pane shows 1',
    ]);
    expect(ae1Failures({ ...passing, screenshots: { rates: false, documents: true, pane: true } })).toEqual([
      'a screenshot is missing',
    ]);
    expect(ae1Failures({ ...passing, restored: false })).toEqual(['the default mailbox was not restored after the run']);
    expect(ae1Failures({ ...passing, activeMailboxSwitched: false, restored: false })).toEqual([]);
  });

  it('fails on any block the pane should not have caused', () => {
    expect(ae1Failures({ ...passing, blocked: ['workstation.executeStaffQuote (stay_already_rated)'] })).toEqual([
      'the guard blocked: workstation.executeStaffQuote (stay_already_rated)',
    ]);
  });

  it('reports a blocker', () => {
    expect(ae1Failures({ ...passing, blocker: 'Get rates from HMS is disabled: x' })[0]).toBe(
      'blocker: Get rates from HMS is disabled: x',
    );
  });
});

describe('the pane markup the driver reads', () => {
  it('matches the mail code', () => {
    const panel = mail('components', 'quote-workflow', 'quote-workflow-panel.tsx');
    const card = mail('components', 'quote-workflow', 'requirement-card.tsx');
    const steps = mail('components', 'quote-workflow', 'tool-step-list.tsx');
    const session = mail('lib', 'quote-workflow', 'session.ts');
    const documents = mail('components', 'quote-workflow', 'document-review.tsx');
    const ui = mail('components', 'nava-pane', 'pane-ui.tsx');
    expect(ui).toContain('<section id={id} aria-label={title}');
    expect(ui).toContain('<div role="group" aria-label={label}');
    expect(panel).toContain('<Section step={1} title="Stay details">');
    expect(RATES_SECTION).toContain('aria-label="Rates from HMS"');
    expect(panel).toContain('<Section step={2} title="Rates from HMS">');
    expect(DOCUMENTS_SECTION).toContain('aria-label="Quote documents"');
    expect(panel).toContain('<Section step={3} title="Quote documents">');
    expect(panel).toContain('Get rates from HMS');
    expect(panel).toContain('{`${rated} of ${total} stays rated`}');
    expect(card).toContain('const where = `stay ${stayNumber}, room ${roomNumber}`;');
    expect(card).toContain('label={`Rooms for ${where}`}');
    expect(card).toContain('Email asked for {unknownValue} — pick a room type');
    for (const label of ['Room type', 'Rooms', 'Adults', 'Meal plan']) expect(card).toContain(`aria-label="${label}"`);
    expect(steps).toContain('Run {step.title}');
    expect(session).toContain("title: `Search availability ${key.replace(':', ' → ')}`");
    expect(RUN_STEP.test('Run Search availability 2026-10-26 → 2026-10-27')).toBe(true);
    expect(documents).toContain("{isMultiStay(session) ? 'Prepare quote' : 'Prepare PDF'}");
    expect(documents).toContain('Download Excel');
  });

  it.skipIf(!chromiumBinary)(
    'reads each room row with its stay, its room type options and its counts',
    async () => {
      const browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
      try {
        const page = await browser.newPage();
        const roomRow = (stayNumber: number, roomNumber: number, asked: string, rooms: string) => `
          <div><select aria-label="Room type">
            <option value="">Choose a room type</option>
            <option value="${asked}" selected>Email asked for ${asked} — pick a room type</option>
            <option value="STWN">Standard Twin (STWN)</option><option value="STQN">Standard Queen (STQN)</option>
          </select>
          <div role="group" aria-label="Rooms for stay ${stayNumber}, room ${roomNumber}"></div>
          <input aria-hidden="true" type="number" aria-label="Rooms" class="sr-only" value="${rooms}">
          <input aria-hidden="true" type="number" aria-label="Adults" class="sr-only" value="">
          <select aria-label="Meal plan"><option value="unknown" selected>Not stated yet</option><option value="bb">B&amp;B</option></select></div>`;
        await page.setContent(`<div data-preview-pane><section aria-label="Stay details">
          ${roomRow(1, 1, 'Single', '')}${roomRow(1, 2, 'Double/twin', '')}${roomRow(2, 1, 'Single', '4')}
        </section><section aria-label="Rates from HMS"><input aria-label="Rooms" value="9"></section></div>`);
        const read = (await page.evaluate(`(${READ_ROWS_JS})()`)) as {
          counts: number[];
          rows: Array<{ stay: number; room: number; roomValue: string; roomOptions: SelectOption[]; rooms: string; board: string }>;
        };
        expect(read.counts).toEqual([3, 3, 3, 3, 3]);
        expect(read.rows.map((row) => [row.stay, row.room, row.roomValue, row.rooms, row.board])).toEqual([
          [1, 1, 'Single', '', 'unknown'],
          [1, 2, 'Double/twin', '', 'unknown'],
          [2, 1, 'Single', '4', 'unknown'],
        ]);
        expect(pickRoomOption('Double/twin', read.rows[1]!.roomOptions)?.value).toBe('STWN');
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
