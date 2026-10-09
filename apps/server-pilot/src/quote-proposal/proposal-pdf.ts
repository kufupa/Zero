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
    if (input.lines.some((line) => !['bb', 'dinner_bb', 'room_only'].includes(line.meal))) throw new Error('unknown meal plan');
    descriptions = input.lines.map((line) => proposalDescription(line.roomCode, line.meal));
  } catch (err) {
    throw new ProposalInputError(err instanceof Error ? err.message : 'unknown room code');
  }
  let xlsx: Uint8Array;
  try {
    xlsx = patchProposalWorkbook(readFileSync(TEMPLATE_PATH), {
      attention: input.attention,
      company: input.company,
      clientEmail: input.clientEmail,
      clientTelephone: input.clientTelephone,
      signerName: signer.name,
      signerEmail: signer.email,
      signerTelephone: HOTEL_TELEPHONE,
      breakfastIncluded: input.lines.every((line) => line.meal === 'bb' || line.meal === 'dinner_bb'),
      lines: input.lines.map((line, index) => ({
        dateLabel: line.dateLabel,
        qty: line.qty,
        description: descriptions[index]!,
        nights: line.nights,
        rate: line.rate,
      })),
    });
  } catch (err) {
    throw new ProposalInputError(err instanceof Error ? err.message : 'invalid proposal input');
  }
  return {
    fileName: quotePdfFileName(input.agency, input.dateLabel),
    pdf: await convertXlsxWithGotenberg(xlsx, { url: gotenbergUrl }),
  };
}

