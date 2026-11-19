import { input, manifest, option, snapshot } from './schema.js';
import { buildQuoteWorkbook, quoteDateLabel, type WorkbookLine } from './quote-workbook.js';
import { groupedQuoteRequest } from '../../src/schema.js';
import { z } from 'zod';

export type Artifact = { id: string; name: string; mime_type: string; url: string };
export type ToolContext = { sessionId: string; mode: 'live' | 'labtest' | 'historical'; signal?: AbortSignal };
type Scope = { sessionId: string; quoteId: string; proposalId: string; revision: number };
type Output = { name: string; mime_type: string; bytes: Uint8Array };
export type Ports = {
  // Authorize this session and return its immutable published proposal revision, selected options and native capture.
  resolveQuote(args: { sessionId: string; quoteId: string; signal?: AbortSignal }): Promise<unknown>;
  convertWorkbook(args: { bytes: Uint8Array; signal?: AbortSignal }): Promise<Uint8Array>;
  // Atomically reauthorize, compare current revision, store both privately and return scoped API handles.
  writePair(args: Scope & { pdf: Output; workbook: Output; signal?: AbortSignal }): Promise<{ pdf: Artifact; workbook: Artifact }>;
};
type ToolResult = { ok: true; data: { pdf: Artifact; workbook: Artifact }; error: null } |
  { ok: false; data: null; error: { code: string; message: string; retryable: boolean; outcome: 'known' } };
const fail = (code: string, message: string, retryable = false): ToolResult =>
  ({ ok: false, data: null, error: { code, message, retryable, outcome: 'known' } });

function cents(amount: string): number {
  const [whole, fraction = ''] = amount.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid price');
  return value;
}
function dateAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
const scopeSchema = snapshot.pick({quote_id:true,property_code:true,groups:true,capture:true});
type QuoteScope = z.infer<typeof scopeSchema>;
type QuoteGroup = QuoteScope['groups'][number];
type QuoteRoom = QuoteGroup['rooms'][number];
type CapturedRoom = QuoteScope['capture']['groups'][string]['rooms'][number];

function checkScope(quote: QuoteScope): void {
  if (quote.capture.quote_id !== quote.quote_id || quote.capture.property_code !== quote.property_code ||
      quote.capture.group_order.length !== quote.groups.length ||
      quote.groups.some((group, i) => quote.capture.group_order[i] !== group.group_id) ||
      new Set(quote.groups.map(group => group.group_id)).size !== quote.groups.length ||
      Object.keys(quote.capture.groups).length !== quote.groups.length) throw new Error('group scope');
  for (const group of quote.groups) {
    const captured = quote.capture.groups[group.group_id];
    if (!captured || captured.group_id !== group.group_id || captured.arrival_date !== group.arrival_date ||
        captured.departure_date !== group.departure_date || group.departure_date <= group.arrival_date ||
        captured.rooms.length !== group.rooms.length || new Set(group.rooms.map(room => room.id)).size !== group.rooms.length ||
        new Set(captured.rooms.map(room => room.room_id)).size !== captured.rooms.length) throw new Error('capture scope');
    for (const room of group.rooms) if (!captured.rooms.some(item=>item.room_id===room.id)) throw new Error('missing captured room');
  }
}

