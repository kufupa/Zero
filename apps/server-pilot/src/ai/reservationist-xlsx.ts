import {
  OpenXmlContentLimitError,
  OpenXmlDecompressionBombError,
  OpenXmlNotImplementedError,
  OpenXmlUnsupportedFormatError,
} from '@office-kit/xlsx/utils';
import { isErrorValue, isFormulaValue, type Cell, type CellValue } from '@office-kit/xlsx/cell';
import { fromBuffer } from '@office-kit/xlsx/node';
import { loadWorkbook } from '@office-kit/xlsx/io';
import { getCellDisplayText } from '@office-kit/xlsx/styles';
import type { Workbook } from '@office-kit/xlsx/workbook';
import { AMBIGUOUS_NUMBER_GROUPS, maskIncomingCardNumbers, PAN_CANDIDATE_PATTERN } from './card-mask.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const RESERVATIONIST_XLSX_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_SHEETS = 12;
const MAX_ROWS_PER_SHEET = 1_000;
const MAX_ROWS = 3_000;
const MAX_CELLS_PER_SHEET = 8_000;
const MAX_CELLS = 12_000;
const MAX_MERGES = 1_000;
const DECOMPRESSION_LIMITS = {
  maxEntryUncompressedBytes: 8 * 1024 * 1024,
  maxTotalUncompressedBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 200,
};
const DATE_TOKEN_PATTERN = /(?<!\d)(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{4})(?!\d)/g;
const SECURITY_CODE_HEADER = /\b(?:cvv2?|cvc2?|cvn|csc)\b|\bsecurity\s+code\b|\bcard\s+(?:security|verification)\s+code\b/i;

export function isReservationistXlsxMimeType(mimeType: string): boolean {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() === XLSX_MIME;
}

function safeCellText(value: CellValue, displayText: string): string {
  const hasComparableRawText = typeof value === 'string' || typeof value === 'number';
  const rawText = hasComparableRawText ? String(value) : displayText;
  const maskedRaw = maskIncomingCardNumbers(rawText);
  const maskedDisplay = maskIncomingCardNumbers(displayText);

  // XLSX numeric display can round a PAN candidate into a non-Luhn string. If
  // only the raw representation is recognized, carry that redaction to the one text output.
  return hasComparableRawText && maskedRaw !== rawText ? maskedRaw : maskedDisplay;
}

function safeRowCells(workbook: Workbook, cells: Cell[]) {
  const displayTexts = cells.map((cell) => getCellDisplayText(workbook, cell));
  // A PAN can be split into adjacent cells. The shared masker catches the assembled span; redact
  // digit-bearing cells in that row when masking only each cell would otherwise miss it.
  const maskedSeparately = displayTexts.map(maskIncomingCardNumbers).join(' ');
  const maskedTogether = maskIncomingCardNumbers(displayTexts.join(' '));
  const spansCells = maskedSeparately !== maskedTogether;
  return cells.map((cell, index) => {
    const displayText = displayTexts[index] ?? '';
    const requiresReview = spansCells && /\d/.test(displayText);
    return {
      columnNumber: cell.col,
      displayText: requiresReview ? AMBIGUOUS_NUMBER_GROUPS : safeCellText(cell.value, displayText),
    };
  });
}

/** Reject a sheet for staff review when a card-like number crosses one or more row boundaries. */
function hasCrossRowPanCandidate(
  workbook: Workbook,
  rows: Array<[number, { values(): Iterable<Cell> }]>,
) {
  const crossesBoundary = (text: string, boundaries: number[]) => {
    const dateSafe = text.replace(new RegExp(DATE_TOKEN_PATTERN.source, 'g'), (date) => 'x'.repeat(date.length));
    return [...dateSafe.matchAll(new RegExp(PAN_CANDIDATE_PATTERN.source, 'g'))].some((match) => {
      const start = match.index ?? -1;
      return boundaries.some((boundary) => start < boundary && start + match[0].length > boundary);
    });
  };
  let text = '';
  let previousRowNumber: number | undefined;
  let boundaries: number[] = [];
  for (const [rowNumber, row] of rows) {
    if (previousRowNumber !== undefined && rowNumber !== previousRowNumber + 1) {
      if (crossesBoundary(text, boundaries)) return true;
      text = '';
      boundaries = [];
    }
    const rowText = [...row.values()].sort((left, right) => left.col - right.col)
      .map((cell) => getCellDisplayText(workbook, cell)).join(' ');
    if (text) {
      boundaries.push(text.length + 1);
      text += ' ';
    }
    text += rowText;
    previousRowNumber = rowNumber;
  }
  return crossesBoundary(text, boundaries);
}

function failureReason(error: unknown): string {
  if (error instanceof OpenXmlUnsupportedFormatError) {
    return error.format === 'encrypted-xlsx' ? 'spreadsheet_encrypted' : 'spreadsheet_unsupported_format';
  }
  if (error instanceof OpenXmlDecompressionBombError) return 'spreadsheet_safety_limit';
  if (error instanceof OpenXmlContentLimitError) return 'spreadsheet_content_limit';
  if (error instanceof OpenXmlNotImplementedError) return 'spreadsheet_unsupported_format';
  return 'spreadsheet_parse_failed';
}

/**
 * Read cell values from a small, plain XLSX. Partial, hidden, formula-driven or
 * otherwise uncertain workbooks stay manual_required; no truncated cells reach
 * extraction as if they were the complete source.
 */
