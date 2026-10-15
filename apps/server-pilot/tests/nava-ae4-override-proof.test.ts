import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ae4Failures,
  AE4_WRITE_PROCEDURES,
  amountsInText,
  checkDocumentText,
  classifyAe4Request,
  noteFragments,
  parseAe4Config,
  parseTrpcBatch,
  planAe4Stay,
  randToMinor,
  ratesRunOf,
  readRoomRows,
  storedWorkView,
  textHasAmount,
  textHasNote,
  xlsxText,
  type Ae4StayRead,
  type Ae4Summary,
} from '../scripts/nava-ae4-override-proof';
import { needsEditsMessage } from '../scripts/nava-proof-kit';
import { KNOWN_WRITE_PROCEDURES } from '../scripts/nava-preview-run';

const NOTE = "Kamala OK'd – repeat group";
const BASE = 'https://nava.example.test';

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-ae4-'));
  statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('amounts in document text', () => {
  it('reads grouped, spaced and plain amounts as cents', () => {
    expect(textHasAmount('RATE R1,850.00', 185_000)).toBe(true);
    expect(textHasAmount('R 1 850.00 per night', 185_000)).toBe(true);
    expect(textHasAmount('R1 850,00', 185_000)).toBe(true);
    expect(textHasAmount('1850', 185_000)).toBe(true);
    expect(textHasAmount('1850.5', 185_050)).toBe(true);
  });

  it('does not read a longer number as the rate', () => {
    expect(textHasAmount('TOTAL R11,850.00', 185_000)).toBe(false);
    expect(textHasAmount('ref 218500', 185_000)).toBe(false);
    expect(amountsInText('R11,850.00')).toEqual([1_185_000]);
  });

  it('keeps table columns apart', () => {
    expect(amountsInText('2027-03-10   1   1   R1 850.00   R1 850.00')).toContain(185_000);
    expect(amountsInText('qty 2 R1 940.00')).toEqual([200, 194_000]);
  });

  it('reads the typed rate', () => {
    expect(randToMinor('1,850')).toBe(185_000);
    expect(randToMinor('R1 850.00')).toBe(185_000);
    expect(randToMinor('1850.5')).toBe(185_050);
    expect(randToMinor('abc')).toBeNull();
    expect(randToMinor('0')).toBeNull();
  });
});

describe('the internal note', () => {
  it('finds the note whatever its dash or apostrophe', () => {
    expect(textHasNote('Note: Kamala OK’d — repeat group', NOTE)).toBe(true);
    expect(textHasNote('approved: KAMALA', NOTE)).toBe(true);
    expect(textHasNote('a repeat group booking', NOTE)).toBe(true);
  });

  it('does not flag client text that only shares a short word', () => {
    expect(textHasNote('Standard Queen · 2 adults per room · Bed & Breakfast. Group bookings welcome.', NOTE)).toBe(false);
    expect(textHasNote('', NOTE)).toBe(false);
  });

  it('lists the distinctive fragments', () => {
    expect(noteFragments(NOTE)).toEqual(
      expect.arrayContaining(['kamala ok d repeat group', 'kamala', 'repeat', 'kamala ok', 'repeat group']),
    );
    expect(noteFragments(NOTE)).not.toContain('group');
  });
});

describe('document checks', () => {
  const expectations = { rateMinor: 185_000, note: NOTE, aiRatesMinor: [194_000, 194_000] };

  it('passes a client document with only her rate', () => {
    const text = 'QUOTATION\nStandard Queen · 2 adults per room   1   R1 850.00   R1 850.00\nTOTAL R1 850.00';
    expect(checkDocumentText(text, expectations)).toEqual({ hasRate: true, hasNote: false, hasAiRate: false });
  });

  it('catches the note and the HMS rate', () => {
    const text = `R1 850.00 (HMS R1 940.00)\nNote: ${NOTE}`;
    expect(checkDocumentText(text, expectations)).toEqual({ hasRate: true, hasNote: true, hasAiRate: true });
  });

  it('cannot tell the rates apart when HMS quoted her rate', () => {
    expect(checkDocumentText('R1 850.00', { ...expectations, aiRatesMinor: [185_000] }).hasAiRate).toBeNull();
  });
});

