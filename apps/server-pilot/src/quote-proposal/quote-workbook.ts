import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { HOTEL_TELEPHONE } from './filename.js';
import {
  deriveAuthorizedExtraLines,
  deriveQuoteLines,
  type AuthorizedProposalFacts,
  type RowPrice,
} from './quote-lines.js';
import type { QuoteRevision } from './quote-revision.js';

const TEMPLATE_PATH = fileURLToPath(new URL('../../fixtures/centurion-quotation-template.xlsx', import.meta.url));
const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const CALC_CHAIN_PATH = 'xl/calcChain.xml';
/** Template line rows 24-29. Row 30 is a merged separator and row 31 holds the subtotal. */
const TEMPLATE_LINE_ROWS = 6;
const FIRST_LINE_ROW = 24;
/** Template row 30, the first row below the line block. Every row from here down moves when line rows are inserted. */
const SEPARATOR_ROW = 30;
/** One proposal Excel holds at most this many line rows. Larger quotes are refused, never split or collapsed. */
export const MAX_WORKBOOK_LINES = 63;
const DRAWING_PATH = 'xl/drawings/drawing1.xml';
/** Drawing anchors are 0-based, so xdr:row 29 is template row 30. */
const DRAWING_SHIFT_FROM = SEPARATOR_ROW - 1;
const PRINT_AREA_LAST_ROW = 69;
/** Staff note block: merged A42:H46, wrapped with the template's wrap-text style (73). */
const NOTE_ROWS = [42, 43, 44, 45, 46];
const NOTE_STYLE = ' s="73"';
const NOTE_CHARS_PER_LINE = 80;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export type WorkbookLine = {
  /** DATE column, e.g. "12-14 October 2026". */
  dateLabel: string;
  description: string;
  /** QTY column: rooms, or guests for a person service. */
  qty: number;
  /** NIGHTS column: nights, days or trips. */
  nights: number;
  rateMinor: number;
  totalMinor: number;
};

export type WorkbookHeader = {
  attention: string;
  company: string;
  clientEmail: string;
  clientTelephone: string;
  signerName: string;
  signerEmail: string;
};

export type QuoteWorkbookInput = {
  /** ISO date the quotation was authored. Written as a fixed date, never TODAY(). */
  authoredDate: string;
  breakfastIncluded: boolean;
  header: WorkbookHeader;
  lines: WorkbookLine[];
  /** Unpriced staff note, printed in the note block. */
  note?: string;
};

type WorkbookItem = {
  service: string;
  extra: boolean;
  description: string;
  qty: number;
  nights: number;
  rateMinor: number;
  totalMinor: number;
  arrival: string;
  departure: string;
};

/** One resolved stay: its revision, the authorised extras attached to it, and the row prices its approval recorded. */
export type WorkbookStay = { revision: QuoteRevision; facts?: AuthorizedProposalFacts; rowPrices?: RowPrice[] };

/** A quote the proposal Excel cannot hold. The message tells staff what to do instead. */
export class WorkbookRefusalError extends Error {}

/** A quote with more lines than the proposal Excel holds. The message says how to split it. */
export class WorkbookLineLimitError extends WorkbookRefusalError {}

function lineLimitMessage(count: number): string {
  return `Quote has ${count} lines; the proposal Excel holds at most ${MAX_WORKBOOK_LINES}. Split it into separate quotes.`;
}

/** Refuses a quote with more lines than the proposal holds, before any renderer or currency check: no PDF outgrows its Excel. */
export function assertProposalLineLimit(stays: WorkbookStay[]): void {
  const count = stays.reduce(
    (sum, stay) => sum + deriveQuoteLines(stay.revision, stay.rowPrices).length + (stay.facts ? deriveAuthorizedExtraLines(stay.revision, stay.facts).length : 0),
    0,
  );
  if (count > MAX_WORKBOOK_LINES) throw new WorkbookLineLimitError(lineLimitMessage(count));
}

function isoParts(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('workbook_date');
  return { year, month, day };
}

/** "12-14 October 2026", "30 October - 2 November 2026", or a single day. */
export function quoteDateLabel(start: string, end: string): string {
  const a = isoParts(start);
  const b = isoParts(end);
  const monthA = MONTHS[a.month - 1];
  const monthB = MONTHS[b.month - 1];
  if (start === end) return `${a.day} ${monthA} ${a.year}`;
  if (a.year === b.year && a.month === b.month) return `${a.day}-${b.day} ${monthA} ${a.year}`;
  if (a.year === b.year) return `${a.day} ${monthA} - ${b.day} ${monthB} ${a.year}`;
  return `${a.day} ${monthA} ${a.year} - ${b.day} ${monthB} ${b.year}`;
}

