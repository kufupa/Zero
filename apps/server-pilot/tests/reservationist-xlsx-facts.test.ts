import { describe, expect, it } from 'vitest';
import type { DocumentSource, ValidatedDocumentFact } from '../src/ai/reservationist-document-facts.js';
import { xlsxRowContext, xlsxRowEntails } from '../src/ai/reservationist-xlsx-facts.js';

function rowLine(rowNumber: number, values: readonly string[]) {
  return JSON.stringify({
    rowNumber,
    cells: values.map((displayText, index) => ({ columnNumber: index + 1, displayText })),
  });
}

function sheet(headers: readonly string[], rows: readonly (readonly string[])[]) {
  const dataRows = rows.map((values, index) => rowLine(index + 2, values));
  const page = [JSON.stringify({ sheetName: 'Rooms', sheetNumber: 1, mergeRanges: [] }), rowLine(1, headers), ...dataRows].join('\n');
  const source: DocumentSource = {
    attachmentId: 'sheet', sourceHash: 'a'.repeat(64), disclosure: 'guest', pages: [page], pageCount: 1,
  };
  return { page, source, dataRows };
}

function factAt(
  source: DocumentSource,
  page: string,
  line: string,
  kind: ValidatedDocumentFact['kind'],
  value: unknown,
): ValidatedDocumentFact {
  const start = page.indexOf(line);
  return {
    id: 'fact', kind, value, disclosure: 'guest', verification: 'text_verified', authority: 'customer_claim',
    source: { attachmentId: source.attachmentId, sourceHash: source.sourceHash, page: 1, quote: line, start, end: start + line.length },
  } as ValidatedDocumentFact;
}

describe('reservationist XLSX row facts', () => {
  it('treats roomIndex as a position bounded by a same-row printed quantity, not as roomRef', () => {
    const { page, source, dataRows } = sheet(
      ['Room reference', 'Quantity', 'First name', 'Last name'],
      [['A-12', '2', 'Ada', 'Lovelace']],
    );
    const at = (roomIndex: number) => factAt(source, page, dataRows[0]!, 'guest', {
      firstName: 'Ada', lastName: 'Lovelace', roomRef: 'A-12', roomIndex,
    });

    expect(xlsxRowEntails(at(2), source)).toBe(true);
    expect(xlsxRowEntails(at(3), source)).toBe(false);
  });

  it('rejects conflicting populated first, last, or full-name cells even when another name form matches', () => {
    const cases = [
      { row: ['A-12', 'Grace', 'Lovelace', 'Ada Lovelace'], label: 'first name' },
      { row: ['A-12', 'Ada', 'Hopper', 'Ada Lovelace'], label: 'last name' },
      { row: ['A-12', 'Ada', 'Lovelace', 'Grace Hopper'], label: 'full name' },
    ];

    for (const { row, label } of cases) {
      const { page, source, dataRows } = sheet(['Room', 'First name', 'Last name', 'Guest name'], [row]);
      const fact = factAt(source, page, dataRows[0]!, 'guest', {
        firstName: 'Ada', lastName: 'Lovelace', roomRef: 'A-12',
      });
      expect(xlsxRowEntails(fact, source), `${label} conflict`).toBe(false);
    }

    const { page, source, dataRows } = sheet(
      ['Room', 'First name', 'Last name', 'Guest name'],
      [['A-12', 'Ada', 'Lovelace', 'Ada Lovelace']],
    );
    expect(xlsxRowEntails(factAt(source, page, dataRows[0]!, 'guest', {
      firstName: 'Ada', lastName: 'Lovelace', roomRef: 'A-12',
    }), source)).toBe(true);
  });

  it('keeps a data surname named Guest inside the preceding table', () => {
    const { page, source, dataRows } = sheet(
      ['Room', 'First name', 'Last name', 'Adults'],
      [['101', 'Alex', 'Guest', '1'], ['102', 'Jamie', 'Other', '1']],
    );
    const fact = factAt(source, page, dataRows[1]!, 'guest', {
      firstName: 'Jamie', lastName: 'Other', roomRef: '102',
    });

    expect(xlsxRowEntails(fact, source)).toBe(true);
  });

  it('does not carry prior columns through an unrecognized multi-column heading', () => {
    const { page, source, dataRows } = sheet(
      ['Room', 'Adults', 'Children', 'First name', 'Last name'],
      [
        ['101', '2', '0', 'Alex', 'Guest'],
        ['Section title', 'Primary units', 'Secondary units', 'Coordinator', 'Remark'],
        ['GROUP A', '2', '0', 'Jamie', 'Other'],
      ],
    );
    const fact = factAt(source, page, dataRows[2]!, 'room', {
      roomRef: 'GROUP A', adults: 2, childAges: [],
    });

    expect(xlsxRowEntails(fact, source)).toBe(false);
  });

  it('returns raw same-row arrival, departure, and board cells, including masked text', () => {
    const { page, source, dataRows } = sheet(
      ['Room', 'Arrival', 'Departure', 'Board'],
      [['A-12', ' TBC ', '', '[card ••••1111]']],
    );
    const fact = factAt(source, page, dataRows[0]!, 'dates', {
      arrival: '2027-02-10', departure: '2027-02-11',
    });
    expect(xlsxRowContext(fact, source)).toEqual({
      arrival: ' TBC ', board: '[card ••••1111]',
    });

    const noStayColumns = sheet(['Room', 'First name', 'Last name'], [['A-12', 'Ada', 'Lovelace']]);
    const noStayFact = factAt(noStayColumns.source, noStayColumns.page, noStayColumns.dataRows[0]!, 'dates', {
      arrival: '2027-02-10', departure: '2027-02-11',
    });
    expect(xlsxRowContext(noStayFact, noStayColumns.source)).toEqual({});
  });
});
