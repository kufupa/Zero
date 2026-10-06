export type ProposalLine = {
  dateLabel: string;
  qty: number;
  description: string;
  nights: number;
  rate: number;
};

export type ProposalPatchInput = {
  attention: string;
  company: string;
  clientEmail: string;
  clientTelephone: string;
  signerName: string;
  signerEmail: string;
  signerTelephone: string;
  lines: ProposalLine[];
  breakfastIncluded?: boolean;
};

function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function styleAttr(rawAttrs: string): string {
  const match = rawAttrs.match(/\ss="[^"]*"/);
  return match ? match[0] : '';
}

function setInlineStr(sheet: string, ref: string, value: string): string {
  const cellRe = new RegExp(`<c r="${ref}"([^/]*?)(?:/>|>[\\s\\S]*?</c>)`);
  if (!cellRe.test(sheet)) {
    throw new Error(`missing cell ${ref}`);
  }
  return sheet.replace(cellRe, (_all, attrs: string) => {
    return `<c r="${ref}"${styleAttr(attrs)} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
  });
}

function setNumber(sheet: string, ref: string, value: number): string {
  const cellRe = new RegExp(`<c r="${ref}"([^/]*?)(?:/>|>[\\s\\S]*?</c>)`);
  if (!cellRe.test(sheet)) {
    throw new Error(`missing cell ${ref}`);
  }
  return sheet.replace(cellRe, (_all, attrs: string) => {
    return `<c r="${ref}"${styleAttr(attrs)}><v>${value}</v></c>`;
  });
}

export function patchSheetXml(sheetXml: string, input: ProposalPatchInput): string {
  if (input.lines.length === 0 || input.lines.length > 6) {
    throw new Error('proposal overflow: supports 1–6 line items until continuation pages are available');
  }
  const totals = input.lines.map((line) => {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1 || !Number.isSafeInteger(line.nights) || line.nights < 1) {
      throw new Error('proposal quantity and nights must be positive safe integers');
    }
    const cents = Math.round(line.rate * 100);
    if (!Number.isFinite(line.rate) || line.rate < 0 || !Number.isSafeInteger(cents) || Math.abs(line.rate * 100 - cents) > 1e-7) {
      throw new Error('proposal rate must be nonnegative exact cents');
    }
    const total = cents * line.qty * line.nights;
    if (!Number.isSafeInteger(total)) throw new Error('proposal money exceeds safe cents');
    return total;
  });
  const subtotal = totals.reduce((sum, total) => sum + total, 0);
  if (!Number.isSafeInteger(subtotal)) throw new Error('proposal money exceeds safe cents');
  let sheet = sheetXml;
  // Remove every stale input and formula cache, including the broken seventh row.
  for (let row = 24; row <= 30; row++) {
    for (const col of ['A', 'B', 'C', 'F', 'G', 'H']) sheet = setInlineStr(sheet, `${col}${row}`, '');
  }
  sheet = setNumber(sheet, 'H31', subtotal / 100);
  sheet = setNumber(sheet, 'H33', subtotal / 100);
  if (input.breakfastIncluded !== true) {
    sheet = setInlineStr(sheet, 'A38', 'Meals are included only where stated in the line description.');
    sheet = setInlineStr(sheet, 'F39', '');
  }
  sheet = setInlineStr(sheet, 'B12', input.attention);
  sheet = setInlineStr(sheet, 'B13', input.company);
  sheet = setInlineStr(sheet, 'B14', input.clientEmail);
  sheet = setInlineStr(sheet, 'B15', input.clientTelephone);
  input.lines.forEach((line, index) => {
    const row = 24 + index;
    sheet = setInlineStr(sheet, `A${row}`, line.dateLabel);
    sheet = setNumber(sheet, `B${row}`, line.qty);
    sheet = setInlineStr(sheet, `C${row}`, line.description);
    sheet = setNumber(sheet, `F${row}`, line.nights);
    sheet = setNumber(sheet, `G${row}`, line.rate);
    sheet = setNumber(sheet, `H${row}`, totals[index]! / 100);
  });
  sheet = setInlineStr(sheet, 'B61', input.signerName);
  sheet = setInlineStr(sheet, 'B62', input.signerEmail);
  sheet = setInlineStr(sheet, 'B63', input.signerTelephone);
  return sheet;
}
