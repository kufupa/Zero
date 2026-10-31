import { z } from 'zod';
import { createHash } from 'node:crypto';
import { reservationistCitedView, validReservationistMessageViews, type ReservationistMessageView } from './reservationist-message-view.js';

export type DocumentDisclosure = 'guest' | 'staff_only';
/** Private extracted pages; derived Office pages are explicitly bound to their PDF rendering. */
export type DocumentSource = {
  attachmentId: string;
  sourceHash: string;
  disclosure: DocumentDisclosure;
  pages: readonly string[] | null;
  pageCount: number;
  /** Server-bound original email time for the established staff date convention. */
  causalMessage?: {at:string;direction:'inbound'|'outbound'};
  sourceViews?: readonly ReservationistMessageView[];
  rendering?: {method:'gotenberg_libreoffice';originalSourceHash:string;derivedPdfSHA256:string;pageProvenance:'derived_pdf';textSHA256:string};
};
const identifier = z.string().min(1).max(128);
const sourceSpan = z
  .object({
    attachmentId: identifier,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    page: z.number().int().min(1).max(50),
    quote: z.string().min(1).max(4096).optional(),
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(1).optional(),
    region: z
      .tuple([
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
      ])
      .optional(),
  })
  .strict();
const base = { id: identifier, disclosure: z.enum(['guest', 'staff_only']), source: sourceSpan };
const factSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('room'),
      value: z
        .object({
          roomRef: identifier,
          quantity: z.number().int().min(1).max(96).optional(),
          quotationBasis: z.literal('per_room_rate').optional(),
          adults: z.number().int().min(0).max(20),
          childAges: z.array(z.number().int().min(0).max(17)).max(20),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('dates'),
      value: z
        .object({
          arrival: z.string().min(1).max(64),
          departure: z.string().min(1).max(64),
          yearContext: z.number().int().min(1900).max(2200).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal('board'), value: z.union([z.string().min(1).max(128), z.object({board:z.string().min(1).max(128),roomRef:identifier}).strict()]) }).strict(),
  z.object({ ...base, kind: z.literal('party'), value: z.string().min(1).max(512) }).strict(),
  z.object({
    ...base,
    kind: z.literal('guest'),
    value: z.object({
      firstName: z.string().trim().min(1).max(128),
      lastName: z.string().trim().min(1).max(128),
      roomRef: identifier.optional(),
      roomIndex: z.number().int().min(1).max(96).optional(),
      age: z.number().int().min(0).max(120).optional(),
      profileId: identifier.optional(),
    }).strict(),
  }).strict(),
  z.object({ ...base, kind: z.literal('reservation_reference'), value: identifier }).strict(),
  z.object({ ...base, kind: z.literal('document_reference'), value: identifier }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('rate_claim'),
      value: z
        .object({
          amount: z.string().max(64),
          currency: z.literal('ZAR'),
          basis: z.enum(['nightly', 'adr', 'total', 'ceiling', 'budget', 'unknown']),
          roomRef: identifier.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('payment_claim'),
      value: z
        .object({
          amount: z.string().max(64),
          currency: z.literal('ZAR'),
          status: z.enum(['claimed_paid', 'requested', 'pending']),
        })
        .strict(),
    })
    .strict(),
]);
export const documentPlanSchema = z
  .object({
    facts: z.array(factSchema).max(64),
    tasks: z
      .array(
        z
          .object({
            id: identifier,
            kind: z.enum([
              'quote',
              'new_booking',
              'channel_booking_sync',
              'question',
              'acceptance',
              'change',
              'existing_document',
              'cancel_request',
            ]),
            factIds: z.array(identifier).max(64),
            source: sourceSpan,
          })
          .strict(),
      )
      .max(32),
    unresolvedAsks: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict();
export type DocumentFactCandidate = z.infer<typeof factSchema>;
export type ValidatedDocumentFact = DocumentFactCandidate & {
  verification: 'text_verified' | 'visual_review_required' | 'conflicting_views';
  authority: 'customer_claim';
  amountCents?: number;
  convention?: {rule:'centurion_next_occurrence_v1'|'centurion_explicit_nights_v1'|'centurion_staff_occupancy_v1';sourceAt:string;timeZone:'Africa/Johannesburg';originalValue?:{arrival:string;departure:string}};
};
export type ValidatedDocumentPlan = {
  facts: ValidatedDocumentFact[];
  tasks: z.infer<typeof documentPlanSchema>['tasks'];
  unresolvedAsks: string[];
  draftReady: false;
};
/** Locale explicit: spaces may group thousands; comma OR point is decimal. No floating arithmetic. */
export function normalizeDocumentDecimal(input: string): number {
  const value = input.trim();
  if (!/^(?:\d+|\d{1,3}(?: \d{3})+)(?:[.,]\d{1,2})?$/.test(value))
    throw new Error('Invalid document decimal');
  const [whole, fraction = ''] = value.replaceAll(' ', '').split(/[.,]/);
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Document amount exceeds safe range');
  return Number(cents);
}
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthPattern = months.map(month => `${month}|${month.slice(0, 3)}`).join('|') + '|sept';
function normalizedDate(input: string, yearContext?: number): string {
  const value = input.trim().replace(/\bsept\b/gi, 'sep');
  let year: number, month: number, day: number;
  let parts: RegExpMatchArray | null;
  if ((parts = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    year = Number(parts[1]); month = Number(parts[2]); day = Number(parts[3]);
  } else if ((parts = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) {
    day = Number(parts[1]); month = Number(parts[2]); year = parts[3] ? Number(parts[3]) : yearContext!;
  } else if ((parts = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) {
    day = Number(parts[1]); month = Number(parts[2]); year = Number(parts[3]);
  } else if ((parts = value.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthPattern})\\s+(\\d{4})$`, 'i')))) {
    day = Number(parts[1]); month = months.findIndex(m => m === parts![2]!.toLowerCase() || m.slice(0, 3) === parts![2]!.toLowerCase()) + 1; year = Number(parts[3]);
  } else if ((parts = value.match(new RegExp(`^(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, 'i')))) {
    month = months.findIndex(m => m === parts![1]!.toLowerCase() || m.slice(0, 3) === parts![1]!.toLowerCase()) + 1; day = Number(parts[2]); year = Number(parts[3]);
  } else throw new Error('Document date requires explicit calendar parts');
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || yearContext !== undefined && year !== yearContext)
    throw new Error('Document date year missing or contradictory');
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    throw new Error('Invalid document date');
  return iso;
}
/** The existing next-occurrence convention derives a year, never a printed yearContext. */
function nextOccurrenceStay(fact:Extract<DocumentFactCandidate,{kind:'dates'}>,source:DocumentSource,verification:ValidatedDocumentFact['verification']):{value:{arrival:string;departure:string};convention:NonNullable<ValidatedDocumentFact['convention']>}|undefined{
 const raw=fact.value;
 if(raw.yearContext!==undefined||[raw.arrival,raw.departure].some(value=>/\b\d{4}\b/.test(value)))return;
 const causal=source.causalMessage,originalPage=source.pages?.[fact.source.page-1],quote=fact.source.quote;
 const page=originalPage && reservationistCitedView(originalPage,source.sourceViews,fact.source.start,fact.source.end);
 if(verification!=='text_verified'||!source.attachmentId.startsWith('message:')||causal?.direction!=='inbound'||!Number.isFinite(Date.parse(causal.at))||!page||!quote)throw new Error('Yearless stay requires original causal email');
 const history=page.search(/^(?:\s*>?\s*(?:From:|Sent:|Subject:|On .{1,250}wrote:)|-{2,}\s*(?:Original Message|Forwarded message))/im);
 const authored=page.split(/\n\s*(?:Regards|Kind regards|Warm regards|Thank you|Yours sincerely)\b/i)[0]!;
 const start=fact.source.start!,end=fact.source.end!,before=authored.slice(0,start),after=authored.slice(end),context=before.slice(Math.max(before.lastIndexOf(';'),before.lastIndexOf('.'),before.lastIndexOf('!'),before.lastIndexOf('?'))+1)+quote+( /[;.!?]\s*$/.test(quote)?'':after.split(/[;.!?]/,1)[0]);
 if(end>authored.length)throw new Error('Yearless stay outside authored request');
 if(history>=0&&end>history||/^\s*>/m.test(quote))throw new Error('Ambiguous yearless stay context');
 // A printed night duration is preserved as departure on the wire; only
 // this source-bound quote convention computes its checkout date.
 const duration=raw.departure.match(/^(\d+|one)\s+nights?$/i);
 if(duration){
  const currentAuthored=history<0?authored:authored.slice(0,history);
  // Occupied-night lists retain their literal duration on the model wire.
  // Consecutive nights plus a source-explicit future year alone establish checkout.
  const lists=[...quote.matchAll(new RegExp(`(?<![\\p{L}\\p{N}/-])(\\d{1,2})(?:st|nd|rd|th)?\\s+and\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?![\\p{L}\\p{N}/-])`,'giu'))];
  if(lists.length){
   const causalYear=Number(new Date(Date.parse(causal.at)+2*3600000).toISOString().slice(0,4)),nights=Number(duration[1]),years=[...quote.matchAll(/\b(?:19|20|21|22)\d{2}\b/g)].map(m=>Number(m[0])),nextYear=/\bnext year\b/i.test(quote);
   const year=nextYear?causalYear+1:years.length&&new Set(years).size===1?years[0]!:undefined;
   const otherStayYears=currentAuthored.split(/[\n;.!?]/).filter(row=>/\b(?:stay|accommodation|rooms?|(?:above|these|those|the)\s+dates)\b/i.test(row)).flatMap(row=>[...row.matchAll(/\b(?:19|20|21|22)\d{2}\b/g)].map(m=>Number(m[0])));
   if(end>currentAuthored.length||!/\b(?:please|kindly|request|advise|quote)\b/i.test(currentAuthored)||year===undefined||year>2200||otherStayYears.some(other=>other!==year)||nextYear&&years.some(y=>y!==year)||/\b(?:child|children|minor|infant|kids?|students?|family|last year|previous|cancelled|canceled|withdrawn|disregard|correction|corrected|changed|instead|not|never|checkout|check[ -]?out|depart(?:ure)?)\b/i.test(currentAuthored)||! /\b(?:require|need|request)\s+2 nights per (?:date )?set\b/i.test(quote)||/\b(?:may|might|if|unless|not|never)\s+(?:require|need|request)\s+2 nights\b/i.test(quote)||nights!==2||[...quote.matchAll(/\b2 nights per (?:date )?set\b/gi)].length!==1)throw new Error('Ambiguous occupied-night source');
   const arrival=normalizedDate(`${raw.arrival} ${year}`),selected=lists.filter(list=>normalizedDate(`${list[1]} ${list[3]} ${year}`)===arrival);
   if(selected.length!==1||lists.some(list=>Number(list[2])!==Number(list[1])+1||new Date(Date.parse(normalizedDate(`${list[1]} ${list[3]} ${year}`)+'T00:00:00Z')+86400000).toISOString().slice(0,10)!==normalizedDate(`${list[2]} ${list[3]} ${year}`))||! /\b(?:rooms?|accommodation|overnight)\b/i.test(quote))throw new Error('Occupied nights not consecutive or source bound');
   const departure=new Date(Date.parse(`${arrival}T00:00:00Z`)+nights*86400000).toISOString().slice(0,10);
   return{value:{arrival,departure},convention:{rule:'centurion_explicit_nights_v1',sourceAt:causal.at,timeZone:'Africa/Johannesburg',originalValue:{arrival:raw.arrival,departure:raw.departure}}};
  }
  if(/\b(?:child|children|minor|infant|kids?|students?|family)\b/i.test(currentAuthored))throw new Error('Child or family stay requires source clarification');
  if(/\b(?:next|following|last|previous)\s+year\b/i.test(currentAuthored))throw new Error('Explicit year intent requires source clarification');
  // A narrow citation must not hide an explicit correction to this stay in
  // another paragraph. Other event dates alone do not qualify as corrections.
  const stayCorrections=currentAuthored.split(/[\n;.!?]/).filter(sentence=>
   /\b(?:checkout|check[ -]?out|depart(?:ure)?)\b/i.test(sentence)||
   /\b(?:stay|accommodation|rooms?|bedrooms?|overnight|(?:above|these|those|the)\s+(?:accommodation\s+|stay\s+)?dates)\b/i.test(sentence)&&
   /\b\d{4}\b|\b(?:ends?|until|correction|corrected|changed|instead|not|never|cancelled|canceled|withdrawn|disregard|ignore)\b/i.test(sentence));
  if(stayCorrections.length)throw new Error('Explicit same-stay correction requires source clarification');
  const lineStart=page.lastIndexOf('\n',start-1)+1,nextLine=page.indexOf('\n',end),line=page.slice(lineStart,nextLine<0?page.length:nextLine),paragraphStart=page.lastIndexOf('\n\n',start-1),paragraphEnd=page.indexOf('\n\n',end),paragraph=page.slice(paragraphStart<0?0:paragraphStart+2,paragraphEnd<0?authored.length:paragraphEnd),nights=/^one$/i.test(duration[1]!)?1:Number(duration[1]);
  const printedNights=[...quote.matchAll(/\b(\d+|one)\s+nights?\b/gi)],dayPattern=new RegExp(`(?<![\\p{L}\\p{N}/-])(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthPattern})(?![\\p{L}\\p{N}/-])`,'giu'),printedDays=[...quote.matchAll(dayPattern)];
  if(!Number.isSafeInteger(nights)||nights<1||nights>366||printedNights.length!==1||printedNights[0]![0]!==raw.departure||printedDays.length!==1||[...line.matchAll(dayPattern)].length!==1||! /\b(?:rooms?|bedrooms?|accommodation|overnight\s+stay)\b/i.test(quote)||/\b(?:child|children|minor|infant|kids?|students?|family|not|never|no|without|previous|old|cancelled|canceled|unless|if|or|either|checkout|check[ -]?out|depart(?:ure)?)\b|\b\d{4}\b/i.test(line)||[...line.matchAll(/\b(\d+|one)\s+nights?\b/gi)].length!==1)throw new Error('Ambiguous explicit night stay');
  const localDay=new Date(Date.parse(causal.at)+2*3600000).toISOString().slice(0,10),year=Number(localDay.slice(0,4)),token=`${printedDays[0]![1]} ${printedDays[0]![2]}`;
  if(normalizedDate(`${token} ${year}`)!==normalizedDate(`${raw.arrival} ${year}`))throw new Error('Document dates not entailed by source span');
  let arrival=normalizedDate(`${raw.arrival} ${year}`);if(arrival<localDay)arrival=normalizedDate(`${raw.arrival} ${year+1}`);
  const departure=new Date(Date.parse(`${arrival}T00:00:00Z`)+nights*86400000).toISOString().slice(0,10);
  if(Number(departure.slice(0,4))>2200||[...paragraph.matchAll(dayPattern)].length!==1||[...paragraph.matchAll(/\b(\d+|one)\s+nights?\b/gi)].length!==1||/\b(?:child|children|minor|infant|kids?|students?|family|checkout|check[ -]?out|depart(?:ure)?|not|never|no|without|previous|old|cancelled|canceled|unless|if|or|either)\b|\b\d{4}\b/i.test(paragraph))throw new Error('Ambiguous explicit night stay');
  return{value:{arrival,departure},convention:{rule:'centurion_explicit_nights_v1',sourceAt:causal.at,timeZone:'Africa/Johannesburg',originalValue:{arrival:raw.arrival,departure:raw.departure}}};
 }
 // An indirect availability question does not make the stated stay conditional.
 // Strip only the inquiry connector; any other condition/alternative still fails.
 const stayContext=context.replace(/\b(?:advise|confirm|check|know|find out|enquire|inquire|wondering|ask)\s+(?:me\s+)?(?:if|whether)\s+(?:you\s+(?:have|offer)\s+availability|(?:rooms?|accommodation)\s+(?:is|are)\s+available)\b/gi,'availability inquiry');
 if(/\b(?:not|never|no|without|previous|old|cancelled|canceled|unless|if|or|either)\b|\b\d{4}\b/i.test(stayContext))throw new Error('Ambiguous yearless stay context');
 const named=`(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthPattern})|(?:${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}/\\d{1,2})`;
 const shared=[...quote.matchAll(new RegExp(`(?<![\\p{L}\\p{N}/-])(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?![\\p{L}\\p{N}/-])`,'giu'))];
 const labeledShared=[...quote.matchAll(new RegExp(`\\b(?:arrival|check[ -]?in|checking\\s+in)\\s*(?:is|on|:)?\\s*(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:and|to)\\s+(?:depart(?:ure)?|check[ -]?out|checking\\s+out)\\s*(?:is|on|:)?\\s*(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})(?![\\p{L}\\p{N}/-])`,'giu'))];
 let tokens:string[];
 if(labeledShared.length===1&&shared.length===0&&[...context.matchAll(new RegExp(named,'giu'))].length<=1)tokens=[`${labeledShared[0]![1]} ${labeledShared[0]![3]}`,`${labeledShared[0]![2]} ${labeledShared[0]![3]}`];
 else if(shared.length===1&&[...context.matchAll(new RegExp(named,'giu'))].length===1)tokens=[`${shared[0]![1]} ${shared[0]![3]}`,`${shared[0]![2]} ${shared[0]![3]}`];
 else{
  const printed=[...quote.matchAll(new RegExp(`(?<![\\p{L}\\p{N}/-])${named}(?![\\p{L}\\p{N}/-])`,'giu'))];
  if(printed.length!==2||[...context.matchAll(new RegExp(named,'giu'))].length!==2)throw new Error('Ambiguous yearless stay dates');
  const lead=quote.slice(0,printed[0]!.index),between=quote.slice(printed[0]!.index!+printed[0]![0].length,printed[1]!.index);
  if(!(/\b(?:arrival|check[ -]?in)\b/i.test(lead)&&/\b(?:depart(?:ure)?|check[ -]?out)\b/i.test(between))&&!/\bto\b|[-–]/.test(between))throw new Error('Yearless stay requires paired dates');
  tokens=printed.map(match=>match[0]);
 }
 const localDay=new Date(Date.parse(causal.at)+2*3600000).toISOString().slice(0,10),year=Number(localDay.slice(0,4));
 const date=(token:string,y:number)=>/^\d{1,2}\/\d{1,2}$/.test(token.trim())?normalizedDate(token,y):normalizedDate(`${token} ${y}`);
 if(date(tokens[0]!,year)!==date(raw.arrival,year)||date(tokens[1]!,year)!==date(raw.departure,year))throw new Error('Document dates not entailed by source span');
 let arrival=date(raw.arrival,year);if(arrival<localDay)arrival=date(raw.arrival,year+1);
 let departure=date(raw.departure,Number(arrival.slice(0,4)));if(departure<arrival)departure=date(raw.departure,Number(arrival.slice(0,4))+1);
 if(arrival>=departure)throw new Error('Invalid stay dates');
 return{value:{arrival,departure},convention:{rule:'centurion_next_occurrence_v1',sourceAt:causal.at,timeZone:'Africa/Johannesburg',originalValue:{arrival:raw.arrival,departure:raw.departure}}};
}
function normalizedStay(fact: Extract<DocumentFactCandidate, { kind: 'dates' }>, verification: ValidatedDocumentFact['verification'],originalPage?:string) {
  const { yearContext } = fact.value;
  const quote = fact.source.quote;
  if (yearContext !== undefined && (verification !== 'text_verified' || !new RegExp(`(?<![\\p{L}\\p{N}_-])${yearContext}(?![\\p{L}\\p{N}_-])`, 'u').test(quote!)))
    throw new Error('Document yearContext not verified in same span');
  if (yearContext !== undefined && [fact.value.arrival, fact.value.departure].some(date => /^\d{1,2}\/\d{1,2}$/.test(date.trim()))) {
    const years = [...quote!.matchAll(/(?<![\p{L}\p{N}_-])(?:19|20|21|22)\d{2}(?![\p{L}\p{N}_-])/gu)].map(match => Number(match[0]));
    if (years.some(year => year !== yearContext)) throw new Error('Document yearContext ambiguous in same span');
  }
  const arrival = normalizedDate(fact.value.arrival, yearContext);
  const departure = normalizedDate(fact.value.departure, yearContext);
  if (verification === 'text_verified') {
    const start=fact.source.start!,end=fact.source.end!,page=originalPage??quote!;
    const before=page.slice(0,start),after=page.slice(end);
    const boundary=Math.max(before.lastIndexOf('\n'),before.lastIndexOf(';'),before.lastIndexOf('.'),before.lastIndexOf('!'),before.lastIndexOf('?'));
    let context=before.slice(boundary+1)+quote!+after.split(/[\n;.!?]/,1)[0];
    // Both month labels and the final year must be printed in this exact source span.
    const repeatedMonthPattern=new RegExp(`(?<![\\p{L}\\p{N}/-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\s+(?:to|[-–])\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})\\s+(\\d{4})(?![\\p{L}\\p{N}/-])`,'giu');
    const printedRanges=[...quote!.matchAll(repeatedMonthPattern)];
    if(printedRanges.length){
      const sentenceBoundary=Math.max(before.lastIndexOf(';'),before.lastIndexOf('.'),before.lastIndexOf('!'),before.lastIndexOf('?'));
      context=before.slice(sentenceBoundary+1)+quote!+after.split(/[;.!?]/,1)[0];
      const ranges=[...context.matchAll(repeatedMonthPattern)];
      if(printedRanges.length!==1||ranges.length!==1)throw new Error('Ambiguous printed month stay dates');
      if(/\b(?:not|never|no|do not|don[’']t|without|cancelled|canceled|previous|old|another|other|different|excluding|excluded|if|unless|pending)\b/i.test(context))throw new Error('Excluded printed month stay dates');
      const range=ranges[0]!;
      if(range[3]&&range[3]!==range[6])throw new Error('Contradictory printed stay years');
      const rangeArrival=normalizedDate(`${range[1]} ${range[2]} ${range[6]}`),rangeDeparture=normalizedDate(`${range[4]} ${range[5]} ${range[6]}`);
      if(rangeArrival>=rangeDeparture)throw new Error('Invalid printed month stay dates');
      if(arrival!==rangeArrival||departure!==rangeDeparture)throw new Error('Document dates not entailed by source span');
    }
    const tokenPattern = new RegExp(`(?<![\\p{L}\\p{N}/-])(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-\\d{1,2}-\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthPattern})\\s+\\d{4}|(?:${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}/\\d{1,2}(?:/\\d{4})?)(?![\\p{L}\\p{N}/-])`, 'giu');
    let previousEnd = 0;
    const dates = [...context.matchAll(tokenPattern)].flatMap(match => {
      const preceding = context.slice(previousEnd, match.index);
      previousEnd = match.index! + match[0].length;
      const labels = [...preceding.matchAll(/\b(arrival|depart(?:ure)?|check[ -]?in|check[ -]?out)\b/gi)];
      const label = labels.at(-1)?.[1]?.toLowerCase();
      const role = label ? /arrival|check[ -]?in/.test(label) ? 'arrival' : 'departure' : undefined;
      try { return [{ value: normalizedDate(match[0], yearContext), role }]; } catch { return []; }
    });
    if(printedRanges.length){
      const range=printedRanges[0]!;
      dates.push({value:normalizedDate(`${range[1]} ${range[2]} ${range[6]}`),role:'arrival'},{value:normalizedDate(`${range[4]} ${range[5]} ${range[6]}`),role:'departure'});
    }
    // Compact labeled dates share only the year explicitly printed in their own paired source span.
    const compactPattern=new RegExp(`\\b(?:in|arrival|check[ -]?in)\\s*:?\\s*(\\d{1,2})\\s*(${monthPattern})\\s+(?:out|depart(?:ure)?|check[ -]?out)\\s*:?\\s*(\\d{1,2})\\s*(${monthPattern})\\s+(\\d{4})(?![\\p{L}\\p{N}/-])`,'giu');
    const compact=[...quote!.matchAll(compactPattern)];
    if(compact.length){
      const sentenceBoundary=Math.max(before.lastIndexOf(';'),before.lastIndexOf('.'),before.lastIndexOf('!'),before.lastIndexOf('?'));context=before.slice(sentenceBoundary+1)+quote!+after.split(/[;.!?]/,1)[0];
      if(compact.length!==1||[...context.matchAll(compactPattern)].length!==1||/\b(?:not|never|no|without|previous|old|cancelled|canceled|unless|if)\b/i.test(context))throw new Error('Ambiguous compact labeled stay dates');
      const pair=compact[0]!,a=normalizedDate(`${pair[1]} ${pair[2]} ${pair[5]}`),d=normalizedDate(`${pair[3]} ${pair[4]} ${pair[5]}`);
      if(a>=d||a!==arrival||d!==departure)throw new Error('Document dates not entailed by source span');
      dates.push({value:a,role:'arrival'},{value:d,role:'departure'});
    }
    // A single explicit range shares its printed month/year; neither comes from the clock.
    const sharedRanges=[...context.matchAll(new RegExp(`(?<![\\p{L}\\p{N}/-])(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:[-–]|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})\\s+(\\d{4})(?![\\p{L}\\p{N}/-])`,'giu'))];
    if(sharedRanges.length>1)throw new Error('Ambiguous shared month stay dates');
    if(sharedRanges.length===1){const range=sharedRanges[0]!;
      if(/\b(?:not|never|no|do not|don[’']t|without|cancelled|canceled|previous|old)\b[^.!?;\n]{0,100}$/i.test(context.slice(0,range.index)))throw new Error('Excluded shared month stay dates');
      const start=normalizedDate(`${range[1]} ${range[3]} ${range[4]}`),end=normalizedDate(`${range[2]} ${range[3]} ${range[4]}`);
      if(start>=end)throw new Error('Invalid shared month stay dates');
      const subgroupPattern=new RegExp(`\\b\\d+\\s+(?:guests?|people|persons?|adults?|officials?)\\s+arriving\\s+on\\s+(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthPattern})\\s+\\d{4})(?![\\p{L}\\p{N}/-])`,'giu');
      const subgroup=[...quote!.matchAll(subgroupPattern)];
      if(subgroup.length){
        const observed=normalizedDate(subgroup[0]![1]!);
        if(subgroup.length!==1||observed<start||observed>=end||arrival!==observed||departure!==end||/\b(?:not|never|no|without|cancel|previous|if|unless)\b/i.test(context))throw new Error('Ambiguous subgroup stay dates');
        dates.push({value:observed,role:'arrival'},{value:end,role:'departure'});
      }else dates.push({value:start,role:'arrival'},{value:end,role:'departure'});
    }
    for (const [role, value] of [['arrival', arrival], ['departure', departure]] as const) {
      const labeledDates = dates.filter(date => date.role === role);
      if(new Set(labeledDates.map(date=>date.value)).size>1)throw new Error('Contradictory original date roles');
      if (!(labeledDates.length ? labeledDates : dates.filter(date => !date.role)).some(date => date.value === value))
        throw new Error('Document dates not entailed by source span');
    }
  }
  if (departure <= arrival) throw new Error('Invalid stay dates');
  return { ...fact.value, arrival, departure };
}
/** Compare unambiguous date ranges when two alternatives disagree about the same stay. */
function assertMessageViewDates(fact:Extract<DocumentFactCandidate,{kind:'dates'}>,source:DocumentSource,value:{arrival:string;departure:string}):void{
 const page=source.pages?.[fact.source.page-1],views=source.sourceViews,start=fact.source.start,end=fact.source.end;
 const selected=views?.find(v=>start!==undefined&&end!==undefined&&start>=v.start&&end<=v.end);
 if(!page||!views)return;
 if(!selected){
  if(start!==undefined&&end!==undefined&&views.some(view=>start<view.end&&end>view.start))throw new Error('Ambiguous alternate stay dates');
  return;
 }
 const token=`(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-\\d{1,2}-\\d{4}|\\d{1,2}/\\d{1,2}(?:/\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthPattern})(?:\\s+\\d{4})?|(?:${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)`;
 const authoredText=(text:string)=>text.split(/\n\s*(?:Regards|Kind regards|Warm regards|Thank you|Yours sincerely)\b/i)[0]!;
 const ranges=(text:string)=>{
  const authored=authoredText(text);
  const paired:Array<{index:number;text:string;arrival:string;departure:string;nights?:number}>=[...authored.matchAll(new RegExp(`(?<![\\p{L}\\p{N}/-])(${token})\\s*(?:to|until|[-–])\\s*(${token})(?![\\p{L}\\p{N}/-])`,'giu'))]
   .map(m=>({index:m.index!,text:m[0],arrival:m[1]!,departure:m[2]!}));
  for(const m of authored.matchAll(new RegExp(`(?<![\\p{L}\\p{N}/-])(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|[-–])\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+(\\d{4}))?(?![\\p{L}\\p{N}/-])`,'giu')))
   paired.push({index:m.index!,text:m[0],arrival:`${m[1]} ${m[3]} ${m[4]??''}`.trim(),departure:`${m[2]} ${m[3]} ${m[4]??''}`.trim()});
  for(const m of authored.matchAll(new RegExp(`\\b(?:arriv(?:al|ing|e)|check[ -]?in|in)\\s*(?:date\\s*)?(?:is|on|:)?\\s*(?:the\\s+)?(${token})\\s*(?:[,;]|and|to)?\\s*(?:depart(?:ure|ing)?|check[ -]?out|out)\\s*(?:date\\s*)?(?:is|on|:)?\\s*(?:the\\s+)?(${token})(?![\\p{L}\\p{N}/-])`,'giu')))
   paired.push({index:m.index!,text:m[0],arrival:m[1]!,departure:m[2]!});
  for(const m of authored.matchAll(new RegExp(`\\b(\\d{1,3}|one)\\s+nights?\\s+(?:from|starting)\\s+(${token})(?![\\p{L}\\p{N}/-])`,'giu')))
   paired.push({index:m.index!,text:m[0],arrival:m[2]!,departure:m[2]!,nights:/^one$/i.test(m[1]!)?1:Number(m[1])});
  for(const m of authored.matchAll(new RegExp(`\\bfrom\\s+(${token})\\s+(?:for\\s+)?(\\d{1,3}|one)\\s+nights?\\b`,'giu')))
   paired.push({index:m.index!,text:m[0],arrival:m[1]!,departure:m[1]!,nights:/^one$/i.test(m[2]!)?1:Number(m[2])});
  return paired.filter(match=>{
   const start=Math.max(authored.lastIndexOf('\n',match.index-1),authored.lastIndexOf('.',match.index-1),authored.lastIndexOf(';',match.index-1))+1;
   const tail=authored.slice(match.index+match.text.length).search(/[\n.;]/),end=tail<0?authored.length:match.index+match.text.length+tail;
   const stay=/\b(?:stay|accommodation|rooms?|overnight|reservation|booking|arriv(?:al|ing|e)|depart(?:ure|ing)?|check[ -]?(?:in|out))\b/i;
   // A negated change/cancellation preserves the cited dates; it does not exclude them.
   const excluded=/\b(?:(?:do not|don['’]t|never|not|without)(?!\s+(?:change|changing|alter|altering|modify|modifying|move|moving|reschedule|rescheduling|cancel|canceling|cancelling)\b)|previous|old|cancelled|canceled)\b[^.!?;\n]{0,80}\b(?:stay|accommodation|rooms?|overnight|reservation|booking|arriv(?:al|e)|depart(?:ure)?|check[ -]?(?:in|out))\b|\bno\s+(?:(?:more|new|other|the|a)\s+)?(?:stay|accommodation|rooms?|reservation|booking|arriv(?:al|e)|depart(?:ure)?|check[ -]?(?:in|out))\b/i;
   const row=authored.slice(start,end);
   const suffix=authored.slice(match.index+match.text.length,end);
   const trailingExclusion=/^\s*(?:(?:[:,–-]\s*)?no\s+(?:stay|accommodation|rooms?|reservation|booking)\s+(?:(?:is|are)\s+)?(?:needed|required|wanted|booked)|(?:(?:was|were|is|are|has been|have been)\s+)?cancel(?:led|ed))\b/i;
   const leadingLabel=/^(?:arrival|check[ -]?in)\b/i.exec(match.text)?.[0]??'';
   const before=authored.slice(start,match.index);
   const directQuote=/\b(?:quote|quotation)(?:\s+(?:us|me))?(?:\s+(?:for|from|on))?\s*:?\s*$/i;
   const negatedQuote=/\b(?:do not|don['’]t|never|not)\s+(?:quote|request\s+a\s+quotation)\b/i;
   // A second range explicitly labelled as an event is not another room stay.
   if(/\b(?:conference|meeting|event|workshop|flight)\s*$/i.test(before)&&paired.some(other=>other.index>=start&&other.index<match.index))return false;
   if(!stay.test(row)&&/^\s*(?:for|during|at)\s+(?:(?:the|a|an)\s+)?(?:conference|meeting|event|workshop|flight)\b/i.test(suffix))return false;
   if(stay.test(row)||directQuote.test(before))return !excluded.test(before+leadingLabel)&&!negatedQuote.test(before)&&!trailingExclusion.test(suffix);
   const lineStart=authored.lastIndexOf('\n',match.index-1)+1;
   const previousStart=authored.lastIndexOf('\n',lineStart-2)+1;
   const previous=authored.slice(previousStart,lineStart-1).trim();
   // A wrapped range can follow a stay label, but not an unrelated new label on the date line.
   return lineStart>0&&/^\s*(?:[-•]\s*)?(?:dates?\s*:\s*)?$/i.test(authored.slice(lineStart,match.index))&&/:\s*$/.test(previous)&&(stay.test(previous)||directQuote.test(previous))&&!excluded.test(previous)&&!negatedQuote.test(previous);
  }).map(match=>{
   const start=Math.max(authored.lastIndexOf('\n',match.index-1),authored.lastIndexOf('.',match.index-1),authored.lastIndexOf(';',match.index-1))+1;
   const tail=authored.slice(match.index+match.text.length).search(/[\n.;]/),end=tail<0?authored.length:match.index+match.text.length+tail;
   const lineStart=authored.lastIndexOf('\n',match.index-1)+1,previousStart=authored.lastIndexOf('\n',lineStart-2)+1;
   const previous=authored.slice(previousStart,lineStart-1).trim();
   // Scope year labels to this range; another stay in the same sentence is not its year context.
   const priorEnd=paired.filter(other=>other!==match&&other.index+other.text.length<=match.index).reduce((last,other)=>Math.max(last,other.index+other.text.length),start);
   const suffix=authored.slice(match.index+match.text.length,end).match(new RegExp(`^\\s*[,–-]?\\s*(?:for|during|in|year|dates?)\\s*[:(]?\\s*(?:(?:${monthPattern})\\s+)?(?:19|20|21|22)\\d{2}\\b`,'i'))?.[0]??'';
   const local=authored.slice(Math.max(start,priorEnd),match.index);
   // A sentence-wide "For 2027:" heading also applies to its later stays,
   // unless that stay has an explicit year of its own.
   const heading=priorEnd>start&&!/\b(?:19|20|21|22)\d{2}\b/.test(local+match.text+suffix)
    ? authored.slice(start,priorEnd).match(/^\s*(?:for|in)\s+(?:19|20|21|22)\d{2}\s*:/i)?.[0]??'' : '';
   return {...match,context:(/^\s*(?:(?:for\s+)?(?:19|20|21|22)\d{2}\s*:|(?:stay\s+)?dates?\s*:\s*(?:19|20|21|22)\d{2})\s*$/i.test(previous)?`${previous} `:'')+heading+local+match.text+suffix};
  });
 };
 const date=(text:string,year:number)=>/\b\d{4}\b/.test(text)?normalizedDate(text):text.includes('/')?normalizedDate(text,year):normalizedDate(`${text} ${year}`);
 const pair=(m:{arrival:string;departure:string;context:string;nights?:number},verifiedYear?:number)=>{
  // A booking reference or amount in the same sentence is not a stay year.
  const printedYears=[...`${m.arrival} ${m.departure}`.matchAll(/\b(?:19|20|21|22)\d{2}\b/g)].map(year=>Number(year[0]));
  const labeledYears=[...m.context.matchAll(new RegExp(`\\b(?:for|during|in|year|dates?|(?:stay|reservation|booking)\\s+dates?)(?:\\s+(?:for|in|during))?\\s*[:(]?\\s*(?:(?:${monthPattern})\\s+)?((?:19|20|21|22)\\d{2})\\b`,'gi'))].map(year=>Number(year[1]));
  const years=[...new Set([...printedYears,...labeledYears])];
  const explicit=(text:string)=>/\b(?:19|20|21|22)\d{2}\b/.test(text);
  if(years.length>1&&(!explicit(m.arrival)||!explicit(m.departure)))throw new Error('Ambiguous alternate stay year');
  const causal=source.causalMessage?.at,localDay=causal&&Number.isFinite(Date.parse(causal))?new Date(Date.parse(causal)+2*3600000).toISOString().slice(0,10):undefined;
  let year=years[0]??verifiedYear??Number(localDay?.slice(0,4)??value.arrival.slice(0,4)),arrival=date(m.arrival,year);
  if(!years.length&&verifiedYear===undefined&&localDay&&arrival<localDay){year++;arrival=date(m.arrival,year);}
  if(m.nights!==undefined){if(m.nights<1||m.nights>366)throw new Error('Invalid alternate stay duration');return [arrival,new Date(Date.parse(`${arrival}T00:00:00Z`)+m.nights*86400000).toISOString().slice(0,10)];}
  let departure=date(m.departure,year);
  if(departure<=arrival&&!explicit(m.departure)&&years.length<=1)departure=date(m.departure,year+1);
  if(departure<=arrival)throw new Error('Invalid alternate stay dates');
  return [arrival,departure];
 };
 const corrects=(text:string,targets:string[])=>{
  const authored=authoredText(text),found=ranges(authored).sort((a,b)=>b.index-a.index);
  for(const marker of authored.matchAll(/\b(?:correction|corrected|changed|amended|revised|instead)\b/gi)){
   const at=marker.index!,start=Math.max(authored.lastIndexOf('\n',at-1),authored.lastIndexOf('.',at-1),authored.lastIndexOf(';',at-1))+1;
   const tail=authored.slice(at).search(/[\n.;!?]/),end=tail<0?authored.length:at+tail,clause=authored.slice(start,end);
   if(!/\b(?:stay|accommodation|rooms?|reservation|booking|arriv(?:al|ing|e)|depart(?:ure|ing)?|check[ -]?(?:in|out))\b/i.test(clause)||!new RegExp(token,'iu').test(clause))continue;
   // A sender saying a stay has not changed is confirming, not replacing it.
   if(/\b(?:not|never|hasn['’]t|haven['’]t|hadn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\s+(?:been\s+)?$/i.test(authored.slice(start,at)))continue;
   // "New dates instead" places the replacement before the marker; the
   // superseded range is the one before this correction clause.
   const instead=marker[0]!.toLowerCase()==='instead';
   const replacementBefore=instead&&found.some(range=>range.index>=start&&range.index<at);
   const insteadOf=instead&&/^\s+of\b/i.test(authored.slice(at+marker[0]!.length));
   const explicitPrior=insteadOf?found.filter(range=>range.index>at&&range.index<end).sort((a,b)=>a.index-b.index)[0]:undefined;
   const earlier=found.filter(range=>range.index<(replacementBefore?start:at));
   // When the correction names a stay's month, don't attach it to an
   // unrelated nearer stay in another month.
   const labelMatch=clause.match(new RegExp(`\\b(${monthPattern})\\s+(?:stay|accommodation|rooms?|reservation|booking)\\b`,'i'));
   // "Move this booking to a December stay" names the replacement, not
   // the month of the stay being changed.
   const replacementMonth=labelMatch&&/\b(?:move|moved|moving|reschedule|rescheduled|rescheduling|change|changed|changing|shift|shifted|shifting|switch|switched|switching)\b[^.!?;\n]{0,80}\b(?:to|into)\s+(?:(?:a|an|the)\s+)?$/i.test(clause.slice(0,labelMatch.index));
   const label=replacementMonth?undefined:labelMatch?.[1]?.toLowerCase();
   const month=label?months.findIndex(value=>value.startsWith(label.slice(0,3)))+1:0;
   try{
    const prior=explicitPrior??(month?earlier.find(range=>pair(range).some(date=>Number(date.slice(5,7))===month)):earlier[0]);
    if(prior&&targets.includes(pair(prior).join('/')))return true;
   }catch{throw new Error('Ambiguous alternate stay dates');}
  }
  return false;
 };
 const ownText=page.slice(selected.start,selected.end),own=ranges(ownText);
 if(!own.length){
  // Do not accept an unparsed occupied-night list when the other view has a
  // stay range that we cannot compare to it.
  if(views.some(other=>other!==selected&&ranges(page.slice(other.start,other.end)).length))throw new Error('Ambiguous alternate stay dates');
  return;
 }
 const uniquePairs=(pairs:string[][])=>[...new Map(pairs.map(pair=>[pair.join('/'),pair])).values()];
 const keys=(pairs:string[][])=>pairs.map(pair=>pair.join('/')).sort().join('|');
 let ownPairs:string[][];try{ownPairs=uniquePairs(own.map(m=>pair(m,m.index>=start!-selected.start&&m.index+m.text.length<=end!-selected.start?fact.value.yearContext:undefined)));}catch{throw new Error('Ambiguous alternate stay dates');}
 const target=[value.arrival,value.departure].join('/');
 if(!ownPairs.some(pair=>pair.join('/')===target)){
  // A subgroup arriving later does not establish that the overall block starts later.
  const group=(text:string)=>{
   const matches=[...authoredText(text).matchAll(new RegExp(`\\b(\\d+)\\s+(?:guests?|people|persons?|adults?|officials?)\\s+arriving\\s+on\\s+(${token})`,'giu'))];
   if(matches.length!==1||!/\b(?:19|20|21|22)\d{2}\b/.test(matches[0]![2]!))return;
   try{return{count:matches[0]![1]!,arrival:date(matches[0]![2]!,Number(value.arrival.slice(0,4)))};}catch{return;}
  };
  const stated=group(ownText);
  const overall=stated&&ownPairs.find(pair=>pair[0]!<=stated.arrival&&pair[1]===value.departure);
  if(stated&&overall&&stated.arrival===value.arrival&&!corrects(ownText,[overall.join('/')])&&views.filter(v=>v!==selected).every(other=>{
   const otherText=page.slice(other.start,other.end),otherGroup=group(otherText);
   if(!otherGroup||otherGroup.count!==stated.count||otherGroup.arrival!==stated.arrival||corrects(otherText,[overall.join('/')]))return false;
   try{return keys(uniquePairs(ranges(otherText).map(m=>pair(m))))===keys(ownPairs);}catch{return false;}
  }))return;
  if(/\b\d+\s+(?:guests?|people|persons?|adults?|officials?)\s+arriving\s+on\b/i.test(authoredText(ownText)))throw new Error('Ambiguous alternate stay dates');
  return;
 }
 if(corrects(ownText,[target]))throw new Error('Conflicting alternate stay dates');
 for(const other of views.filter(v=>v!==selected)){const otherText=page.slice(other.start,other.end),found=ranges(otherText);if(!found.length){
   const otherAuthored=authoredText(otherText);
   if(new RegExp(`\\b\\d{1,2}\\s+and\\s+\\d{1,2}\\s+(?:${monthPattern})\\b`,'i').test(otherAuthored)&&/\bnights?\b/i.test(otherAuthored))throw new Error('Ambiguous alternate stay dates');
   continue;
  }
  let otherPairs:string[][];try{otherPairs=uniquePairs(found.map(m=>pair(m)));}catch{throw new Error('Ambiguous alternate stay dates');}
  if(corrects(otherText,[target]))throw new Error('Conflicting alternate stay dates');
  if(otherPairs.some(pair=>pair.join('/')===target))continue;
  throw new Error('Conflicting alternate stay dates');
 }
}
/** Channel notices become actions only when the original row explicitly requests a system update. */
export function assertChannelBookingSyncRequest(quote: string, original: string, start: number, end: number): void {
 if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || original.slice(start, end) !== quote || !/\b(?:update|sync|synchroni[sz]e)\s+(?:(?:your|the|our)\s+)?system\b/i.test(quote)) throw new Error('Channel sync requires explicit original request');
 const before=original.slice(0,start),after=original.slice(end);
 const row=before.slice(Math.max(before.lastIndexOf('.'),before.lastIndexOf(';'),before.lastIndexOf('!'),before.lastIndexOf('?'))+1)+quote+after.split(/[.;!?]/,1)[0];
 if (/\b(?:not|never|no|without|do not|don['’]t|cannot|can['’]t|mustn['’]t)\b[^.;!?]{0,80}\b(?:update|sync|synchroni[sz]e)\b/i.test(row)) throw new Error('Negated channel sync request');
}
/** Schema-valid model output is candidate evidence, never instructions, HMS price or cleared funds. */
export function validateDocumentPlan(
  candidate: unknown,
  sources: readonly DocumentSource[],
  options?: { retainAlternateDateConflicts?: boolean },
): ValidatedDocumentPlan {
  const parsed = documentPlanSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('Invalid bounded document plan'); // Do not log customer values through Zod diagnostics.
  const subjectSources=sources.filter(source=>source.attachmentId.startsWith('message-subject:'));
  if (subjectSources.length > 1 || subjectSources.some(source=>source.pageCount!==1||!source.pages||source.pages.length!==1||source.pages[0].length>4096)||sources.length-subjectSources.length>72) throw new Error('Too many document or causal message sources');
  const bySource = new Map<string, DocumentSource>();
  for (const source of sources) {
    if (
      bySource.has(source.attachmentId) ||
      !Number.isInteger(source.pageCount) ||
      source.pageCount < 1 ||
      source.pageCount > 50 ||
      !/^([a-f0-9]{64})$/.test(source.sourceHash) ||
      !['guest', 'staff_only'].includes(source.disclosure)
    )
      throw new Error('Invalid document source');
    if (
      source.pages &&
      (source.pages.length !== source.pageCount ||
        Buffer.byteLength(source.pages.join(''), 'utf8') > 256 * 1024)
    )
      throw new Error('Invalid bounded original pages');
    if (source.rendering && (
      source.rendering.method !== 'gotenberg_libreoffice' ||
      source.rendering.pageProvenance !== 'derived_pdf' ||
      source.rendering.originalSourceHash !== source.sourceHash ||
      !/^[a-f0-9]{64}$/.test(source.rendering.derivedPdfSHA256) ||
      source.rendering.textSHA256 !== createHash('sha256').update(JSON.stringify(source.pages)).digest('hex')
    )) throw new Error('Invalid derived document rendering');
    if (source.sourceViews && (!source.attachmentId.startsWith('message:') || !source.pages || source.pageCount !== 1 ||
        !validReservationistMessageViews(source.pages[0]!, source.sourceViews))) throw new Error('Invalid document source views');
    bySource.set(source.attachmentId, source);
  }
  const ids = new Set<string>();
  const facts = parsed.data.facts.map((fact): ValidatedDocumentFact => {
    if (ids.has(fact.id)) throw new Error('Duplicate fact identifier');
    ids.add(fact.id);
    const original = bySource.get(fact.source.attachmentId);
    if (
      !original ||
      original.sourceHash !== fact.source.sourceHash ||
      fact.source.page > original.pageCount
    )
      throw new Error('Unbound document source');
    let verification: ValidatedDocumentFact['verification'];
    if (original.pages) {
      const { quote, start, end } = fact.source;
      if (
        quote === undefined ||
        start === undefined ||
        end === undefined ||
        end <= start ||
        original.pages[fact.source.page - 1]?.slice(start, end) !== quote
      )
        throw new Error('Unverified original text span');
      verification = 'text_verified';
    } else {
      const r = fact.source.region;
      if (
        !r ||
        r[2] <= r[0] ||
        r[3] <= r[1] ||
        fact.source.quote !== undefined ||
        fact.source.start !== undefined ||
        fact.source.end !== undefined
      )
        throw new Error('Scan requires visual region and uncertainty');
      verification = 'visual_review_required';
    }
    const derived = fact.kind==='dates'?nextOccurrenceStay(fact,original,verification):undefined;
    if(derived){const tasks=parsed.data.tasks.filter(task=>task.factIds.includes(fact.id));if(!tasks.some(task=>task.kind==='quote')||tasks.some(task=>task.kind!=='quote'&&(derived.convention.rule==='centurion_explicit_nights_v1'||!(task.kind==='question'&&/\b(?:room|breakfast)\s+options?\b/i.test(task.source.quote??'')&&!/\b(?:tax(?:es)?|VAT|levy|cancel(?:lation)?|payment|deposit|transfer|shuttle)\b/i.test(task.source.quote??'')))))throw new Error('Yearless convention requires quote task');}
    const page=original.pages?.[fact.source.page-1];
    const normalizedFact = fact.kind === 'dates' ? { ...fact, value: derived?.value??normalizedStay(fact, verification,page&&reservationistCitedView(page,original.sourceViews,fact.source.start,fact.source.end)),...(derived?{convention:derived.convention}:{}) } : fact;
    if(fact.kind==='dates'&&normalizedFact.kind==='dates'&&verification==='text_verified'){
      try{assertMessageViewDates(fact,original,normalizedFact.value);}
      catch(error){
        if(!options?.retainAlternateDateConflicts||!(error instanceof Error)||!['Ambiguous alternate stay dates','Conflicting alternate stay dates'].includes(error.message))throw error;
        verification='conflicting_views';
      }
    }
    const amountCents =
      fact.kind === 'rate_claim' || fact.kind === 'payment_claim'
        ? normalizeDocumentDecimal(fact.value.amount)
        : undefined;
    return {
      ...normalizedFact,
      disclosure: original.disclosure === 'staff_only' ? 'staff_only' : fact.disclosure,
      verification,
      authority: 'customer_claim',
      ...(amountCents === undefined ? {} : { amountCents }),
    };
  });
  for (const fact of facts) {
    if (fact.kind !== 'guest' || fact.value.roomIndex === undefined || fact.value.roomRef === undefined) continue;
    const quantities = facts.filter((f): f is Extract<ValidatedDocumentFact, { kind: 'room' }> => f.kind === 'room' && f.value.roomRef === fact.value.roomRef && f.value.quantity !== undefined);
    if (quantities.some(room => fact.value.roomIndex! > room.value.quantity!)) throw new Error('Guest room index exceeds explicit room quantity');
  }
  const taskIds = new Set<string>();
  const taskSpans = new Set<string>();
  for (const task of parsed.data.tasks) {
    if (taskIds.has(task.id) || task.factIds.some((id) => !ids.has(id)))
      throw new Error('Invalid document task references');
    const original=bySource.get(task.source.attachmentId);
    if(!original||original.sourceHash!==task.source.sourceHash||task.source.page>original.pageCount)throw new Error('Unbound task source');
    const spanKey=JSON.stringify(task.source);if(taskSpans.has(spanKey))throw new Error('Repeated task source span');taskSpans.add(spanKey);
    if(original.pages){const {quote,start,end}=task.source;if(quote===undefined||start===undefined||end===undefined||end<=start||original.pages[task.source.page-1]?.slice(start,end)!==quote)throw new Error('Unverified task request span');}
    else{const region=task.source.region;if(!region||region[2]<=region[0]||region[3]<=region[1]||task.source.quote!==undefined||task.source.start!==undefined||task.source.end!==undefined)throw new Error('Unverified visual task region');}
    if(task.kind==='channel_booking_sync'){
      if(!original.pages||task.source.quote===undefined||task.source.start===undefined||task.source.end===undefined)throw new Error('Channel sync requires verified original request');
      assertChannelBookingSyncRequest(task.source.quote,original.pages[task.source.page-1]!,task.source.start,task.source.end);
    }
    taskIds.add(task.id);
  }
  return {
    facts,
    tasks: parsed.data.tasks,
    unresolvedAsks: parsed.data.unresolvedAsks,
    draftReady: false,
  };
}
/** Guest serializer must use this projection, never a raw document plan. */
export function guestDocumentFacts(plan: ValidatedDocumentPlan): ValidatedDocumentFact[] {
  return plan.facts.filter((f) => f.disclosure === 'guest' && f.verification === 'text_verified');
}
