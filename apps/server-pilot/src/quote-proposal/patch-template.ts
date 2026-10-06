import { unzipSync, zipSync } from 'fflate';
import { patchSheetXml, type ProposalPatchInput } from './patch-sheet.js';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const DRAWING_PATH = 'xl/drawings/drawing1.xml';
const PRINT_AREA = 'Sheet1!$A$1:$H$69';

function widenAvailabilitySentence(sheetXml: string): string {
  const merges = [...sheetXml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/>/g)];
  const known = '<mergeCell ref="A52:F52"/>';
  const column = (label: string) => [...label].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
  const overlapping = merges.filter(([, left, top, right, bottom]) =>
    Number(top) <= 52 && Number(bottom) >= 52 && column(left!) <= 8 && column(right!) >= 1);
  if (overlapping.length !== 1 || overlapping[0]![0] !== known) {
    throw new Error('quotation availability sentence geometry drifted');
  }
  for (const ref of ['G52', 'H52']) {
    const cells = [...sheetXml.matchAll(new RegExp(`<c\\b[^<>]*?\\br="${ref}"[^<>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`, 'g'))];
    if (cells.length !== 1 || !/^<c\b[^<>]*\/>$/.test(cells[0]![0])) {
      throw new Error('quotation availability sentence geometry occupied');
    }
  }
  return sheetXml.replace(known, '<mergeCell ref="A52:H52"/>');
}

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
  files[SHEET_PATH] = new TextEncoder().encode(patchSheetXml(widenAvailabilitySentence(sheetXml), input));
  // Monetary formulas are gone; their old dependency chain must not survive.
  delete files['xl/calcChain.xml'];
  for (const path of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    if (files[path]) {
      const xml = new TextDecoder().decode(files[path]);
      files[path] = new TextEncoder().encode(xml.replace(/<(?:Relationship|Override)\b[^>]*calcChain[^>]*\/>/g, ''));
    }
  }
  return zipSync(files);
}
