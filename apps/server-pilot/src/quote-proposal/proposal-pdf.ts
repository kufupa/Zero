import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proposalDescription, type QuoteMeal } from './description.js';
import { quotePdfFileName, quotePropertyIdentity } from './filename.js';
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
  propertyCode?: string;
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
    descriptions = input.lines.map((line) =>
      proposalDescription(line.roomCode, line.meal, input.propertyCode ?? 'HRCEN'),
    );
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
      signerTelephone: quotePropertyIdentity(input.propertyCode ?? 'HRCEN').telephone ?? '',
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
import { deriveQuoteLines, deriveAuthorizedExtraLines, extraDisplayDescription, pricedRoomTotal, type AuthorizedProposalFacts, type RowPrice } from './quote-lines.js';
import { quoteDigest, exactMinor, type QuoteRevision, type ImportedOffer } from './quote-revision.js';
import { assertProposalLineLimit, quoteDateLabel, quoteOutputPropertyCode, quoteWorkbookForStays, WorkbookLineLimitError, WorkbookRefusalError, type WorkbookStay } from './quote-workbook.js';
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
function quotationLetterheadImages(): string[] {
  const files = unzipSync(readFileSync(TEMPLATE_PATH));
  return ['xl/media/image1.png', 'xl/media/image2.png'].map((path) => {
    if (!files[path]) throw new Error('quotation template missing drawings');
    return `data:image/png;base64,${Buffer.from(files[path]).toString('base64')}`;
  });
}

