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
  if (input.lines.length === 0 || input.lines.length > 7) {
    throw new Error('proposal supports 1–7 line items');
  }
  let sheet = sheetXml;
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
  });
  sheet = setInlineStr(sheet, 'B61', input.signerName);
  sheet = setInlineStr(sheet, 'B62', input.signerEmail);
  sheet = setInlineStr(sheet, 'B63', input.signerTelephone);
  return sheet;
}
