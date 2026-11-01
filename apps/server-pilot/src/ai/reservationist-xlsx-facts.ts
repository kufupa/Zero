import { normalizedDate, type DocumentSource, type ValidatedDocumentFact } from './reservationist-document-facts.js';
import { AMBIGUOUS_NUMBER_GROUPS } from './card-mask.js';

type Cell = { columnNumber: number; displayText: string };
type Row = { rowNumber: number; cells: Cell[] };
type Role = 'room' | 'roomIndex' | 'quantity' | 'adults' | 'children' | 'childAges' | 'totalGuests' | 'firstName' | 'lastName' | 'guest' | 'age' | 'arrival' | 'departure' | 'board' | 'party' | 'reference';

// Deliberately recognize explicit column labels only. Everything else remains
// visible for staff review; we do not guess a rooming-list layout.
const labels: Record<Role, readonly string[]> = {
  room: ['room', 'room no', 'room number', 'room ref', 'room reference'],
  roomIndex: ['room index', 'physical room index'],
  quantity: ['quantity', 'room quantity', 'number of rooms', 'room count'],
  adults: ['adult', 'adults', 'adult count', 'number of adults', 'no of adults'],
  children: ['child count', 'children', 'children count', 'number of children', 'no of children'],
  childAges: ['child age', 'child ages', 'children ages', 'ages of children'],
  totalGuests: ['total guests', 'guest count', 'number of guests', 'occupants'],
  firstName: ['first name', 'given name', 'guest first name'],
  lastName: ['last name', 'surname', 'family name', 'guest surname'],
  guest: ['guest', 'guest name', 'full name'],
  age: ['age', 'guest age'],
  arrival: ['arrival', 'arrival date', 'check in', 'check in date'],
  departure: ['departure', 'departure date', 'check out', 'check out date'],
  board: ['board', 'meal plan', 'meal basis'],
  party: ['company', 'agency', 'organization', 'organisation'],
  reference: ['confirmation', 'confirmation number', 'reservation reference', 'reservation number'],
};
const columnHeadingTerms = /^(?:(?:accommodation|adult|adults|age|agency|arrival|basis|board|booking|category|check[ -]?(?:in|out)|child|children|comment|comments|company|confirmation|contact|count|date|departure|email|family|first|given|guest|group|index|internal|last|meal|name|no|notes|number|occupant|of|phone|plan|quantity|ref|reference|remarks|reservation|room|surname|telephone|total|type)(?:[\s_-]+|$))+$/i;

function parseRow(line: string): Row | undefined {
  try {
    const row = JSON.parse(line) as Row;
    if (!Number.isSafeInteger(row.rowNumber) || row.rowNumber < 1 || !Array.isArray(row.cells) ||
      row.cells.some(cell => !Number.isSafeInteger(cell.columnNumber) || cell.columnNumber < 1 || typeof cell.displayText !== 'string') ||
      new Set(row.cells.map(cell => cell.columnNumber)).size !== row.cells.length) return;
    return row;
  } catch { return; }
}