describe('xlsx text', () => {
  function workbook(sheet: string, shared: string): Uint8Array {
    return zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/sharedStrings.xml': strToU8(shared),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
      'xl/styles.xml': strToU8(`<styleSheet><t>${NOTE}</t></styleSheet>`),
    });
  }

  it('reads shared strings, inline strings and number cells, not shared-string indexes', () => {
    const shared =
      '<sst><si><t>Standard Queen &amp; breakfast</t></si><si><t xml:space="preserve">Rate &#8211; per night</t></si></sst>';
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="G1"><v>1850.00</v></c>' +
      '<c r="H1" t="inlineStr"><is><t>R1,850.00</t></is></c><c r="I1"/></row></sheetData></worksheet>';
    const text = xlsxText(workbook(sheet, shared));
    expect(text).toContain('Standard Queen & breakfast');
    expect(text).toContain('Rate – per night');
    expect(text.split('\n')).toContain('1850.00');
    expect(text.split('\n')).not.toContain('1');
    // Styles are not read, so text there is not counted.
    expect(textHasNote(text, NOTE)).toBe(false);
    expect(checkDocumentText(text, { rateMinor: 185_000, note: NOTE, aiRatesMinor: [194_000] })).toEqual({
      hasRate: true,
      hasNote: false,
      hasAiRate: false,
    });
  });

  it('finds a note written into the sheet', () => {
    const sheet = `<worksheet><sheetData><row><c t="inlineStr"><is><t>Note: ${NOTE}</t></is></c></row></sheetData></worksheet>`;
    expect(textHasNote(xlsxText(workbook(sheet, '<sst/>')), NOTE)).toBe(true);
  });
});

describe('request guard', () => {
  const url = (procedures: string) => `${BASE}/api/trpc/${procedures}?batch=1`;

  it('lets reads, the analysis and the AE4 writes through', () => {
    const state = { hmsReads: 0 };
    expect(classifyAe4Request(url('mail.get,workItems.getByMessage'), null, state).allowed).toBe(true);
    expect(classifyAe4Request(url('quoteWorkflow.analyseSelection'), null, state).allowed).toBe(true);
    expect(classifyAe4Request(url('workItems.open,workItems.recordEvent'), null, state).allowed).toBe(true);
    expect(classifyAe4Request(url('workstation.qualifiedQuoteProposalPdf'), null, state).allowed).toBe(true);
    expect(classifyAe4Request(url('workstation.quoteWorkbook'), null, state).allowed).toBe(true);
    expect(state.hmsReads).toBe(0);
  });

  it('allows one rates run and blocks the second', () => {
    const state = { hmsReads: 0 };
    const body = JSON.stringify({ '0': { json: { messageId: 'm1', groups: [] } } });
    expect(classifyAe4Request(url('workstation.executeStaffQuote'), body, state).allowed).toBe(true);
    expect(state.hmsReads).toBe(1);
    const second = classifyAe4Request(url('workstation.executeStaffQuote'), body, state);
    expect(second.allowed).toBe(false);
    expect(second.blocked).toEqual([{ procedure: 'workstation.executeStaffQuote', reason: 'second_hms_read' }]);
    expect(state.hmsReads).toBe(1);
  });

  it('blocks a rates run that carries a company or agency (an extra HMS lookup)', () => {
    const state = { hmsReads: 0 };
    const body = JSON.stringify({
      '0': { json: {} },
      '1': { json: { parties: { company: { nativeId: '49', name: 'Org' } } } },
    });
    const decision = classifyAe4Request(url('mail.get,workstation.executeStaffQuote'), body, state);
    expect(decision.blocked).toEqual([{ procedure: 'workstation.executeStaffQuote', reason: 'party_lookup' }]);
    expect(state.hmsReads).toBe(0);
  });

  it('does not count a rates run whose batch was blocked', () => {
    const state = { hmsReads: 0 };
    const decision = classifyAe4Request(url('workstation.executeStaffQuote,panePartyLookup.findParty'), null, state);
    expect(decision.allowed).toBe(false);
    expect(state.hmsReads).toBe(0);
  });

  it('blocks every HMS and mailbox write and unknown calls', () => {
    const writes = [...KNOWN_WRITE_PROCEDURES].filter((name) => !AE4_WRITE_PROCEDURES.has(name));
    expect(writes).toEqual(
      expect.arrayContaining([
        'quoteWorkflow.commitStay',
        'quoteWorkflow.previewStay',
        'hmsApproval.approve',
        'paneStayCancel.commitCancel',
        'panePartyLookup.findParty',
        'workstation.prepareBookingDraft',
        'workstation.bridgeTicket',
        'drafts.saveReply',
        'rates.create',
      ]),
    );
    for (const name of writes) {
      const decision = classifyAe4Request(url(name), null, { hmsReads: 0 });
      expect(decision.allowed, name).toBe(false);
      expect(decision.blocked[0]?.reason).toBe('write');
    }
    expect(classifyAe4Request(url('secret.thing'), null, { hmsReads: 0 }).blocked[0]?.reason).toBe('unknown');
    expect(classifyAe4Request(`${BASE}/api/trpc/`, null, { hmsReads: 0 }).allowed).toBe(false);
  });
});