/** Excel serial number (1900 date system) for a fixed date cell. */
export function excelSerialDate(iso: string): number {
  const { year, month, day } = isoParts(iso);
  return (Date.UTC(year, month - 1, day) - EXCEL_EPOCH_UTC) / 86400000;
}

/** Money in rand with two decimals, from integer cents. Exact for every integer cents value. */
function randText(minor: number): string {
  return (minor / 100).toFixed(2);
}

function sumOf(items: WorkbookItem[], key: 'qty' | 'totalMinor'): number {
  return items.reduce((sum, item) => sum + item[key], 0);
}

/**
 * Workbook lines for one or more resolved stays, in stay order: each stay's room rows, then its authorised extras.
 * With more than one stay, a row that continues the same stay's dates leaves its DATE cell blank. A single stay
 * prints its date on every row, as it always has.
 */
export function workbookLinesForStays(stays: WorkbookStay[]): { lines: WorkbookLine[]; totalMinor: number } {
  if (stays.length < 1) throw new Error('workbook_stays');
  // The template formats every amount in rand, so a quote in any other currency would print the wrong symbol.
  if (stays.some((stay) => stay.revision.currency !== 'ZAR')) {
    throw new WorkbookRefusalError('The proposal Excel prices in rand only. Quote other currencies one stay at a time.');
  }
  const items: Array<WorkbookItem & { stay: number }> = [];
  stays.forEach((stay, index) => {
    const rooms = deriveQuoteLines(stay.revision, stay.rowPrices).map(
      (line): WorkbookItem => ({
        service: 'room',
        extra: false,
        description: line.description,
        qty: line.quantity,
        nights: line.nights,
        rateMinor: line.rateMinor,
        totalMinor: line.totalMinor,
        arrival: line.arrivalDate,
        departure: line.departureDate,
      }),
    );
    const extras = (stay.facts ? deriveAuthorizedExtraLines(stay.revision, stay.facts) : []).map(
      (line): WorkbookItem => ({
        service: line.service,
        extra: true,
        description: line.description,
        qty: line.quantity,
        nights: line.nights,
        rateMinor: line.rateMinor,
        totalMinor: line.totalMinor,
        arrival: line.dates[0] ?? stay.revision.authoredDate,
        departure: line.dates.at(-1) ?? stay.revision.authoredDate,
      }),
    );
    items.push(...[...rooms, ...extras].map((item) => ({ ...item, stay: index })));
  });
  const totalMinor = sumOf(items, 'totalMinor');
  if (!Number.isSafeInteger(totalMinor)) throw new Error('money_overflow');
  if (items.length > MAX_WORKBOOK_LINES) throw new WorkbookLineLimitError(lineLimitMessage(items.length));
  let previous: { stay: number; dateLabel: string } | undefined;
  const lines = items.map((item): WorkbookLine => {
    const dateLabel = quoteDateLabel(item.arrival, item.departure);
    const continues = stays.length > 1 && previous?.stay === item.stay && previous.dateLabel === dateLabel;
    previous = { stay: item.stay, dateLabel };
    return {
      dateLabel: continues ? '' : dateLabel,
      description: item.description,
      qty: item.qty,
      nights: item.nights,
      rateMinor: item.rateMinor,
      totalMinor: item.totalMinor,
    };
  });
  if (lines.reduce((sum, line) => sum + line.totalMinor, 0) !== totalMinor) {
    throw new Error('workbook_total_mismatch');
  }
  return { lines, totalMinor };
}

/** Workbook lines for a resolved revision and its authorised extras, with the exact total they add up to. */
export function workbookLinesFor(
  revision: QuoteRevision,
  facts?: AuthorizedProposalFacts,
): { lines: WorkbookLine[]; totalMinor: number } {
  return workbookLinesForStays([{ revision, facts }]);
}

