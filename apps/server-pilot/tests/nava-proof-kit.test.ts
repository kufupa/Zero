import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildQuoteWorkbook, type WorkbookLine } from '../src/quote-proposal/quote-workbook';
import { countWorkbookLines, rateSegments, stayKeyOfRatesInput, unexpectedBlocks, xlsxSheetRows } from '../scripts/nava-proof-kit';

const HEADER = {
  attention: 'Fixture Attention',
  company: 'New Frontiers Tours',
  clientEmail: 'fixture@example.test',
  clientTelephone: '0110000000',
  signerName: 'Nava',
  signerEmail: 'navaai@example.test',
};

const room = (dateLabel: string, description: string, qty: number, rateMinor: number): WorkbookLine => ({
  dateLabel,
  description,
  qty,
  nights: 1,
  rateMinor,
  totalMinor: qty * rateMinor,
});

/** AE1: two one-night stays, a Single and a Double/Twin row each. */
const AE1_LINES: WorkbookLine[] = [
  room('26-27 October 2026', 'Standard Queen · 1 adult per room · Bed & Breakfast', 15, 150_000),
  room('', 'Standard Twin · 2 adults per room · Bed & Breakfast', 15, 180_000),
  room('17-18 November 2026', 'Standard Queen · 1 adult per room · Bed & Breakfast', 15, 150_000),
  room('', 'Standard Twin · 2 adults per room · Bed & Breakfast', 15, 180_000),
];

describe('proposal Excel rows', () => {
  it('counts one line per stay x room and one total in a real proposal workbook', () => {
    const bytes = buildQuoteWorkbook({ authoredDate: '2026-10-10', breakfastIncluded: true, header: HEADER, lines: AE1_LINES });
    expect(countWorkbookLines(xlsxSheetRows(bytes))).toEqual({
      lines: 4,
      roomLines: 4,
      extraLines: 0,
      totalRows: 1,
      totalMatches: true,
    });
  });

  it('counts lines past the six template rows, and tells extras from rooms', () => {
    const lines = [
      ...AE1_LINES,
      ...AE1_LINES.slice(0, 2),
      { dateLabel: '', description: 'Dinner allowance', qty: 30, nights: 1, rateMinor: 25_000, totalMinor: 750_000 },
    ];
    const count = countWorkbookLines(
      xlsxSheetRows(buildQuoteWorkbook({ authoredDate: '2026-10-10', breakfastIncluded: true, header: HEADER, lines })),
    );
    expect(count).toEqual({ lines: 7, roomLines: 6, extraLines: 1, totalRows: 1, totalMatches: true });
  });

  it('reads shared strings and flags a total that does not add up', () => {
    const sheet =
      '<worksheet><sheetData>' +
      '<row r="24"><c r="B24"><v>2</v></c><c r="C24" t="s"><v>0</v></c><c r="H24"><f>+B24*F24*G24</f><v>100</v></c></row>' +
      '<row r="25"><c r="B25"/><c r="H25"><f>+B25*F25*G25</f><v>0</v></c></row>' +
      '<row r="31"><c r="H31"><f>SUM(H24:H30)</f><v>90</v></c></row>' +
      '<row r="33"><c r="H33"><f>+H31</f><v>90</v></c></row>' +
      '</sheetData></worksheet>';
    const bytes = zipSync({
      'xl/worksheets/sheet1.xml': strToU8(sheet),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Suite · 2 adults per room &amp; breakfast</t></si></sst>'),
    });
    const rows = xlsxSheetRows(bytes);
    expect(rows.get(24)?.get('C')).toEqual({ text: 'Suite · 2 adults per room & breakfast', value: null, formula: null });
    expect(countWorkbookLines(rows)).toEqual({ lines: 1, roomLines: 1, extraLines: 0, totalRows: 1, totalMatches: false });
  });

  it('refuses a file with no first sheet', () => {
    expect(() => xlsxSheetRows(zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }))).toThrow('no first sheet');
  });
});

describe('helpers', () => {
  it('derives one stay key only when every group shares the same arrival and departure', () => {
    expect(
      stayKeyOfRatesInput({
        groups: [
          { arrivalDate: '2026-10-26', departureDate: '2026-10-27' },
          { arrivalDate: '2026-10-26', departureDate: '2026-10-27' },
        ],
      }),
    ).toBe('2026-10-26:2026-10-27');
    expect(stayKeyOfRatesInput({ groups: [] })).toBeNull();
    expect(stayKeyOfRatesInput({ groups: [{ arrivalDate: '2026-10-26' }] })).toBeNull();
    expect(
      stayKeyOfRatesInput({
        groups: [
          { arrivalDate: '2026-10-26', departureDate: '2026-10-27' },
          { arrivalDate: '2026-11-17', departureDate: '2026-11-18' },
        ],
      }),
    ).toBeNull();
  });

  it('counts one Excel line per run of nights at one rate', () => {
    expect(rateSegments([150_000])).toBe(1);
    expect(rateSegments([150_000, 150_000, 160_000, 150_000])).toBe(3);
    expect(rateSegments([])).toBe(0);
  });

  it('lists only the blocks a mode does not expect', () => {
    expect(unexpectedBlocks(['a (write)', 'b (unknown)'], ['a (write)'])).toEqual(['b (unknown)']);
  });
});