export function renderRevisionProposalHtml(revision: QuoteRevision, header: RevisionProposalHeader, facts?: AuthorizedProposalFacts, rowPrices?: RowPrice[]): string {
  const identity = quotePropertyIdentity(revision.propertyCode);
  const native = deriveQuoteLines(revision, rowPrices);
  const extras = facts ? deriveAuthorizedExtraLines(revision, facts) : [];
  const lines = [
    ...native,
    ...extras.map((line) => ({
      ...line,
      description: extraDisplayDescription(line),
      arrivalDate: line.dates[0] ?? revision.authoredDate,
      departureDate: line.dates.at(-1) ?? revision.authoredDate,
    })),
  ];
  const totalMinor = native.reduce((sum, line) => sum + line.totalMinor, 0) + extras.reduce((sum, line) => sum + line.totalMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) throw new ProposalInputError('money_overflow');
  const images = identity.letterhead === 'centurion-template' ? quotationLetterheadImages() : [];
  const breakfastIncluded = revision.groups.every(
    (group) => group.board === 'breakfast' || group.board === 'dinner_bed_breakfast',
  );
  const hotel = htmlText(identity.name);
  const address = identity.addressLines.map((line) => htmlText(line)).join('<br>');
  const letterhead =
    identity.letterhead === 'centurion-template'
      ? `<header><img src="${images[0]}" alt="${hotel}"><img src="${images[1]}" alt="Legacy Hotels"></header>`
      : `<header class="property-letterhead"><p class="property-name">${hotel}</p>${address ? `<p class="property-address">${address}</p>` : ''}</header>`;
  const includedMeals =
    identity.letterhead === 'centurion-template' && breakfastIncluded
      ? '<li>*Breakfast in Brunos Restaurant</li>'
      : '<li>Meals are included only where stated in the line description.</li>';
  const rateBenefits =
    identity.letterhead === 'centurion-template'
      ? `<div class="rate-benefits"><div><strong>Included in your rate:</strong><ul><li>*1% Tourism Levy</li>${includedMeals}<li>*Wi-Fi</li><li>*Access to the Fitness Centre &amp; Pool</li><li>*Arrival/Welcome Platter</li></ul></div><div><strong>Optional Spoils (Prices on request)</strong><ul><li>*Birthday Turndown</li><li>*Honeymoon Turndown</li><li>*Breakfast On-The-Go</li><li>*Private Dining</li></ul></div></div>`
      : `<div class="rate-benefits"><div><strong>Included in your rate:</strong><ul><li>*1% Tourism Levy</li>${includedMeals}</ul></div></div>`;
  const website = identity.websiteLabel
    ? `<p><a href="${htmlText(identity.websiteUrl)}">${htmlText(identity.websiteLabel)}</a></p>`
    : '';
  const telephone = identity.telephone ? htmlText(identity.telephone) : '';
  const pages = [];

  for (let start = 0; start < lines.length; start += 6) {
    const page = lines.slice(start, start + 6);
    const last = start + 6 >= lines.length;
    const rows = page.map((line, index) => `<tr data-line="${start + index}"><td>${htmlText(quoteDateLabel(line.arrivalDate, line.departureDate))}</td><td>${line.quantity}</td><td>${htmlText(line.description)}</td><td>${line.nights}</td><td>${moneyMinor(line.rateMinor, revision.currency)}</td><td>${moneyMinor(line.totalMinor, revision.currency)}</td></tr>`).join('');
    const totalBlock = last
      ? `<p class="subtotal" data-proposal-subtotal="${totalMinor}">subtotal ${moneyMinor(totalMinor, revision.currency)}</p><p class="vat">15% vat <span>Included</span></p><p class="total" data-proposal-total="${totalMinor}">total ${moneyMinor(totalMinor, revision.currency)}</p>${header.notes?.trim() ? `<p class="staff-note"><strong>Note:</strong> ${htmlText(header.notes.trim()).replace(/\n/g, '<br>')}</p>` : ''}${rateBenefits}`
      : '<p>Continued on the following page. Final proposal total appears on the last page.</p>';
    const headerBlock = start === 0
      ? `<p>Date: ${htmlText(quoteDateLabel(revision.authoredDate, revision.authoredDate))}</p><p>Valid until: 3 days from date quoted above</p><div class="client"><strong>Attention:</strong> ${htmlText(header.attention)}<br><strong>Company:</strong> ${htmlText(header.company)}<br><strong>Email:</strong> ${htmlText(header.clientEmail)}<br><strong>Telephone:</strong> ${htmlText(header.clientTelephone)}</div><p>${hotel} thanks you for choosing us for your upcoming stay.</p><p>We are delighted to assist in planning your stay and look forward to welcoming you to our piece of paradise.</p><p>Below is the tailored accommodation package we have curated for you.</p>`
      : '<p>Continued quotation.</p>';
    pages.push(`<section class="proposal-page">${letterhead}<h1>QUOTATION${start ? ' · CONTINUED' : ''}</h1>${headerBlock}<table><thead><tr><th>DATE</th><th>QTY</th><th>DESCRIPTION</th><th>Nights</th><th>RATE</th><th>LINE TOTAL</th></tr></thead><tbody>${rows}</tbody></table>${totalBlock}<footer>${hotel}</footer></section>`);
  }
  pages.push(`<section class="proposal-page terms-page"><h2>Terms and Conditions:</h2><p>All rates above include 15% VAT</p><p>No booking has been made and is subjected to availability on acceptance of this quotation</p><p>Prices are subject to change without notice</p><p>For full terms and conditions, please click <a href="https://www.legacyhotels.co.za">HERE</a></p>${website}<div class="acceptance"><p>Accepted By: ____________________ <span>Date: ______________</span></p><p>Reservations Team:</p><p>Full Name: ${htmlText(header.signerName)}</p><p>Email: ${htmlText(header.signerEmail)}</p>${telephone ? `<p>Telephone: ${telephone}</p>` : ''}</div><footer>${hotel}</footer></section>`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#242424;font-size:10px;margin:0}.proposal-page{break-after:page}.proposal-page:last-child{break-after:auto}header{display:flex;justify-content:space-between;align-items:center;height:72px}header img{max-width:43%;max-height:65px;object-fit:contain}.property-letterhead{display:block;height:auto;flex-direction:column;align-items:flex-start}.property-name{font-size:16px;font-weight:bold;color:#78633a;margin:0}.property-address{margin:4px 0 0}h1,h2{font-size:18px;color:#78633a;border-bottom:2px solid #b49c68;padding:12px 0}p{line-height:1.45;margin:7px 0}.client{line-height:1.6;margin:14px 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#e7dfcb;font-size:9px}th,td{border:1px solid #8d887d;padding:7px 5px;vertical-align:top;overflow-wrap:anywhere}th:nth-child(1){width:17%}th:nth-child(2){width:6%}th:nth-child(3){width:35%}th:nth-child(4){width:8%}th:nth-child(5),th:nth-child(6){width:17%}tr{break-inside:avoid}.subtotal,.total{text-align:right;font-weight:bold;padding:5px}.total{font-size:15px;border-bottom:2px solid #b49c68;padding:10px}.vat{text-align:right}.rate-benefits{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}.rate-benefits ul{margin:5px 0;padding-left:16px;list-style:none}.acceptance{margin-top:40px}.acceptance span{margin-left:36px}footer{font-size:7px;overflow-wrap:anywhere;border-top:1px solid #b49c68;margin-top:20px;padding-top:7px}</style></head><body>${pages.join('')}</body></html>`;
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
/** The proposal PDF could not be produced. The message is safe to show staff. */
export class ProposalPdfUnavailableError extends Error {}
/** Each Gotenberg call gets this long, so a stuck converter fails the request instead of hanging it. */
const PDF_CONVERT_TIMEOUT_MS = 30_000;
function timedFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  return (url, init) => {
    const timeout = AbortSignal.timeout(PDF_CONVERT_TIMEOUT_MS);
    return (fetchImpl ?? fetch)(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}
async function revisionHtmlPdf(html: string, base: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('preferCssPageSize', 'true');
  form.append('printBackground', 'true');
  const res = await fetchImpl(`${base}/forms/chromium/convert/html`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`gotenberg convert failed: ${res.status}`);
  if (res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') throw new Error('gotenberg convert returned non-PDF MIME');
  const pdf = new Uint8Array(await res.arrayBuffer());
  if (pdf.length <= 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new Error('gotenberg convert returned empty or invalid PDF bytes');
  return pdf;
}
/** The total the HTML renderer prints: the priced rooms plus the authorised extras, in the revision's own currency. */
function revisionHtmlTotal(stay: WorkbookStay): number {
  return pricedRoomTotal(stay.revision, stay.rowPrices) + (stay.facts ? deriveAuthorizedExtraLines(stay.revision, stay.facts).reduce((sum, line) => sum + line.totalMinor, 0) : 0);
}
/**
 * The proposal PDF for one or more resolved stays. The Excel workbook is the master, and Gotenberg's LibreOffice route
 * converts it. A single stay falls back to the HTML renderer when the workbook cannot be built or converted, and
 * QUOTE_PDF_RENDERER=html selects that renderer outright. A combined quote has no fallback: it fails with
 * ProposalPdfUnavailableError, and a quote too large for the Excel fails with its WorkbookRefusalError.
 */
export async function buildStaysProposalPdf(
  stays: WorkbookStay[],
  header: RevisionProposalHeader,
  opts: { url: string; fetchImpl?: typeof fetch; html?: boolean },
): Promise<{ revisionId: string; pdfHash: string; pdf: Uint8Array; fileName: string; totalMinor: number }> {
  const base = opts.url.replace(/\/+$/, '');
  if (!base) throw new Error('GOTENBERG_URL missing');
  quoteOutputPropertyCode(stays);
  assertProposalLineLimit(stays);
  const fetchImpl = timedFetch(opts.fetchImpl);
  const single = stays.length === 1 ? stays[0]! : undefined;
  let rendered: { pdf: Uint8Array; totalMinor: number };
  const viaHtml = async (stay: WorkbookStay) => {
    const html = renderRevisionProposalHtml(stay.revision, header, stay.facts, stay.rowPrices);
    try {
      return { pdf: await revisionHtmlPdf(html, base, fetchImpl), totalMinor: revisionHtmlTotal(stay) };
    } catch (error) {
      throw new ProposalPdfUnavailableError('The quote PDF converter is unavailable. Try again shortly, or send the Excel.', { cause: error });
    }
  };
  if (opts.html ?? quoteProposalPdfUsesHtml()) {
    // The HTML renderer draws one revision, so a combined quote cannot use it.
    if (!single) throw new ProposalPdfUnavailableError('This server renders quote PDFs from HTML, which holds one stay only. Send the Excel for a combined quote.');
    rendered = await viaHtml(single);
  } else {
    try {
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
      rendered = { pdf: await convertXlsxWithGotenberg(workbook.bytes, { url: base, fetchImpl }), totalMinor: workbook.totalMinor };
    } catch (error) {
      if (error instanceof WorkbookLineLimitError) throw error;
      if (!single) {
        if (error instanceof WorkbookRefusalError) throw error;
        throw new ProposalPdfUnavailableError('The quote PDF converter is unavailable. Try again shortly, or send the Excel.', { cause: error });
      }
      // One stay can still be quoted: the HTML renderer draws it from the same revision and extras.
      console.warn('quote_pdf_html_fallback', { reason: error instanceof Error ? error.message : String(error) });
      rendered = await viaHtml(single);
    }
  }
  const documentId = documentIdFor(stays);
  return {
    revisionId: documentId,
    pdfHash: createHash('sha256').update(rendered.pdf).digest('hex'),
    pdf: rendered.pdf,
    // ponytail: every PDF carries the document-id suffix, so same-day options never collide and no existing names are looked up.
    fileName: quotePdfFileName(header.agency.trim() || header.company, staySpanLabel(stays), documentId),
    totalMinor: rendered.totalMinor,
  };
}
export async function buildRevisionProposalPdf(revision:QuoteRevision,header:RevisionProposalHeader,opts:{url:string;fetchImpl?:typeof fetch;facts?:AuthorizedProposalFacts;rowPrices?:RowPrice[]}):Promise<{revisionId:string;pdfHash:string;pdf:Uint8Array;fileName:string}>{
  const { revisionId, pdfHash, pdf, fileName } = await buildStaysProposalPdf([{ revision, facts: opts.facts, rowPrices: opts.rowPrices }], header, opts);
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