function xmlText(value: string): string {
  // XML 1.0 forbids most control characters, so drop them rather than write a broken sheet.
  const safe = Array.from(value)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 || ch === '\t' || ch === '\n' || ch === '\r')
    .join('');
  return safe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function replaceCell(sheet: string, ref: string, build: (style: string) => string, styleOverride?: string): string {
  const pattern = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const match = sheet.match(pattern);
  if (!match) throw new Error(`template cell missing ${ref}`);
  const style = styleOverride ?? (match[1]!.match(/\ss="[^"]*"/)?.[0] ?? '');
  return sheet.replace(pattern, () => build(style));
}

function setText(sheet: string, ref: string, text: string, styleOverride?: string): string {
  const value = xmlText(text);
  return replaceCell(
    sheet,
    ref,
    (style) =>
      value
        ? `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`
        : `<c r="${ref}"${style}/>`,
    styleOverride,
  );
}

function setNumber(sheet: string, ref: string, value: number | string): string {
  return replaceCell(sheet, ref, (style) => `<c r="${ref}"${style}><v>${value}</v></c>`);
}

function setFormula(sheet: string, ref: string, formula: string, cached: string): string {
  return replaceCell(sheet, ref, (style) => `<c r="${ref}"${style}><f>${formula}</f><v>${cached}</v></c>`);
}

function clearCell(sheet: string, ref: string): string {
  return replaceCell(sheet, ref, (style) => `<c r="${ref}"${style}/>`);
}

function addMerge(sheet: string, ref: string): string {
  const match = sheet.match(/<mergeCells count="(\d+)">/);
  if (!match) throw new Error('template merge list missing');
  const count = Number(match[1]);
  return sheet
    .replace(match[0], `<mergeCells count="${count + 1}">`)
    .replace('</mergeCells>', `<mergeCell ref="${ref}"/></mergeCells>`);
}

function setRowHeight(sheet: string, row: number, height: number): string {
  const match = sheet.match(new RegExp(`<row r="${row}"([^>]*)>`));
  if (!match) throw new Error(`template row missing ${row}`);
  const attrs = match[1]!.replace(/\s(?:ht|customHeight)="[^"]*"/g, '');
  return sheet.replace(match[0], `<row r="${row}"${attrs} ht="${height}" customHeight="1">`);
}

function setNote(sheet: string, note: string, rows: number[]): string {
  const text = `Note: ${note}`;
  let next = setText(sheet, `A${rows[0]}`, text, NOTE_STYLE);
  next = addMerge(next, `A${rows[0]}:H${rows.at(-1)}`);
  const wrappedLines = text
    .split('\n')
    .reduce((count, part) => count + Math.max(1, Math.ceil(part.length / NOTE_CHARS_PER_LINE)), 0);
  const needed = wrappedLines * 15 + 4;
  const height = Math.max(17.4, Math.ceil(needed / rows.length));
  for (const row of rows) next = setRowHeight(next, row, height);
  return next;
}

/** A line row styled like template row 24. Its cells are filled afterwards. */
function lineRowXml(sheet: string, row: number): string {
  const template = sheet.match(new RegExp(`<row r="${FIRST_LINE_ROW}"([^>]*)>([\\s\\S]*?)</row>`));
  if (!template) throw new Error('template line row missing');
  const cells = [...template[2]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)].map(
    ([, column, attrs]) => `<c r="${column}${row}"${attrs!.match(/\ss="[^"]*"/)?.[0] ?? ''}/>`,
  );
  return `<row r="${row}"${template[1]}>${cells.join('')}</row>`;
}

/**
 * Inserts `count` line rows above template row 30. Every row, cell, merge, hyperlink and the dimension at or below
 * row 30 moves down by `count`, so the line block stays one table and nothing overlaps it.
 */
function insertLineRows(sheet: string, count: number): string {
  if (count === 0) return sheet;
  const down = (row: number) => (row >= SEPARATOR_ROW ? row + count : row);
  const moveRef = (ref: string) =>
    ref.replace(/([A-Z]+)(\d+)/g, (_all, column: string, row: string) => `${column}${down(Number(row))}`);
  let next = sheet
    .replace(/<row r="(\d+)"/g, (_all, row: string) => `<row r="${down(Number(row))}"`)
    .replace(/<c r="([A-Z]+\d+)"/g, (_all, ref: string) => `<c r="${moveRef(ref)}"`)
    .replace(/<mergeCell ref="([^"]+)"/g, (_all, ref: string) => `<mergeCell ref="${moveRef(ref)}"`)
    .replace(/<hyperlink ref="([^"]+)"/g, (_all, ref: string) => `<hyperlink ref="${moveRef(ref)}"`)
    .replace(/<dimension ref="([^"]+)"/, (_all, ref: string) => `<dimension ref="${moveRef(ref)}"`);
  const separator = `<row r="${down(SEPARATOR_ROW)}"`;
  if (next.split(separator).length !== 2) throw new Error('template separator row missing');
  const rows = Array.from({ length: count }, (_, index) => SEPARATOR_ROW + index);
  next = next.replace(separator, () => rows.map((row) => lineRowXml(next, row)).join('') + separator);
  for (const row of rows) next = addMerge(next, `C${row}:E${row}`);
  return next;
}