describe('tRPC responses', () => {
  it('splits a superjson batch by procedure', () => {
    const body = JSON.stringify([
      { result: { data: { json: { status: 'ready', workItemId: 'wi-1', analysis: { luna: { workflow: 'quote' } } } } } },
      { error: { json: { message: 'Selected inbound email not found', data: { code: 'NOT_FOUND' } } } },
    ]);
    const [get, run] = parseTrpcBatch(`${BASE}/api/trpc/workItems.getByMessage,workstation.executeStaffQuote?batch=1`, body);
    expect(get?.procedure).toBe('workItems.getByMessage');
    expect(storedWorkView(get?.data)).toEqual({ status: 'ready', workItemId: 'wi-1', workflow: 'quote' });
    expect(run?.error).toEqual({ message: 'Selected inbound email not found', code: 'NOT_FOUND' });
    expect(parseTrpcBatch(`${BASE}/api/trpc/mail.get`, 'not json')).toEqual([]);
  });

  it('reads the rates run rows', () => {
    const run = ratesRunOf({
      workflowRunId: 'run-1',
      totalMinor: 185_000,
      rowRates: [
        {
          groupId: 'g1',
          source: 'override',
          hmsNightlyMinor: [194_000],
          nightlyMinor: [185_000],
          rateCode: 'NCOR1B',
          note: NOTE,
          hmsComment: `Rate override NCOR1B R1850.00 per night: ${NOTE}`,
        },
        { source: 'hms', hmsNightlyMinor: 'bad', nightlyMinor: [] },
      ],
    });
    expect(run.workflowRunId).toBe('run-1');
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ source: 'override', hmsNightlyMinor: [194_000], rateCode: 'NCOR1B' });
    expect(storedWorkView({ status: 'none' })).toEqual({ status: 'none', workItemId: null, workflow: null });
  });
});

describe('config', () => {
  const env = (extra: Record<string, string> = {}) => ({
    NAVA_PREVIEW_BASE_URL: BASE,
    NAVA_PREVIEW_STORAGE_STATE: statePath,
    ...extra,
  });

  it('defaults to the AE4 inputs on one 2027 night', () => {
    const config = parseAe4Config(['--threads', 't-1', '--out', dir], env(), dir);
    expect(config.threadId).toBe('t-1');
    expect(config.inputs).toMatchObject({
      arrival: '2027-03-10',
      departure: '2027-03-11',
      room: 'STQN',
      board: 'bb',
      rateCode: 'NCOR1B',
      rate: '1,850',
      rateMinor: 185_000,
      note: NOTE,
      allowNoEvent: false,
      allowEdits: false,
    });
    expect(parseAe4Config(['--threads', 't-1'], env({ NAVA_PROOF_ALLOW_EDITS: '1' }), dir).inputs.allowEdits).toBe(true);
  });

  it('refuses more than one thread, a stay before 2027 and bad inputs', () => {
    expect(() => parseAe4Config(['--threads', 'a,b'], env(), dir)).toThrow('exactly one thread');
    expect(() => parseAe4Config(['--latest', '1'], env(), dir)).toThrow('exactly one thread');
    expect(() => parseAe4Config(['--threads', 'a'], env({ NAVA_AE4_ARRIVAL: '2026-12-01' }), dir)).toThrow('2027');
    expect(() =>
      parseAe4Config(['--threads', 'a'], env({ NAVA_AE4_DEPARTURE: '2027-03-10' }), dir),
    ).toThrow('departure after arrival');
    expect(() => parseAe4Config(['--threads', 'a'], env({ NAVA_AE4_RATE: 'lots' }), dir)).toThrow('rand amount');
    expect(() => parseAe4Config(['--threads', 'a'], env({ NAVA_AE4_BOARD: 'all' }), dir)).toThrow('NAVA_AE4_BOARD');
    expect(parseAe4Config(['--threads', 'a'], env({ NAVA_AE4_ALLOW_NO_EVENT: '1' }), dir).inputs.allowNoEvent).toBe(true);
  });
});

