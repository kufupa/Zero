import { describe, expect, it } from 'vitest';
import { makeFormula, makeRichText, type CellValue } from '@office-kit/xlsx/cell';
import { workbookToBytes } from '@office-kit/xlsx/io';
import { addWorksheet, createWorkbook, setSheetState } from '@office-kit/xlsx/workbook';
import { hideRow, setCell } from '@office-kit/xlsx/worksheet';
import {
  extractReservationistXlsxText,
  isReservationistXlsxMimeType,
} from '../src/ai/reservationist-xlsx.js';
import { AMBIGUOUS_NUMBER_GROUPS } from '../src/ai/card-mask.js';
import { analyseQuoteSources } from '../src/ai/quote-workflow-analyse.js';

type WorkbookSheet = {
  name: string;
  cells: Array<{ row: number; column: number; value: CellValue }>;
};

async function makeWorkbook(sheets: WorkbookSheet[]): Promise<Uint8Array> {
  const workbook = createWorkbook();
  for (const definition of sheets) {
    const sheet = addWorksheet(workbook, definition.name);
    for (const cell of definition.cells) setCell(sheet, cell.row, cell.column, cell.value);
  }
  return workbookToBytes(workbook);
}

async function extract(body: Uint8Array) {
  return extractReservationistXlsxText({ body, signal: new AbortController().signal });
}