/** Drawing anchors at or below template row 30 move with the rows. The logo above the line block stays put. */
function shiftDrawingRows(drawingXml: string, count: number): string {
  return drawingXml.replace(/<xdr:row>(\d+)<\/xdr:row>/g, (_all, row: string) => {
    const index = Number(row);
    return `<xdr:row>${index >= DRAWING_SHIFT_FROM ? index + count : index}</xdr:row>`;
  });
}

/** The print area ends where the template's last row ends, moved down with the inserted rows. */
function printAreaFor(workbookXml: string, count: number): string {
  const area = `Sheet1!$A$1:$H$${PRINT_AREA_LAST_ROW}`;
  if (!workbookXml.includes(area)) throw new Error('quotation template print area drifted');
  return workbookXml.replace(area, `Sheet1!$A$1:$H$${PRINT_AREA_LAST_ROW + count}`);
}

/** The template keeps the author's local save path in workbook.xml. Drop that optional block and set recalc on load. */
function scrubWorkbook(xml: string): string {
  const scrubbed = xml
    .replace(
      /<mc:AlternateContent\b(?:(?!<\/mc:AlternateContent>)[\s\S])*?absPath(?:(?!<\/mc:AlternateContent>)[\s\S])*?<\/mc:AlternateContent>/,
      '',
    )
    .replace(/<calcPr\b(?![^>]*fullCalcOnLoad)/, '<calcPr fullCalcOnLoad="1"');
  if (scrubbed.includes('absPath')) throw new Error('workbook_path_not_scrubbed');
  return scrubbed;
}

/** Removes the template author and last editor from the document properties. */
function scrubCore(xml: string): string {
  return xml
    .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, '')
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '');
}

/**
 * Fills the staff quotation template. Line totals, the subtotal and the total stay formulas with cached
 * values, so Excel can recalculate them. Metadata is scrubbed. The date is fixed, not TODAY().
 */