function roomLines(quote:QuoteScope,group:QuoteGroup,room:QuoteRoom,capturedRoom:CapturedRoom,index:number): WorkbookLine[] {
      const native=capturedRoom.native_result;
      if (!native) throw new Error('room not checked');
      const request = native.request;
      if (request.quantity !== room.quantity || request.adults !== room.adults || request.children !== room.children ||
          request.childAges.length !== room.child_ages.length || request.childAges.some((age, i) => age !== room.child_ages[i])) throw new Error('occupancy changed');
      const selected = option.parse(native.options[index]);
      const meal = typeof selected.mealPlan === 'string' ? selected.mealPlan : selected.mealPlan?.label || selected.mealPlan?.code || '';
      if (room.child_ages.length !== room.children) throw new Error('child ages');
      const label = (code: string, meaning?: string | null) => meaning && meaning !== code ? `${code} (${meaning})` : code;
      const description = [label(selected.room.code, selected.room.label), label(selected.rate.code, selected.rate.label),
        meal, `${room.adults} adult${room.adults === 1 ? '' : 's'}${room.children ? `, ${room.children} children (ages ${room.child_ages.join(', ')})` : ''} per room`].filter(Boolean).join(' · ');
      const lines: WorkbookLine[] = [];
      let expected = group.arrival_date;
      for (const night of selected.nightly) {
        if (night.date !== expected || night.date >= group.departure_date || night.inventory < room.quantity) throw new Error('night coverage');
        const rateMinor = cents(night.price.amount);
        if (rateMinor === 0) throw new Error('zero price requires staff review');
        const totalMinor = rateMinor * room.quantity;
        if (!Number.isSafeInteger(totalMinor)) throw new Error('money overflow');
        lines.push({ dateLabel: quoteDateLabel(night.date, dateAfter(night.date)), description, qty: room.quantity,
          nights: 1, rateMinor, totalMinor });
        expected = dateAfter(expected);
      }
      if (expected !== group.departure_date) throw new Error('night coverage');
      return lines;
}

function linesFor(quote: ReturnType<typeof snapshot.parse>): WorkbookLine[] {
  checkScope(quote);
  const selections = new Map(quote.selections.map(item => [JSON.stringify([item.group_id, item.room_id]), item.option_index]));
  if (selections.size !== quote.selections.length) throw new Error('duplicate selection');
  const lines: WorkbookLine[] = [];
  let rooms = 0;
  for (const group of quote.groups) for (const room of group.rooms) {
    const capturedRoom=quote.capture.groups[group.group_id].rooms.find(item=>item.room_id===room.id);
    const index=selections.get(JSON.stringify([group.group_id,room.id]));
    if (index === undefined) continue;
    if (!capturedRoom) throw new Error('missing selected room');
    rooms++;
    lines.push(...roomLines(quote,group,room,capturedRoom,index));
  }
  if (rooms !== selections.size) throw new Error('extra selection');
  for (const extra of quote.output.extras) {
    const rateMinor=extra.unit_price === null ? null : cents(extra.unit_price);
    const totalMinor=rateMinor === null || extra.quantity === null || extra.units === null ? null : rateMinor * extra.quantity * extra.units;
    lines.push({dateLabel:'',description:extra.description,qty:extra.quantity,nights:extra.units,rateMinor,totalMinor});
  }
  return lines;
}

const quoteCapture = z.object({quotes:z.record(z.unknown()),searches:z.array(z.object({arrival_date:z.string(),departure_date:z.string(),
  native_result:z.object({outcome:z.string(),audit:z.object({status:z.string()})})})).min(1)});

function hasOverlappingSearches(searches: z.infer<typeof quoteCapture>['searches']): boolean {
  return searches.some((search,i)=>searches.slice(0,i).some(prior=>
    prior.arrival_date<search.departure_date && search.arrival_date<prior.departure_date));
}

export function quoteArtifactBlockReason(native: unknown): 'overlapping_date_searches' | null {
  const captured=quoteCapture.safeParse(native);
  return captured.success && hasOverlappingSearches(captured.data.searches) ? 'overlapping_date_searches' : null;
}

export function quoteOptions(request:unknown, native:unknown, _requireJointSelection=true) {
  const parsedRequest=groupedQuoteRequest.safeParse(request), captured=quoteCapture.safeParse(native);
  if (!parsedRequest.success || !captured.success) return [];
  const q=parsedRequest.data;
  const parsed=scopeSchema.safeParse({quote_id:q.quote_id,property_code:q.property_code,groups:q.groups,
    capture:captured.data.quotes[q.quote_id]});
  if(!parsed.success) return [];
  const quote=parsed.data;
  try { checkScope(quote); } catch { return []; }
  return quote.groups.flatMap(group=>group.rooms.flatMap(room=>{
    const capturedRoom=quote.capture.groups[group.group_id].rooms.find(item=>item.room_id===room.id);
    if(!capturedRoom?.native_result) return [];
    return capturedRoom.native_result.options.flatMap((value,option_index)=>{
      const selected=option.safeParse(value);
      if(!selected.success) return [];
      try { roomLines(quote,group,room,capturedRoom,option_index); } catch { return []; }
      const item=selected.data;
      return [{group_id:group.group_id,room_id:room.id,option_index,room:{code:item.room.code,label:item.room.label ?? null},
        rate:{code:item.rate.code,label:item.rate.label ?? null},meal_plan:item.mealPlan ?? null,nightly:item.nightly,
        availability:item.availability,eligibility:item.eligibility,match_status:item.matchStatus}];
    });
  }));
}
function validRef(ref: Artifact, output: Output): boolean {
  return typeof ref.id === 'string' && ref.id.length > 0 && ref.name === output.name && ref.mime_type === output.mime_type &&
    ref.url === `/api/nava/v1/artifacts/${encodeURIComponent(ref.id)}`;
}