function header(row: Row): Map<Role, number> | undefined {
  const result = new Map<Role, number>();
  for (const cell of row.cells) {
    const label = cell.displayText.trim().toLowerCase().replace(/[_\-#.:]+/g, ' ').replace(/\s+/g, ' ').trim();
    const role = (Object.keys(labels) as Role[]).find(key => labels[key].includes(label));
    if (!role) continue;
    if (result.has(role)) return new Map(); // Ambiguous headers break the current table.
    result.set(role, cell.columnNumber);
  }
  // Single recognized labels also occur as data, such as a surname "Guest".
  return result.size >= 2 ? result : undefined;
}

function looksLikeUnrecognizedHeader(row: Row, columns: Map<Role, number> | undefined): boolean {
  const labelCells = row.cells.filter(cell => {
    const value = cell.displayText.trim().replace(/[_\-#.:]+/g, ' ').trim();
    return value.length > 0 && value.length <= 64 && !/\d/.test(value) && columnHeadingTerms.test(value);
  }).length;
  if (labelCells >= 2) return true;
  const numericRoles: Role[] = ['quantity', 'adults', 'children', 'totalGuests'];
  return numericRoles.filter(role => {
    const column = columns?.get(role);
    const value = column === undefined ? undefined : row.cells.find(cell => cell.columnNumber === column)?.displayText.trim();
    return value !== undefined && value !== '' && !/^\d+$/.test(value);
  }).length >= 2;
}

type CitedRow = { row: Row; columns: Map<Role, number>; line: string; lineStart: number; start: number; end: number };

function citedRow(fact: ValidatedDocumentFact, source: DocumentSource | undefined): CitedRow | undefined {
  const page = source?.pages?.[fact.source.page - 1];
  const start = fact.source.start, end = fact.source.end;
  if (!page || start === undefined || end === undefined || fact.verification !== 'text_verified') return;
  const lineStart = page.lastIndexOf('\n', start - 1) + 1;
  const next = page.indexOf('\n', start), lineEnd = next < 0 ? page.length : next;
  if (end > lineEnd) return;
  const line = page.slice(lineStart, lineEnd), row = parseRow(line);
  if (!row || row.cells.some(cell => /\b(?:cancelled|canceled|withdrawn|removed|previous|historical|subtotal|grand total)\b/i.test(cell.displayText))) return;

  const before = page.slice(0, lineStart).split('\n');
  let sheetAt = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    try { if (typeof JSON.parse(before[i]!).sheetNumber === 'number') { sheetAt = i; break; } } catch { /* blank separator */ }
  }
  if (sheetAt < 0) return;
  const sheet = JSON.parse(before[sheetAt]!) as { mergeRanges?: unknown };
  if (!Array.isArray(sheet.mergeRanges) || sheet.mergeRanges.length) return;

  let active: Map<Role, number> | undefined, previous: number | undefined;
  for (const priorLine of before.slice(sheetAt + 1)) {
    if (!priorLine) continue;
    const prior = parseRow(priorLine);
    if (!prior) return;
    const candidate = header(prior);
    if (candidate) active = candidate.size >= 2 ? candidate : undefined;
    else if (looksLikeUnrecognizedHeader(prior, active) ||
      (previous !== undefined && prior.rowNumber !== previous + 1) ||
      prior.cells.filter(cell => cell.displayText.trim()).length < 2) active = undefined;
    previous = prior.rowNumber;
  }
  if (!active || previous === undefined || row.rowNumber !== previous + 1) return;
  return { row, columns: active, line, lineStart, start, end };
}

function rawCell(row: Row, columns: Map<Role, number>, role: Role): string | undefined {
  const column = columns.get(role);
  if (column === undefined) return;
  const value = row.cells.find(item => item.columnNumber === column)?.displayText;
  return value?.trim() ? value : undefined;
}

export type XlsxRowContext = { arrival?: string; departure?: string; board?: string };

/** Return printed same-row stay context without normalizing or hiding unreadable cells. */
export function xlsxRowContext(fact: ValidatedDocumentFact, source: DocumentSource | undefined): XlsxRowContext | undefined {
  const located = citedRow(fact, source);
  if (!located) return;
  const context: XlsxRowContext = {};
  const arrival = rawCell(located.row, located.columns, 'arrival');
  const departure = rawCell(located.row, located.columns, 'departure');
  const board = rawCell(located.row, located.columns, 'board');
  if (arrival !== undefined) context.arrival = arrival;
  if (departure !== undefined) context.departure = departure;
  if (board !== undefined) context.board = board;
  return context;
}

/** Verify candidate facts against the same workbook sheet, header and cited data row. */
export function xlsxRowEntails(fact: ValidatedDocumentFact, source: DocumentSource | undefined): boolean {
  const located = citedRow(fact, source);
  if (!located) return false;
  const { row, columns: active, line, lineStart, start, end } = located;

  const cell = (role: Role): string | undefined => {
    const value = row.cells.find(item => item.columnNumber === active!.get(role));
    if (!value || !value.displayText.trim() || value.displayText.includes(AMBIGUOUS_NUMBER_GROUPS) || /\[(?:card ••••\d{4}|code masked)\]/u.test(value.displayText)) return;
    const encoded = JSON.stringify(value.displayText);
    const prefix = `"columnNumber":${value.columnNumber},"displayText":`;
    const position = line.indexOf(prefix + encoded);
    // The cited span must cover the actual value, not merely another cell
    // with the same number or name. JSON escaping remains part of the span.
    if (position < 0 || start > lineStart + position + prefix.length + 1 || end < lineStart + position + prefix.length + encoded.length - 1) return;
    return value.displayText.trim();
  };
  const raw = (role: Role) => rawCell(row, active, role);
  const text = (role: Role) => raw(role)?.trim();
  const same = (role: Role, value: string | number) => cell(role) === String(value);
  if (fact.kind === 'guest') {
    const firstName = text('firstName'), lastName = text('lastName'), fullName = text('guest');
    const expectedName = `${fact.value.firstName} ${fact.value.lastName}`;
    if ((firstName && firstName !== fact.value.firstName) || (lastName && lastName !== fact.value.lastName) || (fullName && fullName !== expectedName)) return false;
    const quantity = text('quantity');
    if (fact.value.roomIndex !== undefined && (!same('roomIndex', fact.value.roomIndex) || quantity !== undefined &&
      (!/^\d+$/.test(quantity) || fact.value.roomIndex > Number(quantity)))) return false;
    const name = same('firstName', fact.value.firstName) && same('lastName', fact.value.lastName) || same('guest', expectedName);
    return name && (fact.value.roomRef === undefined || same('room', fact.value.roomRef)) &&
      (fact.value.age === undefined || same('age', fact.value.age)) && fact.value.profileId === undefined;
  }
  if (fact.kind === 'room') {
    if (fact.value.quotationBasis || !same('room', fact.value.roomRef) || !same('adults', fact.value.adults)) return false;
    if (fact.value.quantity !== undefined && (text('quantity') ? !same('quantity', fact.value.quantity) :
      !(fact.value.quantity === 1 && /^\d+$/.test(fact.value.roomRef)))) return false;
    const count = cell('children');
    if (count !== String(fact.value.childAges.length)) return false;
    const totalGuests = text('totalGuests');
    if (totalGuests && totalGuests !== String(fact.value.adults + fact.value.childAges.length)) return false;
    if (!fact.value.childAges.length) return !text('childAges');
    const ages = cell('childAges');
    if (!ages || !/^\d{1,2}(?:\s*[,/&]\s*\d{1,2})*$/.test(ages)) return false;
    return JSON.stringify(ages.split(/[,/&]/).map(Number).sort((a, b) => a - b)) === JSON.stringify([...fact.value.childAges].sort((a, b) => a - b));
  }
  if (fact.kind === 'dates') {
    const arrival = cell('arrival'), departure = cell('departure');
    if (!arrival || !departure) return false;
    try { return normalizedDate(arrival) === fact.value.arrival && normalizedDate(departure) === fact.value.departure; } catch { return false; }
  }
  if (fact.kind === 'board') return typeof fact.value === 'string' ? same('board', fact.value) : same('board', fact.value.board) && same('room', fact.value.roomRef);
  if (fact.kind === 'party') return same('party', fact.value);
  if (fact.kind === 'reservation_reference') return same('reference', fact.value);
  return false;
}