describe('reservationist XLSX intake', () => {
  it('preserves multiple sheets and sparse rows, marks visible empty sheets, and masks card-like cells', async () => {
    const body = await makeWorkbook([
      {
        name: 'Arrivals',
        cells: [
          { row: 1, column: 1, value: 'Room' },
          { row: 1, column: 4, value: 'Guest' },
          { row: 4, column: 4, value: '4111 1111 1111 1111' },
        ],
      },
      {
        name: 'Departures',
        cells: [
          { row: 1, column: 2, value: 'Confirmation' },
          { row: 3, column: 2, value: '25526053-1' },
        ],
      },
      { name: 'No assignments', cells: [] },
    ]);

    expect(isReservationistXlsxMimeType('Application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="rooms.xlsx"'))
      .toBe(true);
    const result = await extract(body);
    expect(result.reason).toBe('text');
    const lines = result.text!.split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ sheetName: 'Arrivals', sheetNumber: 1, sheetCount: 3 });
    expect(JSON.parse(lines[1]!)).toEqual({
      rowNumber: 1,
      cells: [
        { columnNumber: 1, displayText: 'Room' },
        { columnNumber: 4, displayText: 'Guest' },
      ],
    });
    expect(JSON.parse(lines[2]!)).toEqual({
      rowNumber: 4,
      cells: [{ columnNumber: 4, displayText: '[card ••••1111]' }],
    });
    expect(JSON.parse(lines[4]!)).toMatchObject({ sheetName: 'Departures', sheetNumber: 2, sheetCount: 3 });
    expect(JSON.parse(lines[6]!)).toEqual({
      rowNumber: 3,
      cells: [{ columnNumber: 2, displayText: '25526053-1' }],
    });
    expect(JSON.parse(lines[8]!)).toMatchObject({
      sheetName: 'No assignments', sheetNumber: 3, rowCount: 0, cellCount: 0, empty: true,
    });
    expect(result.text).not.toContain('4111 1111 1111 1111');
    const entirelyEmpty = await extract(await makeWorkbook([{ name: 'Entirely empty', cells: [] }]));
    expect(entirelyEmpty).toEqual({ reason: 'spreadsheet_empty', text: null });
  });

  it('uses the inbound ambiguity warning for room-like and cross-cell card groups, including rich-text values', async () => {
    const body = await makeWorkbook([{
      name: 'Room assignments',
      cells: [
        { row: 1, column: 1, value: 'Rooms 4111 1111 1111 1111' },
        { row: 2, column: 1, value: '4111' },
        { row: 2, column: 2, value: '1111' },
        { row: 2, column: 3, value: '1111' },
        { row: 2, column: 4, value: '1111' },
        { row: 3, column: 1, value: { kind: 'rich-text', runs: makeRichText([{ text: 'Card 4111 1111 1111 1111' }]) } },
        { row: 4, column: 1, value: 4_111_111_111_111_111 },
      ],
    }]);

    const result = await extract(body);
    expect(result.reason).toBe('text');
    const rows = result.text!.split('\n').slice(1).map((line) => JSON.parse(line));
    expect(rows[0]?.cells[0]).toMatchObject({
      displayText: `Rooms ${AMBIGUOUS_NUMBER_GROUPS}`,
    });
    expect(rows[1]?.cells).toHaveLength(4);
    expect(rows[1]?.cells.every((cell: { displayText: string }) =>
      cell.displayText === AMBIGUOUS_NUMBER_GROUPS)).toBe(true);
    expect(rows[2]?.cells[0]).toMatchObject({
      displayText: expect.stringContaining('[card ••••1111]'),
    });
    expect(rows[3]?.cells[0]).toMatchObject({
      displayText: '[card ••••1111]',
    });
    expect(result.text).not.toContain('4111 1111 1111 1111');
    expect(result.text).not.toContain('4111111111111111');
  });

  it('sends card-like groups split across adjacent rows to staff review', async () => {
    const body = await makeWorkbook([{
      name: 'Room assignments',
      cells: [
        { row: 1, column: 1, value: 'Room 4111' },
        { row: 1, column: 2, value: '1111' },
        { row: 2, column: 1, value: '1111' },
        { row: 2, column: 2, value: '1111' },
      ],
    }]);

    await expect(extract(body)).resolves.toEqual({ reason: 'spreadsheet_card_groups_cross_rows', text: null });
  });

  it('sends PAN candidates split across four rows to staff review, even when OCR-corrupted', async () => {
    const body = await makeWorkbook([{
      name: 'Four-row split',
      cells: [
        { row: 1, column: 1, value: '4111' },
        { row: 2, column: 1, value: '1111' },
        { row: 3, column: 1, value: '1111' },
        { row: 4, column: 1, value: '1112' },
      ],
    }]);

    await expect(extract(body)).resolves.toEqual({ reason: 'spreadsheet_card_groups_cross_rows', text: null });
  });

  it('keeps consecutive date rows readable instead of treating them as a PAN', async () => {
    const body = await makeWorkbook([{
      name: 'Dates',
      cells: [
        { row: 1, column: 1, value: '2026-11-10' },
        { row: 2, column: 1, value: '2026-11-12' },
      ],
    }]);

    const result = await extract(body);
    expect(result.reason).toBe('text');
    expect(result.text).toContain('2026-11-10');
    expect(result.text).toContain('2026-11-12');
    expect(result.text).not.toContain(AMBIGUOUS_NUMBER_GROUPS);
  });

  it('leaves a labeled security-code column for staff review', async () => {
    const body = await makeWorkbook([{
      name: 'Cards',
      cells: [
        { row: 1, column: 1, value: 'Cardholder' },
        { row: 1, column: 2, value: 'CVV' },
        { row: 1, column: 3, value: 'Card number' },
        { row: 2, column: 1, value: 'Example Guest' },
        { row: 2, column: 2, value: '123' },
        { row: 2, column: 3, value: '4111 1111 1111 1111' },
      ],
    }]);

    await expect(extract(body)).resolves.toEqual({ reason: 'spreadsheet_sensitive_card_code_column', text: null });
  });

  it('does not duplicate date cells into false arrival and departure mentions on fallback', async () => {
    const body = await makeWorkbook([{
      name: 'Dates',
      cells: [
        { row: 1, column: 1, value: 'Arrival 2026-11-10' },
        { row: 2, column: 1, value: 'Departure 2026-11-12' },
      ],
    }]);
    const result = await extract(body);
    const analysis = analyseQuoteSources({
      subject: 'Quote request',
      bodyText: 'Please quote the listed rooms.',
      attachments: [{ id: 'dates', filename: 'dates.xlsx', bytesPresent: true, text: result.text! }],
    });

    expect(analysis.groups[0]).toMatchObject({ arrivalDate: '2026-11-10', departureDate: '2026-11-12' });
  });

  it('returns a visible manual reason rather than partial text at row or cell limits', async () => {
    const lateRow = await makeWorkbook([{
      name: 'Too many rows',
      cells: [{ row: 1_001, column: 1, value: 'last row' }],
    }]);
    const tooManyCells = await makeWorkbook([{
      name: 'Too many cells',
      cells: Array.from({ length: 8_001 }, (_, index) => ({ row: 1, column: index + 1, value: 'x' })),
    }]);

    await expect(extract(lateRow)).resolves.toEqual({ reason: 'spreadsheet_row_limit', text: null });
    await expect(extract(tooManyCells)).resolves.toEqual({ reason: 'spreadsheet_cell_limit', text: null });
  });

  it('leaves formulas and malformed or truncated workbooks for staff review', async () => {
    const formulas = await makeWorkbook([{
      name: 'Formula',
      cells: [
        { row: 1, column: 1, value: 1 },
        { row: 2, column: 1, value: makeFormula('A1+1', { cachedValue: 2 }) },
      ],
    }]);
    const hiddenWorkbook = createWorkbook();
    const hiddenSheet = addWorksheet(hiddenWorkbook, 'Hidden rows');
    setCell(hiddenSheet, 1, 1, 'Room');
    setCell(hiddenSheet, 2, 1, 12);
    hideRow(hiddenSheet, 2);
    const hiddenRows = await workbookToBytes(hiddenWorkbook);

    await expect(extract(formulas)).resolves.toEqual({ reason: 'spreadsheet_formula_cells', text: null });
    await expect(extract(hiddenRows)).resolves.toEqual({ reason: 'spreadsheet_hidden_rows_or_columns', text: null });
    const hiddenSheetWorkbook = createWorkbook();
    addWorksheet(hiddenSheetWorkbook, 'Visible');
    const hiddenTab = addWorksheet(hiddenSheetWorkbook, 'Hidden tab');
    setCell(hiddenTab, 1, 1, 'Do not omit this sheet');
    setSheetState(hiddenSheetWorkbook, 'Hidden tab', 'hidden');
    await expect(extract(await workbookToBytes(hiddenSheetWorkbook))).resolves.toEqual({ reason: 'spreadsheet_hidden_sheet', text: null });
    await expect(extract(new Uint8Array([0x50, 0x4b, 0x03, 0x04])))
      .resolves.toEqual({ reason: 'spreadsheet_parse_failed', text: null });
  });
});
