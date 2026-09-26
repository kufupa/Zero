import { unzipSync, zipSync } from 'fflate';
import { patchSheetXml, type ProposalPatchInput } from './patch-sheet.js';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const DRAWING_PATH = 'xl/drawings/drawing1.xml';
const PRINT_AREA = 'Sheet1!$A$1:$H$69';

export function patchProposalWorkbook(templateBytes: Uint8Array, input: ProposalPatchInput): Uint8Array {
  const files = unzipSync(templateBytes);
  const sheetBytes = files[SHEET_PATH];
  const workbook = files['xl/workbook.xml'];
  if (!sheetBytes || !workbook) throw new Error('quotation template missing sheet');
  if (!files[DRAWING_PATH] || !files['xl/media/image1.png'] || !files['xl/media/image2.png']) {
    throw new Error('quotation template missing drawings');
  }
  const workbookXml = new TextDecoder().decode(workbook);
  if (!workbookXml.includes(PRINT_AREA)) {
    throw new Error('quotation template print area drifted');
  }
  const sheetXml = new TextDecoder().decode(sheetBytes);
  files[SHEET_PATH] = new TextEncoder().encode(patchSheetXml(sheetXml, input));
  return zipSync(files);
}
