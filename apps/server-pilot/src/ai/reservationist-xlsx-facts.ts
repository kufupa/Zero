import { normalizedDate, type DocumentSource, type ValidatedDocumentFact } from './reservationist-document-facts.js';

type Cell = { columnNumber: number; displayText: string };
type Row = { rowNumber: number; cells: Cell[] };
type Role = 'room' | 'quantity' | 'adults' | 'children' | 'childAges' | 'totalGuests' | 'firstName' | 'lastName' | 'guest' | 'age' | 'arrival' | 'departure' | 'board' | 'party' | 'reference';

// Deliberately recognize explicit column labels only. Everything else remains
// visible for staff review; we do not guess a rooming-list layout.
const labels: Record<Role, readonly string[]> = {
  room: ['room', 'room no', 'room number', 'room ref', 'room reference'],
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
    const label = cell.displayText.trim().toLowerCase().replace(/[_\-#.:]+/g, ' ').replace(/\s+/g, ' ');
    const role = (Object.keys(labels) as Role[]).find(key => labels[key].includes(label));
    if (!role) continue;
    if (result.has(role)) return new Map(); // Ambiguous headers break the current table.
    result.set(role, cell.columnNumber);
  }
  return result.size >= 2 ? result : undefined;
}

/** Verify candidate facts against the same workbook sheet, header and cited data row. */
export function xlsxRowEntails(fact: ValidatedDocumentFact, source: DocumentSource | undefined): boolean {
  const page = source?.pages?.[fact.source.page - 1];
  const start = fact.source.start, end = fact.source.end;
  if (!page || start === undefined || end === undefined || fact.verification !== 'text_verified') return false;
  const lineStart = page.lastIndexOf('\n', start - 1) + 1;
  const next = page.indexOf('\n', start), lineEnd = next < 0 ? page.length : next;
  if (end > lineEnd) return false;
  const line = page.slice(lineStart, lineEnd), row = parseRow(line);
  if (!row || row.cells.some(cell => /\b(?:cancelled|canceled|withdrawn|removed|previous|historical|subtotal|grand total)\b/i.test(cell.displayText))) return false;

  const before = page.slice(0, lineStart).split('\n');
  let sheetAt = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    try { if (typeof JSON.parse(before[i]!).sheetNumber === 'number') { sheetAt = i; break; } } catch { /* blank separator */ }
  }
  if (sheetAt < 0) return false;
  const sheet = JSON.parse(before[sheetAt]!) as { mergeRanges?: unknown };
  if (!Array.isArray(sheet.mergeRanges) || sheet.mergeRanges.length) return false;

  let active: Map<Role, number> | undefined, previous: number | undefined;
  for (const priorLine of before.slice(sheetAt + 1)) {
    if (!priorLine) continue;
    const prior = parseRow(priorLine);
    if (!prior) return false;
    const candidate = header(prior);
    if (candidate) active = candidate.size ? candidate : undefined;
    else if (previous !== undefined && prior.rowNumber !== previous + 1 || prior.cells.filter(cell => cell.displayText.trim()).length < 2) active = undefined;
    previous = prior.rowNumber;
  }
  if (!active || previous === undefined || row.rowNumber !== previous + 1) return false;

  const cell = (role: Role): string | undefined => {
    const value = row.cells.find(item => item.columnNumber === active!.get(role));
    if (!value || !value.displayText.trim()) return;
    const encoded = JSON.stringify(value.displayText);
    const prefix = `"columnNumber":${value.columnNumber},"displayText":`;
    const position = line.indexOf(prefix + encoded);
    // The cited span must cover the actual value, not merely another cell
    // with the same number or name. JSON escaping remains part of the span.
    if (position < 0 || start > lineStart + position + prefix.length + 1 || end < lineStart + position + prefix.length + encoded.length - 1) return;
    return value.displayText.trim();
  };
  const rawCell = (role: Role) => row.cells.find(item => item.columnNumber === active!.get(role))?.displayText.trim();
  const same = (role: Role, value: string | number) => cell(role) === String(value);
  if (fact.kind === 'guest') {
    const name = same('firstName', fact.value.firstName) && same('lastName', fact.value.lastName) || same('guest', `${fact.value.firstName} ${fact.value.lastName}`);
    return name && (fact.value.roomRef === undefined || same('room', fact.value.roomRef)) &&
      (fact.value.roomIndex === undefined || same('room', fact.value.roomIndex)) &&
      (fact.value.age === undefined || same('age', fact.value.age)) && fact.value.profileId === undefined;
  }
  if (fact.kind === 'room') {
    if (fact.value.quotationBasis || !same('room', fact.value.roomRef) || !same('adults', fact.value.adults)) return false;
    if (fact.value.quantity !== undefined && (rawCell('quantity') ? !same('quantity', fact.value.quantity) :
      !(fact.value.quantity === 1 && /^\d+$/.test(fact.value.roomRef)))) return false;
    const count = cell('children');
    if (count !== String(fact.value.childAges.length)) return false;
    const totalGuests = rawCell('totalGuests');
    if (totalGuests && totalGuests !== String(fact.value.adults + fact.value.childAges.length)) return false;
    if (!fact.value.childAges.length) return !rawCell('childAges');
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