export function createQuoteArtifacts(ports: Ports) {
  return async function quoteArtifacts(raw: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return fail('INVALID_INPUT', 'Supply a quote ID.');
    if (context.signal?.aborted) return fail('ABORTED', 'Artifact generation was cancelled.');
    let resolved: unknown;
    try { resolved = await ports.resolveQuote({ sessionId: context.sessionId, quoteId: parsed.data.quote_id, signal: context.signal }); }
    catch { return fail('QUOTE_RESOLUTION_FAILED', 'The authorized quote revision could not be resolved.'); }
    const result = snapshot.safeParse(resolved);
    if (!result.success || result.data.quote_id !== parsed.data.quote_id) return fail('QUOTE_UNAVAILABLE', 'The authorized quote revision or selected native prices are incomplete.');
    const quote = result.data;
    let bytes: Uint8Array;
    try {
      const lines = linesFor(quote);
      bytes = buildQuoteWorkbook({ authoredDate: quote.authored_date, propertyCode: quote.property_code,
        header: quote.header, lines, validUntil:quote.output.valid_until,
        note:[`Payment terms: ${quote.output.payment_terms || 'Please confirm with reservations.'}`,quote.note].filter(Boolean).join('\n') });
    } catch { return fail('QUOTE_NOT_RENDERABLE', 'The selected quote is incomplete or cannot be represented by the quotation template.'); }
    if (context.signal?.aborted) return fail('ABORTED', 'Artifact generation was cancelled.');
    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await ports.convertWorkbook({ bytes, signal: context.signal });
      if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length <= 5 || new TextDecoder().decode(pdfBytes.subarray(0, 5)) !== '%PDF-') throw new Error('invalid pdf');
    } catch { return context.signal?.aborted ? fail('ABORTED', 'Artifact generation was cancelled.') :
      fail('PDF_CONVERTER_UNAVAILABLE', 'The configured PDF converter could not generate a quotation.', true); }
    if (context.signal?.aborted) return fail('ABORTED', 'Artifact generation was cancelled.');
    const prefix=quote.file_prefix ?? 'Quotation';
    const pdf: Output = { name: `${prefix}.pdf`, mime_type: 'application/pdf', bytes: pdfBytes };
    const workbook: Output = { name: `${prefix}.xlsx`, mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes };
    try {
      const refs = await ports.writePair({ sessionId: context.sessionId, quoteId: quote.quote_id,
        proposalId: quote.proposal_id, revision: quote.revision, pdf, workbook, signal: context.signal });
      if (!validRef(refs.pdf, pdf) || !validRef(refs.workbook, workbook) || refs.pdf.id === refs.workbook.id) throw new Error('invalid artifact refs');
      return { ok: true, data: refs, error: null };
    } catch { return fail('ARTIFACT_STORAGE_FAILED', 'The quote changed or private artifact storage failed. Recheck the quote and try again.', true); }
  };
}

// Server injects ports when registering the tool. No model input can supply authority or output paths.
export function createTools(ports: Ports) { return [{ ...manifest, run: createQuoteArtifacts(ports) }]; }

export const tools = [{ ...manifest, run: (raw: unknown, context: ToolContext & { quoteArtifactsPorts?: Ports }): Promise<ToolResult> =>
  context.quoteArtifactsPorts ? createQuoteArtifacts(context.quoteArtifactsPorts)(raw, context) :
    Promise.resolve(fail('ARTIFACT_PORTS_UNAVAILABLE', 'Quote artifact services are not configured.')) }];