describe('verdict', () => {
  const passing: Omit<Ae4Summary, 'ok' | 'failures'> = {
    run: 'ae4-x',
    threadId: 't',
    pdfHas1850: true,
    pdfHasNote: false,
    pdfHasAiRate: false,
    xlsxHas1850: true,
    xlsxHasNote: false,
    xlsxHasAiRate: false,
    reviewShowsOverride: true,
    copyForHmsLine: `Rate override NCOR1B R1850.00 per night: ${NOTE}`,
    copyButtonShown: true,
    screenshots: { review: true, pane: true },
    aiRateMinor: [194_000],
    overrideRateMinor: 185_000,
    storedWorkflow: 'quote',
    workItemId: 'wi',
    workflowRunId: 'run',
    workEventId: null,
    hmsReads: 1,
    editsAllowed: false,
    filledFields: [],
    activeMailboxSwitched: true,
    restored: true,
    blocked: [],
    blocker: null,
  };

  it('passes only when every AE4 point holds', () => {
    expect(ae4Failures(passing)).toEqual([]);
    expect(ae4Failures({ ...passing, pdfHasNote: true })).toEqual(['PDF shows the internal note']);
    expect(ae4Failures({ ...passing, xlsxHasAiRate: true })).toEqual(['Excel shows the HMS rate']);
    expect(ae4Failures({ ...passing, copyButtonShown: false })).toEqual(['no Copy for HMS comments line']);
    expect(ae4Failures({ ...passing, hmsReads: 0 })).toContain('expected one HMS read, saw 0');
    expect(ae4Failures({ ...passing, screenshots: { review: false, pane: true } })).toEqual([
      'a review screenshot is missing',
    ]);
  });

  it('fails when the switched default mailbox was not restored', () => {
    expect(ae4Failures({ ...passing, restored: false })).toEqual(['the default mailbox was not restored after the run']);
    expect(ae4Failures({ ...passing, activeMailboxSwitched: false, restored: false })).toEqual([]);
  });

  it('needs a quote work item unless the run allows no event', () => {
    const other = { ...passing, storedWorkflow: 'other' };
    expect(ae4Failures(other)).toEqual(['no rate.override work_event can be written for this mail']);
    expect(ae4Failures(other, true)).toEqual([]);
    // A quote read whose work item was never made cannot hold the event either.
    expect(ae4Failures({ ...passing, workItemId: null })).toEqual([
      'no rate.override work_event can be written for this mail',
    ]);
  });

  it('reports a blocker', () => {
    expect(ae4Failures({ ...passing, blocker: 'timed out: the PDF', pdfHas1850: null })).toEqual([
      'blocker: timed out: the PDF',
      'PDF does not show the override rate',
    ]);
  });
});