export async function extractReservationistXlsxText(input: {
  body: Uint8Array;
  signal: AbortSignal;
}): Promise<{ reason: string; text: string | null }> {
  const fail = (reason: string) => ({ reason, text: null });
  input.signal.throwIfAborted();
  if (input.body.byteLength > RESERVATIONIST_XLSX_MAX_INPUT_BYTES) return fail('spreadsheet_too_large');
  if (input.body.byteLength < 4 || input.body[0] !== 0x50 || input.body[1] !== 0x4b) {
    return fail('spreadsheet_parse_failed');
  }

  let workbook: Workbook;
  try {
    workbook = await loadWorkbook(fromBuffer(input.body), {
      decompressionLimits: DECOMPRESSION_LIMITS,
      contentLimits: { maxRows: MAX_ROWS + 1, maxCells: MAX_CELLS + 1 },
    });
  } catch (error) {
    input.signal.throwIfAborted();
    return fail(failureReason(error));
  }

  try {
    input.signal.throwIfAborted();
    if (!workbook.sheets.length) return fail('spreadsheet_empty');
    if (workbook.sheets.length > MAX_SHEETS) return fail('spreadsheet_sheet_limit');
    if ((workbook.fileFormat && workbook.fileFormat !== 'xlsx') || workbook.passthrough?.size) {
      return fail('spreadsheet_unsupported_content');
    }

    let totalRows = 0;
    let totalCells = 0;
    let totalValues = 0;
    let totalOutputBytes = 0;
    const pages: string[] = [];

    for (const [sheetIndex, entry] of workbook.sheets.entries()) {
      input.signal.throwIfAborted();
      if (entry.kind !== 'worksheet') return fail('spreadsheet_chart_sheet');
      if (entry.state !== 'visible') return fail('spreadsheet_hidden_sheet');

      const sheet = entry.sheet;
      if (sheet.drawing || sheet.legacyComments.length || sheet.threadedComments?.length || sheet.hyperlinks.length) {
        return fail('spreadsheet_unsupported_content');
      }
      if ([...sheet.rowDimensions.values()].some((row) => row.hidden) ||
          [...sheet.columnDimensions.values()].some((column) => column.hidden)) {
        return fail('spreadsheet_hidden_rows_or_columns');
      }
      if (sheet.mergedCells.length > MAX_MERGES) return fail('spreadsheet_content_limit');

      const rows = [...sheet.rows.entries()].sort(([left], [right]) => left - right);
      if (rows.length > MAX_ROWS_PER_SHEET || totalRows + rows.length > MAX_ROWS ||
          rows.some(([rowNumber]) => rowNumber > MAX_ROWS_PER_SHEET)) {
        return fail('spreadsheet_row_limit');
      }
      totalRows += rows.length;

      if (rows.some(([, row]) => [...row.values()].some((cell) =>
        SECURITY_CODE_HEADER.test(getCellDisplayText(workbook, cell))))) {
        return fail('spreadsheet_sensitive_card_code_column');
      }
      if (hasCrossRowPanCandidate(workbook, rows)) return fail('spreadsheet_card_groups_cross_rows');

      const rowLines: string[] = [];
      let sheetCells = 0;
      let sheetValues = 0;
      let rowBytes = 0;
      const separatorBytes = pages.length ? 2 : 0;
      for (const [rowNumber, row] of rows) {
        input.signal.throwIfAborted();
        const cells = [...row.values()].sort((left, right) => left.col - right.col);
        sheetCells += cells.length;
        if (sheetCells > MAX_CELLS_PER_SHEET || totalCells + cells.length > MAX_CELLS) {
          return fail('spreadsheet_cell_limit');
        }
        totalCells += cells.length;

        if (cells.some((cell) => isFormulaValue(cell.value))) {
          return fail('spreadsheet_formula_cells');
        }
        if (cells.some((cell) => isErrorValue(cell.value))) {
          return fail('spreadsheet_error_cells');
        }

        const populatedCells = cells.filter((cell) => cell.value !== null && cell.value !== '');
        sheetValues += populatedCells.length;
        totalValues += populatedCells.length;

        const line = JSON.stringify({
          rowNumber,
          cells: safeRowCells(workbook, cells),
        });
        const additionalBytes = Buffer.byteLength(line, 'utf8') + 1;
        if (rowBytes + additionalBytes > MAX_OUTPUT_BYTES) {
          return fail('spreadsheet_output_limit');
        }
        rowLines.push(line);
        rowBytes += additionalBytes;
      }

      const header = JSON.stringify({
        sheetName: maskIncomingCardNumbers(sheet.title),
        sheetNumber: sheetIndex + 1,
        sheetCount: workbook.sheets.length,
        rowCount: rows.length,
        cellCount: sheetCells,
        empty: sheetValues === 0,
        mergeRanges: sheet.mergedCells,
      });
      const pageBytes = Buffer.byteLength(header, 'utf8') + rowBytes;
      if (totalOutputBytes + separatorBytes + pageBytes > MAX_OUTPUT_BYTES) {
        return fail('spreadsheet_output_limit');
      }
      totalOutputBytes += separatorBytes + pageBytes;
      pages.push([header, ...rowLines].join('\n'));
    }

    if (!totalValues) return fail('spreadsheet_empty');
    return { reason: 'text', text: pages.join('\n\n') };
  } catch (error) {
    input.signal.throwIfAborted();
    return fail(failureReason(error));
  }
}