import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { deriveQuoteLines, deriveAuthorizedExtraLines, type AuthorizedProposalFacts } from './quote-lines.js';
import { quoteDigest, exactMinor, type QuoteRevision, type ImportedOffer } from './quote-revision.js';
import { quoteDateLabel, quoteWorkbookForStays, workbookLinesForStays, type WorkbookStay } from './quote-workbook.js';
export type RevisionProposalHeader = {attention:string;company:string;clientEmail:string;clientTelephone:string;agency:string;signerName:string;signerEmail:string;/** Unpriced staff note printed under the total. */notes?:string};
function htmlText(value:string):string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function moneyMinor(value:number,currency:string):string {
  if(!Number.isSafeInteger(value)||value<0)throw new ProposalInputError('invalid_money');
  if(!/^[A-Z]{3}$/.test(currency))throw new ProposalInputError('invalid_currency');
  const prefix=currency==='ZAR'?'R':`${currency} `;
  return `${prefix}${Math.floor(value/100).toLocaleString('en-ZA')}.${String(value%100).padStart(2,'0')}`;
}
export function renderRevisionProposalHtml(revision:QuoteRevision,header:RevisionProposalHeader,facts?:AuthorizedProposalFacts):string {
  const native=deriveQuoteLines(revision);
  const extras=facts?deriveAuthorizedExtraLines(revision,facts):[];
  const lines=[...native,...extras.map(line=>({...line,arrivalDate:line.dates[0]??revision.authoredDate,departureDate:line.dates.at(-1)??revision.authoredDate}))];
  const totalMinor=revision.totalMinor+extras.reduce((sum,line)=>sum+line.totalMinor,0);
  if(!Number.isSafeInteger(totalMinor))throw new ProposalInputError('money_overflow');
  const files=unzipSync(readFileSync(TEMPLATE_PATH));
  const images=['xl/media/image1.png','xl/media/image2.png'].map(path=>{
    if(!files[path])throw new Error('quotation template missing drawings');
    return `data:image/png;base64,${Buffer.from(files[path]).toString('base64')}`;
  });
  const pages=[];
  for(let start=0;start<lines.length;start+=6){
    const page=lines.slice(start,start+6),last=start+6>=lines.length;
    pages.push(`<section class="proposal-page"><header><img src="${images[0]}" alt="The Centurion Hotel"><img src="${images[1]}" alt="Legacy Hotels"></header><h1>QUOTATION${start?' · CONTINUED':''}</h1><p>Authored ${htmlText(revision.authoredDate)} · Page ${Math.floor(start/6)+1} of ${Math.ceil(lines.length/6)}</p><div class="client"><strong>Attention:</strong> ${htmlText(header.attention)}<br><strong>Company:</strong> ${htmlText(header.company)}<br>${htmlText(header.clientEmail)}<br>${htmlText(header.clientTelephone)}</div><table><thead><tr><th>DATE</th><th>QTY</th><th>DESCRIPTION</th><th>NIGHTS</th><th>RATE</th><th>LINE TOTAL</th></tr></thead><tbody>${page.map((line,i)=>`<tr data-line="${start+i}"><td>${htmlText(line.arrivalDate)}<br>to ${htmlText(line.departureDate)}</td><td>${line.quantity}</td><td>${htmlText(line.description)}</td><td>${line.nights}</td><td>${moneyMinor(line.rateMinor,revision.currency)}</td><td>${moneyMinor(line.totalMinor,revision.currency)}</td></tr>`).join('')}</tbody></table>${last?`<p class="total" data-proposal-total="${totalMinor}">TOTAL ${moneyMinor(totalMinor,revision.currency)}</p>${header.notes?.trim()?`<p class="staff-note"><strong>Note:</strong> ${htmlText(header.notes.trim()).replace(/\n/g,'<br>')}</p>`:''}<div class="terms"><p>VAT and tourism levy included.</p><p>Meals included are stated in each room description.</p><p>This quotation is valid for three days from the authored date, subject to confirmation of the validity boundary and availability; no rooms are currently being held; this quotation is not a booking.</p><p>Kind regards,<br>${htmlText(header.signerName)}<br>${htmlText(header.signerEmail)}<br>${HOTEL_TELEPHONE}</p></div>`:'<p>Continued on the following page. Final proposal total appears on the last page.</p>'}<footer>The Centurion Hotel</footer></section>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#242424;font-size:10px;margin:0}.proposal-page{break-after:page}.proposal-page:last-child{break-after:auto}header{display:flex;justify-content:space-between;align-items:center;height:72px}header img{max-width:43%;max-height:65px;object-fit:contain}h1{font-size:18px;color:#78633a;border-bottom:2px solid #b49c68;padding:12px 0}.client{line-height:1.6;margin:14px 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#e7dfcb;font-size:9px}th,td{border:1px solid #8d887d;padding:7px 5px;vertical-align:top;overflow-wrap:anywhere}th:nth-child(1){width:17%}th:nth-child(2){width:6%}th:nth-child(3){width:35%}th:nth-child(4){width:8%}th:nth-child(5),th:nth-child(6){width:17%}tr{break-inside:avoid}.total{text-align:right;font-size:15px;font-weight:bold;border-bottom:2px solid #b49c68;padding:10px}.terms{line-height:1.5}footer{font-size:7px;overflow-wrap:anywhere;border-top:1px solid #b49c68;margin-top:20px;padding-top:7px}</style></head><body>${pages.join('')}</body></html>`;
}
/** One document per quote: a single stay keeps its revision id, combined stays get a digest of their revision ids. */
export function documentIdFor(stays: WorkbookStay[]): string {
  return stays.length === 1 ? stays[0]!.revision.id : `quotes:${quoteDigest(stays.map((stay) => stay.revision.id).sort())}`;
}
/** Every stay's dates as one span, e.g. "26 October - 18 November 2026". */
function staySpanLabel(stays: WorkbookStay[]): string {
  const groups = stays.flatMap((stay) => stay.revision.groups);
  return quoteDateLabel(groups.map((group) => group.arrivalDate).sort()[0]!, groups.map((group) => group.departureDate).sort().at(-1)!);
}
/** QUOTE_PDF_RENDERER=html selects the HTML renderer, for one stay only. Anything else uses the Excel master. */
export function quoteProposalPdfUsesHtml(env: Record<string, string | undefined> = process.env): boolean {
  return env.QUOTE_PDF_RENDERER?.trim().toLowerCase() === 'html';
}
/**
 * The proposal PDF for one or more resolved stays. The Excel workbook is the master, and Gotenberg's LibreOffice route
 * converts it. The HTML renderer is the fallback behind QUOTE_PDF_RENDERER=html, and it only renders a single stay.
 */
export async function buildStaysProposalPdf(
  stays: WorkbookStay[],
  header: RevisionProposalHeader,
  opts: { url: string; fetchImpl?: typeof fetch; html?: boolean },
): Promise<{ revisionId: string; pdfHash: string; pdf: Uint8Array; fileName: string; totalMinor: number }> {
  const base = opts.url.replace(/\/+$/, '');
  if (!base) throw new Error('GOTENBERG_URL missing');
  let pdf: Uint8Array;
  let totalMinor: number;
  if (opts.html ?? quoteProposalPdfUsesHtml()) {
    // ponytail: the HTML renderer draws one revision, so a combined quote needs the workbook renderer.
    if (stays.length !== 1) throw new Error('html_renderer_single_stay_only');
    const { revision, facts } = stays[0]!;
    totalMinor = workbookLinesForStays(stays).totalMinor;
    const html = renderRevisionProposalHtml(revision, header, facts);
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('preferCssPageSize', 'true');
    form.append('printBackground', 'true');
    const res = await (opts.fetchImpl ?? fetch)(`${base}/forms/chromium/convert/html`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`gotenberg convert failed: ${res.status}`);
    if (res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') throw new Error('gotenberg convert returned non-PDF MIME');
    pdf = new Uint8Array(await res.arrayBuffer());
    if (pdf.length <= 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new Error('gotenberg convert returned empty or invalid PDF bytes');
  } else {
    const workbook = quoteWorkbookForStays({
      stays,
      header: {
        attention: header.attention,
        company: header.company,
        clientEmail: header.clientEmail,
        clientTelephone: header.clientTelephone,
        signerName: header.signerName,
        signerEmail: header.signerEmail,
      },
      note: header.notes,
    });
    totalMinor = workbook.totalMinor;
    pdf = await convertXlsxWithGotenberg(workbook.bytes, { url: base, fetchImpl: opts.fetchImpl });
  }
  const documentId = documentIdFor(stays);
  return {
    revisionId: documentId,
    pdfHash: createHash('sha256').update(pdf).digest('hex'),
    pdf,
    // ponytail: every PDF carries the document-id suffix, so same-day options never collide and no existing names are looked up.
    fileName: quotePdfFileName(header.agency.trim() || header.company, staySpanLabel(stays), documentId),
    totalMinor,
  };
}
export async function buildRevisionProposalPdf(revision:QuoteRevision,header:RevisionProposalHeader,opts:{url:string;fetchImpl?:typeof fetch;facts?:AuthorizedProposalFacts}):Promise<{revisionId:string;pdfHash:string;pdf:Uint8Array;fileName:string}>{
  const { revisionId, pdfHash, pdf, fileName } = await buildStaysProposalPdf([{ revision, facts: opts.facts }], header, opts);
  return { revisionId, pdfHash, pdf, fileName };
}
type ApprovedOverridePacket=Awaited<ReturnType<typeof import('./quote-revision.js').resolveApprovedOverride>>;
function renderSourceLinePages(input:{id:string;title:string;lines:Array<{description:string;amountMinor:number}>;totalMinor:number;currency:string;terms:string},header:RevisionProposalHeader):string{
 const files=unzipSync(readFileSync(TEMPLATE_PATH));const logo=`data:image/png;base64,${Buffer.from(files['xl/media/image1.png']).toString('base64')}`;
 const pages=[];for(let start=0;start<input.lines.length;start+=6){const last=start+6>=input.lines.length;pages.push(`<section class="proposal-page"><img style="max-width:70%;max-height:90px" src="${logo}"><h1>${htmlText(input.title)}</h1><p>${htmlText(header.attention)} · ${htmlText(header.company)}</p><table><thead><tr><th>ORIGINAL SOURCE LINE</th><th>AMOUNT</th></tr></thead><tbody>${input.lines.slice(start,start+6).map(line=>`<tr><td>${htmlText(line.description)}</td><td>${moneyMinor(line.amountMinor,input.currency)}</td></tr>`).join('')}</tbody></table>${last?`<p data-proposal-total="${input.totalMinor}">TOTAL ${moneyMinor(input.totalMinor,input.currency)}</p><p>${htmlText(input.terms)}</p><p>No rooms are currently being held. Availability must be verified before booking.</p>`:'<p>Continued on the following page.</p>'}<footer>${htmlText(input.id)}</footer></section>`);}
 return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:11px Arial;color:#242424}h1{color:#78633a;border-bottom:2px solid #b49c68}.proposal-page{break-after:page}.proposal-page:last-child{break-after:auto}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #8d887d;padding:10px;overflow-wrap:anywhere}th{background:#e7dfcb}th:last-child{width:25%}tr{break-inside:avoid}footer{font-size:7px;overflow-wrap:anywhere}</style></head><body>${pages.join('')}</body></html>`;
}
export function renderImportedProposalHtml(offer:ImportedOffer,header:RevisionProposalHeader):string{
 const {id,...data}=offer;if(id!==`offer:${quoteDigest(data)}`)throw new Error('imported_identity');
 const lines=offer.lines.map(line=>({description:line.quote,amountMinor:exactMinor(line.amount)}));
 if(lines.reduce((sum,line)=>sum+line.amountMinor,0)!==offer.totalMinor)throw new Error('imported_total');
 return renderSourceLinePages({id,title:'AGREED QUOTATION · ORIGINAL LINES',lines,totalMinor:offer.totalMinor,currency:offer.currency,terms:`Original printed date ${offer.printedDate}; validity ${offer.validUntil}. ${offer.terms}`},header);
}
export function renderApprovedOverrideHtml(packet:ApprovedOverridePacket,header:RevisionProposalHeader):string{
 const {id,...data}=packet;if(id!==`override:${quoteDigest(data)}`)throw new Error('override_identity');
 const original=deriveQuoteLines(packet.sourceRevision);
 return renderSourceLinePages({id,title:'APPROVED QUOTATION ADJUSTMENT',lines:[...original.map(line=>({description:`Original: ${line.arrivalDate} to ${line.departureDate} · ${line.description}`,amountMinor:line.totalMinor})),{description:'Approved replacement total',amountMinor:packet.approvedTotalMinor}],totalMinor:packet.approvedTotalMinor,currency:packet.currency,terms:`Original total ${moneyMinor(packet.originalTotalMinor,packet.currency)} retained for audit. Approved replacement total supersedes the original, rather than adding to it.`},header);
}
export async function convertProposalHtml(html:string,opts:{url:string;fetchImpl?:typeof fetch}):Promise<Uint8Array>{
 const base=opts.url.replace(/\/+$/,'');if(!base)throw new Error('GOTENBERG_URL missing');
 const form=new FormData();form.append('files',new Blob([html],{type:'text/html'}),'index.html');form.append('preferCssPageSize','true');
 const response=await(opts.fetchImpl??fetch)(`${base}/forms/chromium/convert/html`,{method:'POST',body:form});
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim()!=='application/pdf')throw new Error('converter_response');
 const pdf=new Uint8Array(await response.arrayBuffer());if(new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-'||pdf.length<=5)throw new Error('converter_pdf');return pdf;
}