describe('the stay', () => {
  const OPTIONS = [
    { value: '', label: 'Choose a room type' },
    { value: 'STQN', label: 'Standard Queen (STQN)' },
    { value: 'STWN', label: 'Standard Twin (STWN)' },
  ];
  const inputs = { arrival: '2027-03-10', departure: '2027-03-11', room: 'STQN', board: 'bb' as const };
  /** The live incident: a stored quote with 2026-11-02 to 06, one room, two adults, B&B. */
  const stored: Ae4StayRead = {
    rows: 1,
    arrival: '2026-11-02',
    departure: '2026-11-06',
    roomValue: 'STWN',
    roomOptions: OPTIONS,
    rooms: '1',
    adults: '2',
    board: 'bb',
  };

  it('uses a stored stay as it is and types nothing', () => {
    expect(planAe4Stay(stored, inputs)).toEqual([]);
    expect(planAe4Stay({ ...stored, adults: '1', rooms: '3', board: 'room_only' }, inputs)).toEqual([]);
  });

  it('fills only what the stored stay is missing', () => {
    expect(planAe4Stay({ ...stored, rooms: '' }, inputs)).toEqual([{ field: 'rooms', value: '1' }]);
    expect(planAe4Stay({ ...stored, adults: '0', board: 'unknown' }, inputs)).toEqual([
      { field: 'adults', value: '2' },
      { field: 'board', value: 'bb' },
    ]);
    const asked = {
      ...stored,
      roomValue: 'Single',
      roomOptions: [...OPTIONS, { value: 'Single', label: 'Email asked for Single — pick a room type' }],
    };
    expect(planAe4Stay(asked, inputs)).toEqual([{ field: 'roomType', value: 'STQN' }]);
    expect(planAe4Stay({ ...stored, roomValue: '' }, inputs)).toEqual([{ field: 'roomType', value: 'STQN' }]);
  });

  it('reads unset adults as null and names the adults edit', async () => {
    const roomType = { value: 'STWN', options: [{ value: 'STWN', textContent: 'Standard Twin (STWN)' }] };
    const rooms = { value: '1' };
    const mealPlan = { value: 'bb', querySelector: () => null };
    const row = {
      querySelectorAll: () => [{ textContent: 'Adults per room not set' }],
      querySelector: (selector: string) => (selector.startsWith('select') ? roomType : rooms),
    };
    const stay = { querySelector: () => mealPlan };
    const group = {
      closest: (selector: string) => (selector === '[role="row"]' ? row : stay),
      getAttribute: () => 'Rooms for stay 1, room 1',
    };
    const section = { querySelectorAll: () => [group] };
    const pane = { querySelector: () => section };
    const document = { querySelector: () => pane };
    const page = {
      evaluate: async (expression: string) => new Function('document', `return ${expression};`)(document),
    } as never;

    const [read] = await readRoomRows(page);
    expect(read?.adults).toBeNull();
    const fills = planAe4Stay(
      {
        ...stored,
        roomValue: read!.roomValue,
        roomOptions: read!.roomOptions,
        rooms: read!.rooms === null ? '' : String(read!.rooms),
        adults: read!.adults === null ? '' : String(read!.adults),
        board: read!.board,
      },
      inputs,
    );
    expect(fills).toEqual([{ field: 'adults', value: '2' }]);
    expect(needsEditsMessage(fills.map(({ field }) => field))).toBe('needs_edits:adults');
  });

  it('never fills a date the stay has, and never guesses the other one', () => {
    const fills = planAe4Stay({ ...stored, rooms: '' }, inputs);
    expect(fills.some((fill) => fill.field === 'arrival' || fill.field === 'departure')).toBe(false);
    expect(() => planAe4Stay({ ...stored, departure: '' }, inputs)).toThrow('only one of its dates');
    expect(() => planAe4Stay({ ...stored, arrival: '' }, inputs)).toThrow('only one of its dates');
  });

  it('types the default stay only when the pane has none', () => {
    expect(planAe4Stay({ ...stored, rows: 0, arrival: '', departure: '', roomValue: '', rooms: '', adults: '', board: '' }, inputs)).toEqual([
      { field: 'stay', value: '' },
      { field: 'arrival', value: '2027-03-10' },
      { field: 'departure', value: '2027-03-11' },
      { field: 'roomType', value: 'STQN' },
      { field: 'rooms', value: '1' },
      { field: 'adults', value: '2' },
      { field: 'board', value: 'bb' },
    ]);
    // A blank row with no dates is no stay either: its dates come from the inputs.
    expect(planAe4Stay({ ...stored, arrival: '', departure: '' }, inputs)).toEqual([
      { field: 'arrival', value: '2027-03-10' },
      { field: 'departure', value: '2027-03-11' },
    ]);
  });

  it('refuses a quote with more than one row', () => {
    expect(() => planAe4Stay({ ...stored, rows: 2 }, inputs)).toThrow('AE4 needs one stay with one room');
  });
});
