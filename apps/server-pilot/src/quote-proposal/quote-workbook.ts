import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { HOTEL_TELEPHONE } from './filename.js';
import { deriveAuthorizedExtraLines, deriveQuoteLines, type AuthorizedProposalFacts } from './quote-lines.js';
import type { QuoteRevision } from './quote-revision.js';

const TEMPLATE_PATH = fileURLToPath(new URL('../../fixtures/centurion-quotation-template.xlsx', import.meta.url));
const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const CALC_CHAIN_PATH = 'xl/calcChain.xml';
/** Template line rows 24-29. Row 30 is a merged separator and row 31 holds the subtotal. */
export const WORKBOOK_LINE_ROWS = 6;
const FIRST_LINE_ROW = 24;
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

function combineItems(group: WorkbookItem[]): WorkbookItem {
  const first = group[0]!;
  if (group.length === 1) return first;
  const arrival = group.map((item) => item.arrival).sort()[0]!;
  const departure = group.map((item) => item.departure).sort().at(-1)!;
  const totalMinor = sumOf(group, 'totalMinor');
  const uniform = group.every((item) => item.rateMinor === first.rateMinor && item.nights === first.nights);
  // Uniform blocks keep guests x nights. Mixed blocks become one exact 1 x 1 x total line.
  return uniform
    ? { ...first, qty: sumOf(group, 'qty'), totalMinor, arrival, departure }
    : { ...first, qty: 1, nights: 1, rateMinor: totalMinor, totalMinor, arrival, departure };
}

/** Merges extras of the same service into one line each. Room lines are never merged. */
function mergeExtrasByService(items: WorkbookItem[]): WorkbookItem[] {
  const byService = new Map<string, WorkbookItem[]>();
  for (const item of items) {
    if (item.extra) byService.set(item.service, [...(byService.get(item.service) ?? []), item]);
  }
  const emitted = new Set<string>();
  const rows: WorkbookItem[] = [];
  for (const item of items) {
    if (!item.extra) {
      rows.push(item);
    } else if (!emitted.has(item.service)) {
      emitted.add(item.service);
      rows.push(combineItems(byService.get(item.service)!));
    }
  }
  return rows;
}

function otherChargesItem(items: WorkbookItem[]): WorkbookItem {
  return {
    service: 'other_charges',
    extra: true,
    description: 'Other charges',
    qty: 1,
    nights: 1,
    rateMinor: sumOf(items, 'totalMinor'),
    totalMinor: sumOf(items, 'totalMinor'),
    arrival: items.map((item) => item.arrival).sort()[0]!,
    departure: items.map((item) => item.departure).sort().at(-1)!,
  };
}

/**
 * Fits room and extra items into the six template rows. Extras are merged by type first. If that is
 * still too many, everything from the last row on becomes one "Other charges" line, so the total stays exact.
 */
function fitWorkbookItems(items: WorkbookItem[]): WorkbookItem[] {
  let rows = items;
  if (rows.length > WORKBOOK_LINE_ROWS) rows = mergeExtrasByService(rows);
  if (rows.length > WORKBOOK_LINE_ROWS) {
    rows = [...rows.slice(0, WORKBOOK_LINE_ROWS - 1), otherChargesItem(rows.slice(WORKBOOK_LINE_ROWS - 1))];
  }
  return rows;
}