export function buildQuoteWorkbook(input: QuoteWorkbookInput): Uint8Array {
  if (input.lines.length < 1) throw new Error('workbook_line_count');
  if (input.lines.length > MAX_WORKBOOK_LINES) throw new WorkbookLineLimitError(lineLimitMessage(input.lines.length));
  const files = unzipSync(readFileSync(TEMPLATE_PATH));
  const sheetBytes = files[SHEET_PATH];
  const workbookBytes = files['xl/workbook.xml'];
  const coreBytes = files['docProps/core.xml'];
  const drawingBytes = files[DRAWING_PATH];
  if (!sheetBytes || !workbookBytes || !coreBytes || !drawingBytes) {
    throw new Error('quotation template missing sheet');
  }
  // Rows inserted above template row 30. Every row-addressed artefact at or below that row moves by the same count.
  const extra = Math.max(0, input.lines.length - TEMPLATE_LINE_ROWS);
  const below = (row: number) => (row >= SEPARATOR_ROW ? row + extra : row);
  let sheet = insertLineRows(new TextDecoder().decode(sheetBytes), extra);
  let subtotal = 0;
  for (const line of input.lines) {
    if (
      !Number.isSafeInteger(line.qty) ||
      line.qty < 1 ||
      !Number.isSafeInteger(line.nights) ||
      line.nights < 1 ||
      !Number.isSafeInteger(line.rateMinor) ||
      line.rateMinor < 0
    ) {
      throw new Error('workbook_line');
    }
    if (line.totalMinor !== line.qty * line.nights * line.rateMinor) throw new Error('workbook_line_total');
    subtotal += line.totalMinor;
  }
  if (!Number.isSafeInteger(subtotal)) throw new Error('money_overflow');

  sheet = setNumber(sheet, 'B9', excelSerialDate(input.authoredDate));
  sheet = setText(sheet, 'B12', input.header.attention);
  sheet = setText(sheet, 'B13', input.header.company);
  sheet = setText(sheet, 'B14', input.header.clientEmail);
  sheet = setText(sheet, 'B15', input.header.clientTelephone);
  const lineRows = Math.max(TEMPLATE_LINE_ROWS, input.lines.length);
  for (let index = 0; index < lineRows; index += 1) {
    const row = FIRST_LINE_ROW + index;
    const line = input.lines[index];
    if (line) {
      sheet = setText(sheet, `A${row}`, line.dateLabel);
      sheet = setNumber(sheet, `B${row}`, line.qty);
      sheet = setText(sheet, `C${row}`, line.description);
      sheet = setNumber(sheet, `F${row}`, line.nights);
      sheet = setNumber(sheet, `G${row}`, randText(line.rateMinor));
    } else {
      // Empty cells, not empty text: text in B, F or G would make the line-total formula an error.
      for (const column of ['A', 'B', 'C', 'F', 'G']) sheet = clearCell(sheet, `${column}${row}`);
    }
    sheet = setFormula(sheet, `H${row}`, `+B${row}*F${row}*G${row}`, randText(line?.totalMinor ?? 0));
  }
  // The subtotal sums through the separator row, as the template's SUM(H24:H30) does, so it moves with it.
  sheet = setFormula(sheet, `H${below(31)}`, `SUM(H${FIRST_LINE_ROW}:H${below(30)})`, randText(subtotal));
  sheet = setFormula(sheet, `H${below(33)}`, `+H${below(31)}`, randText(subtotal));
  if (!input.breakfastIncluded) {
    sheet = setText(sheet, `A${below(38)}`, 'Meals are included only where stated in the line description.');
    sheet = clearCell(sheet, `F${below(39)}`);
  }
  const note = input.note?.trim();
  if (note) sheet = setNote(sheet, note, NOTE_ROWS.map(below));
  sheet = setText(sheet, `B${below(61)}`, input.header.signerName);
  sheet = setText(sheet, `B${below(62)}`, input.header.signerEmail);
  sheet = setText(sheet, `B${below(63)}`, HOTEL_TELEPHONE);

  files[SHEET_PATH] = new TextEncoder().encode(sheet);
  files[DRAWING_PATH] = new TextEncoder().encode(shiftDrawingRows(new TextDecoder().decode(drawingBytes), extra));
  files['xl/workbook.xml'] = new TextEncoder().encode(
    printAreaFor(scrubWorkbook(new TextDecoder().decode(workbookBytes)), extra),
  );
  files['docProps/core.xml'] = new TextEncoder().encode(scrubCore(new TextDecoder().decode(coreBytes)));
  // Formulas changed, so the template's calculation chain is stale. Excel rebuilds it on load.
  delete files[CALC_CHAIN_PATH];
  for (const path of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    if (files[path]) {
      const xml = new TextDecoder().decode(files[path]);
      files[path] = new TextEncoder().encode(xml.replace(/<(?:Relationship|Override)\b[^>]*calcChain[^>]*\/>/g, ''));
    }
  }
  return zipSync(files);
}

/** The workbook for one or more resolved stays: its lines, the exact total, and the bytes. */
export function quoteWorkbookForStays(args: {
  stays: WorkbookStay[];
  header: WorkbookHeader;
  note?: string;
}): { bytes: Uint8Array; totalMinor: number } {
  const { lines, totalMinor } = workbookLinesForStays(args.stays);
  const bytes = buildQuoteWorkbook({
    // The earliest read sets the date, so no stay is quoted beyond the validity of its own read.
    authoredDate: args.stays.map((stay) => stay.revision.authoredDate).sort()[0]!,
    breakfastIncluded: args.stays.every((stay) =>
      stay.revision.groups.every((group) => group.board === 'breakfast' || group.board === 'dinner_bed_breakfast'),
    ),
    header: args.header,
    lines,
    note: args.note,
  });
  return { bytes, totalMinor };
}

/** The workbook for a resolved revision: its lines, the exact total, and the bytes. */
export function quoteWorkbookForRevision(args: {
  revision: QuoteRevision;
  facts?: AuthorizedProposalFacts;
  rowPrices?: RowPrice[];
  header: WorkbookHeader;
  note?: string;
}): { bytes: Uint8Array; totalMinor: number } {
  return quoteWorkbookForStays({
    stays: [{ revision: args.revision, facts: args.facts, rowPrices: args.rowPrices }],
    header: args.header,
    note: args.note,
  });
}

/** "Quote - <Company or Guest> - <arrival>.xlsx" with path-unsafe characters removed. */
export function quoteWorkbookFileName(company: string, arrivalDate: string): string {
  const label = Array.from(company)
    .filter((ch) => ch >= ' ' && !'\\/:*?"<>|'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `Quote - ${label || 'Guest'} - ${arrivalDate}.xlsx`;
}
