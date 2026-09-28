import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proposalDescription, type QuoteMeal } from './description.js';
import { HOTEL_TELEPHONE, quotePdfFileName } from './filename.js';
import { convertXlsxWithGotenberg } from './gotenberg.js';
import { patchProposalWorkbook } from './patch-template.js';

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../fixtures/centurion-quotation-template.xlsx', import.meta.url),
);

export type ProposalPdfInput = {
  attention: string;
  company: string;
  clientEmail: string;
  clientTelephone: string;
  agency: string;
  dateLabel: string;
  lines: Array<{
    dateLabel: string;
    qty: number;
    roomCode: string;
    meal: QuoteMeal;
    nights: number;
    rate: number;
  }>;
};

export class ProposalInputError extends Error {}

export async function buildQuoteProposalPdf(
  input: ProposalPdfInput,
  signer: { name: string; email: string },
  gotenbergUrl: string,
): Promise<{ fileName: string; pdf: Uint8Array }> {
  let descriptions: string[];
  try {
    descriptions = input.lines.map((line) => proposalDescription(line.roomCode, line.meal));
  } catch (err) {
    throw new ProposalInputError(err instanceof Error ? err.message : 'unknown room code');
  }
  const xlsx = patchProposalWorkbook(readFileSync(TEMPLATE_PATH), {
    attention: input.attention,
    company: input.company,
    clientEmail: input.clientEmail,
    clientTelephone: input.clientTelephone,
    signerName: signer.name,
    signerEmail: signer.email,
    signerTelephone: HOTEL_TELEPHONE,
    lines: input.lines.map((line, index) => ({
      dateLabel: line.dateLabel,
      qty: line.qty,
      description: descriptions[index]!,
      nights: line.nights,
      rate: line.rate,
    })),
  });
  return {
    fileName: quotePdfFileName(input.agency, input.dateLabel),
    pdf: await convertXlsxWithGotenberg(xlsx, { url: gotenbergUrl }),
  };
}