/** Workbook lines for a resolved revision and its authorised extras, with the exact total they add up to. */
export function workbookLinesFor(
  revision: QuoteRevision,
  facts?: AuthorizedProposalFacts,
): { lines: WorkbookLine[]; totalMinor: number } {
  const rooms = deriveQuoteLines(revision).map(
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
  const extras = (facts ? deriveAuthorizedExtraLines(revision, facts) : []).map(
    (line): WorkbookItem => ({
      service: line.service,
      extra: true,
      description: line.description,
      qty: line.quantity,
      nights: line.nights,
      rateMinor: line.rateMinor,
      totalMinor: line.totalMinor,
      arrival: line.dates[0] ?? revision.authoredDate,
      departure: line.dates.at(-1) ?? revision.authoredDate,
    }),
  );
  const items = [...rooms, ...extras];
  const totalMinor = sumOf(items, 'totalMinor');
  if (!Number.isSafeInteger(totalMinor)) throw new Error('money_overflow');
  const lines = fitWorkbookItems(items).map(
    (item): WorkbookLine => ({
      dateLabel: quoteDateLabel(item.arrival, item.departure),
      description: item.description,
      qty: item.qty,
      nights: item.nights,
      rateMinor: item.rateMinor,
      totalMinor: item.totalMinor,
    }),
  );
  if (lines.reduce((sum, line) => sum + line.totalMinor, 0) !== totalMinor) {
    throw new Error('workbook_total_mismatch');
  }
  return { lines, totalMinor };
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

function setNote(sheet: string, note: string): string {
  const text = `Note: ${note}`;
  let next = setText(sheet, `A${NOTE_ROWS[0]}`, text, NOTE_STYLE);
  next = addMerge(next, `A${NOTE_ROWS[0]}:H${NOTE_ROWS.at(-1)}`);
  const wrappedLines = text
    .split('\n')
    .reduce((count, part) => count + Math.max(1, Math.ceil(part.length / NOTE_CHARS_PER_LINE)), 0);
  const needed = wrappedLines * 15 + 4;
  const height = Math.max(17.4, Math.ceil(needed / NOTE_ROWS.length));
  for (const row of NOTE_ROWS) next = setRowHeight(next, row, height);
  return next;
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
  if (input.lines.length < 1 || input.lines.length > WORKBOOK_LINE_ROWS) throw new Error('workbook_line_count');
  const files = unzipSync(readFileSync(TEMPLATE_PATH));
  const sheetBytes = files[SHEET_PATH];
  const workbookBytes = files['xl/workbook.xml'];
  const coreBytes = files['docProps/core.xml'];
  if (!sheetBytes || !workbookBytes || !coreBytes) throw new Error('quotation template missing sheet');
  let sheet = new TextDecoder().decode(sheetBytes);
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
  for (let index = 0; index < WORKBOOK_LINE_ROWS; index += 1) {
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
  sheet = setFormula(sheet, 'H31', 'SUM(H24:H30)', randText(subtotal));
  sheet = setFormula(sheet, 'H33', '+H31', randText(subtotal));
  if (!input.breakfastIncluded) {
    sheet = setText(sheet, 'A38', 'Meals are included only where stated in the line description.');
    sheet = clearCell(sheet, 'F39');
  }
  const note = input.note?.trim();
  if (note) sheet = setNote(sheet, note);
  sheet = setText(sheet, 'B61', input.header.signerName);
  sheet = setText(sheet, 'B62', input.header.signerEmail);
  sheet = setText(sheet, 'B63', HOTEL_TELEPHONE);

  files[SHEET_PATH] = new TextEncoder().encode(sheet);
  files['xl/workbook.xml'] = new TextEncoder().encode(scrubWorkbook(new TextDecoder().decode(workbookBytes)));
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

/** The workbook for a resolved revision: its lines, the exact total, and the bytes. */
export function quoteWorkbookForRevision(args: {
  revision: QuoteRevision;
  facts?: AuthorizedProposalFacts;
  header: WorkbookHeader;
  note?: string;
}): { bytes: Uint8Array; totalMinor: number } {
  const { lines, totalMinor } = workbookLinesFor(args.revision, args.facts);
  const bytes = buildQuoteWorkbook({
    authoredDate: args.revision.authoredDate,
    breakfastIncluded: args.revision.groups.every(
      (group) => group.board === 'breakfast' || group.board === 'dinner_bed_breakfast',
    ),
    header: args.header,
    lines,
    note: args.note,
  });
  return { bytes, totalMinor };
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
