import { createHash } from 'node:crypto';
import type { AttachmentAdmission } from './reservationist-attachment-input.js';
import { buildCreatePrefill } from './aop/create-prefill.js';
import {
  bookingDraftFromPrefill,
  createRequestFieldOptions,
  type BookingDraft,
  type QuotedBoard,
} from './booking-draft.js';
import type { ValidatedDocumentFact, ValidatedDocumentPlan } from './reservationist-document-facts.js';
import { validReservationistMessageViews } from './reservationist-message-view.js';
import { boards as rateBoards, norm as normRate } from './rate-options.js';
import type { ReservationistRuntimeInput } from './reservationist-runtime.js';
export type ReservationistBookingSuggestionCitation = {
  sourceRef: string;
  sourceHash: string;
  page: number;
  start: number;
  end: number;
};
export type ReservationistBookingSuggestion = {
  version: 1;
  taskId: string;
  status: 'prefill' | 'needs_details';
  displayOnly: true;
  saved: false;
  /** Mail-form hash added only by the current-message review route after source verification. */
  staffSourceHash?: string;
  /** Stable per request source; safe for the pane's `_roomIndex` save id. */
  groupId: string;
  source: ReservationistBookingSuggestionCitation;
  /** Unclassified source names for a per-request PartyPicker; never mapped to agency/company here. */
  partyNames: string[];
  facts: Record<'dates' | 'rooms' | 'guests' | 'boards' | 'parties', Array<{ source: ReservationistBookingSuggestionCitation }>>;
  /** Missing facts block draft creation; draft.missing contains existing HMS-form questions. */
  missing: string[];
  draft?: BookingDraft;
  options?: ReturnType<typeof createRequestFieldOptions>;
};
type Task = ValidatedDocumentPlan['tasks'][number];
type CitationSource = {
  attachmentId: string;
  sourceHash: string;
  page: number;
  start?: number;
  end?: number;
  quote?: string;
};
function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function citation(source: CitationSource): ReservationistBookingSuggestionCitation | null {
  if (
    !source.attachmentId ||
    !/^[a-f0-9]{64}$/.test(source.sourceHash) ||
    !Number.isSafeInteger(source.page) ||
    source.page < 1 ||
    !Number.isSafeInteger(source.start) ||
    !Number.isSafeInteger(source.end) ||
    source.start! < 0 ||
    source.end! <= source.start! ||
    typeof source.quote !== 'string' ||
    source.quote.length !== source.end! - source.start!
  ) return null;
  return {
    sourceRef: source.attachmentId,
    sourceHash: source.sourceHash,
    page: source.page,
    start: source.start!,
    end: source.end!,
  };
}

/** IDs stay distinct for same-date bookings and stable when the same source is read again. */
export function reservationistBookingSuggestionGroupId(source: ReservationistBookingSuggestionCitation): string {
  const identity = [source.sourceRef, source.sourceHash, source.page, source.start, source.end].join('\0');
  return `b_${createHash('sha256').update(identity).digest('hex').slice(0, 30)}`;
}

function authoredEnd(
  text: string,
  sourceViews?: ReservationistRuntimeInput['messages'][number]['sourceViews'],
  span?: CitationSource,
): number {
  let offset = 0;
  if (sourceViews) {
    if (!span || typeof span.start !== 'number' || typeof span.end !== 'number' || !validReservationistMessageViews(text, sourceViews)) return -1;
    const view = sourceViews.find((item) => span.start! >= item.start && span.end! <= item.end);
    if (!view) return -1;
    offset = view.start;
    text = text.slice(view.start, view.end);
  }
  const history = text.search(/^(?:\s*>?\s*(?:From:|Sent:|Subject:|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:)|-{2,}\s*(?:Original Message|Forwarded message))/im);
  const signoff = text.search(/^[\t ]*(?:(?:thank\s+you\s+and\s+)?(?:kind|warm|best)\s+regards|regards)[^\p{L}\p{N}\r\n]*$/imu);
  const postscript = signoff < 0 ? -1 : text.slice(signoff).search(/^[\t ]*p[\t ]*\.?[\t ]*s[\t ]*\.?(?=[\s:]|$)/im);
  const inPostscript = postscript >= 0 && span?.start !== undefined && span.start - offset >= signoff + postscript;
  const boundaries = [history, inPostscript ? -1 : signoff].filter((position) => position >= 0);
  return offset + (boundaries.length ? Math.min(...boundaries) : text.length);
}

function sourceIsCurrent(
  fact: ValidatedDocumentFact,
  runtime: ReservationistRuntimeInput,
  admissions: readonly AttachmentAdmission[],
): ReservationistBookingSuggestionCitation | null {
  if (fact.verification !== 'text_verified' || fact.disclosure !== 'guest') return null;
  const span = citation(fact.source);
  if (!span) return null;

  const trigger = runtime.messages.find((message) => message.id === runtime.trigger.id);
  if (!trigger || trigger.direction !== 'inbound' || trigger.disclosure === 'staff_only') return null;

  if (fact.source.attachmentId === `message:${trigger.id}`) {
    if (
      trigger.at !== runtime.trigger.at ||
      Date.parse(trigger.at) !== Date.parse(runtime.clock.causalAt) ||
      span.sourceHash !== hashText(trigger.text) ||
      span.page !== 1 ||
      span.end > authoredEnd(trigger.text, trigger.sourceViews, fact.source) ||
      trigger.text.slice(span.start, span.end) !== fact.source.quote
    ) return null;
    return span;
  }

  const admission = admissions.find((item) => item.metadata.attachmentId === span.sourceRef);
  const page = admission?.source?.pages?.[span.page - 1];
  if (
    admission?.status !== 'admitted' ||
    admission.relation !== 'current' ||
    admission.metadata.messageId !== trigger.id ||
    admission.metadata.ownerRef !== runtime.authorizationScope?.ownerRef ||
    admission.metadata.threadId !== runtime.authorizationScope?.threadId ||
    admission.metadata.disclosure !== 'guest' ||
    admission.source?.disclosure !== 'guest' ||
    admission.source.sourceHash !== span.sourceHash ||
    !page ||
    page.slice(span.start, span.end) !== fact.source.quote
  ) return null;
  return span;
}

function noChildrenExplicitlyKnown(
  quote: string,
  room: Extract<ValidatedDocumentFact, { kind: 'room' }>,
): boolean {
  if (/\b(?:adults?\s+only|only\s+adults?)\b/i.test(quote)) return true;
  const zeroChild = /\b(?:no|without|zero|0)\s+(?:children|kids?|minors?)\b|\b(?:children|kids?)\s*[:=]\s*0\b/i;
  if (zeroChild.test(quote) && !/\b(?:under|over|aged?|age|younger|older)\b/i.test(quote)) return true;
  // Existing extraction semantics support this one narrowly explicit adult-only case.
  return room.value.quantity === 1 && room.value.adults === 1 && room.value.childAges.length === 0 &&
    /\b(?:1|one)\s+(?:(?:single|standard|executive|deluxe)\s+)?room\b/i.test(quote) &&
    /\b(?:1|one)\s+adult\b/i.test(quote) &&
    !/\b(?:child|children|kid|kids|infant|minor|family)\b/i.test(quote);
}

function boardValue(value: string): QuotedBoard {
  const board = rateBoards[normRate(value)];
  return board === 'breakfast' ? 'bb' : board === 'dinner_bed_breakfast' ? 'dinner_bb' : board ?? 'unknown';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function currentTaskRequestSource(
  task: Task,
  runtime: ReservationistRuntimeInput,
): ReservationistBookingSuggestionCitation | null {
  const trigger = runtime.messages.find((message) => message.id === runtime.trigger.id);
  const source = citation(task.source);
  return !!source &&
    !!trigger &&
    trigger.direction === 'inbound' &&
    trigger.disclosure !== 'staff_only' &&
    task.source.attachmentId === `message:${trigger.id}` &&
    task.source.sourceHash === hashText(trigger.text) &&
    task.source.page === 1 &&
    task.source.end! <= authoredEnd(trigger.text, trigger.sourceViews, task.source) &&
    trigger.text.slice(task.source.start!, task.source.end!) === task.source.quote
    ? source
    : null;
}

function currentBookingRequestSource(
  task: Task,
  runtime: ReservationistRuntimeInput,
): ReservationistBookingSuggestionCitation | null {
  return task.kind === 'new_booking' ? currentTaskRequestSource(task, runtime) : null;
}

function currentStayRequestSource(
  task: Task,
  runtime: ReservationistRuntimeInput,
): ReservationistBookingSuggestionCitation | null {
  return ['new_booking', 'quote', 'acceptance', 'change', 'cancel_request', 'channel_booking_sync'].includes(task.kind)
    ? currentTaskRequestSource(task, runtime)
    : null;
}

function requestScope(task: Task, source: ReservationistBookingSuggestionCitation): string {
  return [task.id, task.kind, source.sourceRef, source.sourceHash, source.page, source.start, source.end].join('\0');
}

/** Only explicit stay labels are shared between a request and a separately cited row. */
function explicitStayLabels(text: string): string[] {
  const labels = new Set<string>();
  const generic = new Set([
    'a', 'an', 'the', 'this', 'that', 'my', 'our', 'your', 'same', 'current', 'new', 'old', 'and', 'or', 'of', 'as',
    'booking', 'reservation', 'confirmation',
    'from', 'to', 'for', 'with', 'is', 'was', 'will', 'room', 'rooms', 'date', 'dates',
    'details', 'request', 'please', 'one', 'two',
  ]);
  for (const match of text.matchAll(/\b(group|stay)\s+(?:id\s*[:#-]?\s*)?([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})\b/giu)) {
    const value = match[2]!.toLowerCase();
    if (!generic.has(value) || match[2] === 'A') labels.add(`${match[1]!.toLowerCase()}:${value}`);
  }
  for (const match of text.matchAll(/\b(?:booking|reservation|confirmation)\s+(?:reference|ref(?:erence)?|number|no\.?|id)\s*[:#-]?\s*([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})/giu))
    labels.add(`reference:${match[1]!.toLowerCase()}`);
  for (const match of text.matchAll(/\b(?:reference|ref\.?|confirmation)\s*[:#]\s*([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})/giu))
    labels.add(`reference:${match[1]!.toLowerCase()}`);
  return [...labels];
}

function hasMultipleStayLabels(text: string): boolean {
  const valuesByKind = new Map<string, Set<string>>();
  for (const label of explicitStayLabels(text)) {
    const separator = label.indexOf(':');
    const kind = label.slice(0, separator);
    const value = label.slice(separator + 1);
    const family = kind === 'group' || kind === 'stay' ? 'stay' : kind;
    const values = valuesByKind.get(family) ?? new Set<string>();
    values.add(value);
    valuesByKind.set(family, values);
    if (values.size > 1) return true;
  }
  return false;
}

function factSourceContext(
  fact: ValidatedDocumentFact,
  runtime: ReservationistRuntimeInput,
  admissions: readonly AttachmentAdmission[],
): string {
  const span = citation(fact.source);
  if (!span) return fact.source.quote ?? '';
  const messageId = fact.source.attachmentId.match(/^message:([\s\S]+)$/)?.[1];
  const message = messageId ? runtime.messages.find((item) => item.id === messageId) : undefined;
  const admission = message ? undefined : admissions.find((item) => item.metadata.attachmentId === span.sourceRef);
  const page = message?.text ?? (admission?.status === 'admitted' && admission.relation === 'current' &&
      admission.source?.sourceHash === span.sourceHash
    ? admission.source.pages?.[span.page - 1]
    : undefined);
  if (!page) return fact.source.quote ?? '';

  let lower = 0, upper = page.length;
  if (message?.sourceViews?.length) {
    const view = message.sourceViews.find((item) => span.start >= item.start && span.end <= item.end);
    if (!view) return fact.source.quote ?? '';
    lower = view.start;
    upper = view.end;
  }
  const before = page.slice(lower, span.start);
  const boundary = Math.max(
    before.lastIndexOf('\n'), before.lastIndexOf('.'), before.lastIndexOf('!'),
    before.lastIndexOf('?'), before.lastIndexOf(';'),
  );
  const start = lower + boundary + 1;
  const after = page.slice(span.end, upper);
  const endOffset = after.search(/[\n.!?;]/);
  const end = span.end + (endOffset < 0 ? after.length : endOffset);
  let context = page.slice(start, end);

  // Rooming-list headers commonly occupy the line directly above their data row.
  const previousLineEnd = start > lower ? start - 1 : lower;
  const previousLineStart = Math.max(lower, page.lastIndexOf('\n', previousLineEnd - 1) + 1);
  const previousLine = page.slice(previousLineStart, previousLineEnd).trim();
  if (start > lower && page[start - 1] === '\n' && previousLine.endsWith(':') && explicitStayLabels(previousLine).length)
    context = `${previousLine} ${context}`;
  return context;
}

function factBelongsToBookingRequest(
  fact: ValidatedDocumentFact,
  taskScope: string,
  requestScopes: readonly { key: string; source: ReservationistBookingSuggestionCitation }[],
  requestScopesByLabel: ReadonlyMap<string, ReadonlySet<string>>,
  runtime: ReservationistRuntimeInput,
  admissions: readonly AttachmentAdmission[],
): boolean {
  const factSource = citation(fact.source)!, factContextLabels = explicitStayLabels(factSourceContext(fact, runtime, admissions));
  const labelOwners = new Set(factContextLabels.flatMap((label) => [...(requestScopesByLabel.get(label) ?? [])]));
  const containingScopes = requestScopes.filter(({ source }) => {
    return source.sourceRef === factSource.sourceRef && source.sourceHash === factSource.sourceHash &&
      source.page === factSource.page && factSource.start >= source.start && factSource.end <= source.end;
  });
  const specificSpanLength = Math.min(...containingScopes.map(({ source }) => source.end - source.start));
  const spanOwners = new Set(containingScopes
    .filter(({ source }) => source.end - source.start === specificSpanLength)
    .map(({ key }) => key));

  if (spanOwners.size === 1) {
    const owner = [...spanOwners][0]!;
    return owner === taskScope && (!labelOwners.size || labelOwners.size === 1 && labelOwners.has(owner));
  }
  return labelOwners.size === 1 && labelOwners.has(taskScope);
}

/** Creates only a cited form prefill; it does not check HMS, price a stay, or authorize a save. */
export async function buildReservationistBookingSuggestion(input: {
  task: Task;
  facts: readonly ValidatedDocumentFact[];
  requestTasks?: readonly Task[];
  runtime: ReservationistRuntimeInput;
  attachmentAdmissions: readonly AttachmentAdmission[];
}): Promise<ReservationistBookingSuggestion | null> {
  const { task, runtime } = input;
  const request = currentBookingRequestSource(task, runtime);
  if (!request) return null;

  const missing: string[] = [];
  const validFacts = input.facts.flatMap((fact) => {
    const source = sourceIsCurrent(fact, runtime, input.attachmentAdmissions);
    return source ? [{ fact, source }] : [];
  });
  if (validFacts.length !== input.facts.length) missing.push('Some stay facts are not bound to the current email or its current readable attachments.');

  const requestSources = new Map<string, { source: ReservationistBookingSuggestionCitation; quote: string }>();
  for (const candidate of [...(input.requestTasks ?? []), task]) {
    const source = currentStayRequestSource(candidate, runtime);
    if (source) requestSources.set(requestScope(candidate, source), { source, quote: candidate.source.quote ?? '' });
  }
  const requestScopes = [...requestSources].map(([key, { source }]) => ({ key, source }));
  const targetScope = requestScope(task, request);
  const requestScopesByLabel = new Map<string, Set<string>>();
  for (const [key, { quote }] of requestSources) {
    for (const label of explicitStayLabels(quote)) {
      const owners = requestScopesByLabel.get(label) ?? new Set<string>();
      owners.add(key);
      requestScopesByLabel.set(label, owners);
    }
  }
  const multipleStayLabels = hasMultipleStayLabels(task.source.quote ?? '');
  if (multipleStayLabels)
    missing.push('This request names multiple groups or booking references; staff must separate them before preparing a booking.');
  const ambiguousTaskFacts = requestScopes.length > 1 && validFacts.some(({ fact }) =>
    !factBelongsToBookingRequest(fact, targetScope, requestScopes, requestScopesByLabel, runtime, input.attachmentAdmissions));
  if (ambiguousTaskFacts) missing.push('Some cited stay facts cannot be uniquely linked to this booking request; check each cited source before preparing a booking.');

  const dates = validFacts.flatMap(({ fact, source }) => fact.kind === 'dates'
    ? [{ arrival: fact.value.arrival, departure: fact.value.departure, source }]
    : []);
  const rooms = validFacts.flatMap(({ fact, source }) => fact.kind === 'room'
    ? [{
        fact,
        value: {
          roomRef: fact.value.roomRef,
          quantity: fact.value.quantity ?? null,
          adults: fact.value.adults,
          childAges: fact.value.childAges.length > 0 || noChildrenExplicitlyKnown(fact.source.quote ?? '', fact)
            ? [...fact.value.childAges]
            : null,
        },
        source,
      }]
    : []);
  const guests = validFacts.flatMap(({ fact, source }) => fact.kind === 'guest'
    ? [{
        firstName: fact.value.firstName,
        lastName: fact.value.lastName,
        ...(fact.value.roomRef === undefined ? {} : { roomRef: fact.value.roomRef }),
        ...(fact.value.roomIndex === undefined ? {} : { roomIndex: fact.value.roomIndex }),
        ...(fact.value.age === undefined ? {} : { age: fact.value.age }),
        source,
      }]
    : []);
  const boards = validFacts.flatMap(({ fact, source }) => fact.kind === 'board'
    ? [{
        board: typeof fact.value === 'string' ? fact.value : fact.value.board,
        ...((typeof fact.value === 'string' || fact.value.roomRef === undefined) ? {} : { roomRef: fact.value.roomRef }),
        source,
      }]
    : []);
  const parties = validFacts.flatMap(({ fact, source }) => fact.kind === 'party'
    ? [{ name: fact.value, source }]
    : []);
  const partyNames = [...new Map(parties.map((party) => [party.name.trim().toLowerCase(), party.name.trim()])).values()];

  const datePairs = new Map(dates.map((date) => [`${date.arrival}\0${date.departure}`, date]));
  if (datePairs.size === 0) missing.push('Arrival and departure are not source-verified.');
  else if (datePairs.size > 1) missing.push('This request contains multiple stays; prepare each stay separately.');

  if (rooms.length === 0) missing.push('No source-verified room allocation is available.');
  const grouped = new Map<string, (typeof rooms)[number]>();
  let allocationConflict = false;
  for (const room of rooms) {
    const previous = grouped.get(room.value.roomRef);
    if (!previous) grouped.set(room.value.roomRef, room);
    else if (
      previous.source.sourceRef !== room.source.sourceRef || previous.source.page !== room.source.page ||
      previous.value.quantity !== room.value.quantity ||
      previous.value.adults !== room.value.adults ||
      JSON.stringify(previous.value.childAges) !== JSON.stringify(room.value.childAges)
    ) allocationConflict = true;
  }
  if (allocationConflict) missing.push('Room allocations conflict; staff must resolve them before preparing a booking.');
  if (rooms.some(({ value }) => value.quantity === null)) missing.push('Room quantity is unknown for one or more room groups.');
  if (rooms.some(({ value }) => value.childAges === null)) missing.push('Child occupancy is unknown; confirm no children or provide every child’s age.');
  if (rooms.some(({ value }) => value.adults === 0 && value.childAges?.length === 0)) missing.push('A room has no explicit occupants.');
  if (partyNames.length === 1) missing.push('Staff must classify/select the named party or explicitly choose no linked party before preview.');
  else if (partyNames.length > 1) missing.push('Multiple party names are present; staff must resolve which party applies before preparing a booking.');

  const sourceFacts: ReservationistBookingSuggestion['facts'] = {
    dates: dates.map(({ source }) => ({ source })),
    rooms: rooms.map(({ source }) => ({ source })),
    guests: guests.map(({ source }) => ({ source })),
    boards: boards.map(({ source }) => ({ source })),
    parties: parties.map(({ source }) => ({ source })),
  };
  const groupId = reservationistBookingSuggestionGroupId(request);
  const needsDetails = (details = missing): ReservationistBookingSuggestion => ({
    version: 1, taskId: task.id, status: 'needs_details', displayOnly: true, saved: false,
    groupId, source: request, partyNames, facts: sourceFacts, missing: uniqueStrings(details),
  });
  const canPrefill =
    datePairs.size === 1 &&
    rooms.length > 0 &&
    !allocationConflict &&
    rooms.every(({ value }) => value.quantity !== null && value.childAges !== null && !(value.adults === 0 && value.childAges.length === 0)) &&
    partyNames.length <= 1 &&
    !ambiguousTaskFacts &&
    !multipleStayLabels &&
    !missing.some((item) => item.startsWith('Some stay facts'));

  if (!canPrefill) return needsDetails();

  const stay = datePairs.values().next().value as (typeof dates)[number];
  const orderedGroups = [...grouped.values()].sort((a, b) =>
    a.source.start - b.source.start || a.value.roomRef.localeCompare(b.value.roomRef),
  );
  const physicalRooms: Array<{ roomRef: string; localIndex: number; adults: number; childAges: number[]; board: QuotedBoard }> = [];
  for (const group of orderedGroups) {
    const quantity = group.value.quantity!;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || physicalRooms.length + quantity > 96) {
      missing.push('Room quantity exceeds the supported preparation limit.');
      return needsDetails();
    }
    const groupBoards = boards.filter((board) => board.roomRef === group.value.roomRef || board.roomRef === undefined);
    const boardCodes = new Set(groupBoards.map((board) => boardValue(board.board)));
    const board: QuotedBoard = boardCodes.size === 1 ? [...boardCodes][0]! : 'unknown';
    if (groupBoards.length && (boardCodes.size > 1 || boardCodes.has('unknown'))) missing.push('Meal preferences conflict or are unsupported; staff must check the requested board.');
    for (let localIndex = 1; localIndex <= quantity; localIndex++) {
      physicalRooms.push({
        roomRef: group.value.roomRef,
        localIndex,
        adults: group.value.adults,
        childAges: group.value.childAges!,
        board,
      });
    }
  }

  const nameByRoom = new Map<string, Array<{ firstName: string; lastName: string; child: boolean }>>();
  for (const guest of guests) {
    if (!guest.roomRef) continue;
    const group = grouped.get(guest.roomRef);
    if (!group || group.value.quantity === null) continue;
    const localIndex = guest.roomIndex ?? (group.value.quantity === 1 ? 1 : undefined);
    if (localIndex === undefined || localIndex < 1 || localIndex > group.value.quantity) continue;
    const key = `${guest.roomRef}\0${localIndex}`;
    const names = nameByRoom.get(key) ?? [];
    const existing = names.find((name) => name.firstName === guest.firstName && name.lastName === guest.lastName);
    const child = guest.age !== undefined && guest.age < 18;
    if (existing) existing.child ||= child;
    else names.push({ firstName: guest.firstName, lastName: guest.lastName, child });
    nameByRoom.set(key, names);
  }

  let prefill: Awaited<ReturnType<typeof buildCreatePrefill>>;
  let options: ReturnType<typeof createRequestFieldOptions>;
  try {
    prefill = await buildCreatePrefill({
      arrival: stay.arrival,
      departure: stay.departure,
      nights: null,
      rooms: physicalRooms.map((room) => {
        const names = nameByRoom.get(`${room.roomRef}\0${room.localIndex}`)?.filter(name => !name.child);
        const name = names?.length === 1 ? { firstName: names[0]!.firstName, lastName: names[0]!.lastName } : undefined;
        return {
          adults: room.adults, childAges: [...room.childAges], roomTypeText: null,
          guestName: name ? `${name.firstName} ${name.lastName}` : null, ...name,
        };
      }),
      boardText: boards.length === 1 ? boards[0]!.board : null,
      rateText: null,
      agencyName: null,
      organizationName: null,
      voucherNumber: null,
      bookerName: null,
      bookerEmail: null,
      billingReference: null,
      paidBy: null,
      ...(partyNames.length === 1 ? { partyContextUnresolved: true } : {}),
      defaults: { track: null, sourceOfBusiness: null, guaranteeType: null },
      propertyCode: runtime.propertyCode,
    });
    options = createRequestFieldOptions(runtime.propertyCode);
    if (!prefill.requests.length) throw new Error('empty_booking_prefill');
  } catch {
    return needsDetails([...missing, 'The current property form could not prepare a booking draft.']);
  }
  const draft = bookingDraftFromPrefill({
    requests: prefill.requests,
    missing: prefill.missing,
    schemaErrors: prefill.schemaErrors,
  });
  draft.rooms = draft.rooms.map((room, index) => ({
    ...room,
    groupId,
    roomIndex: index + 1,
    board: physicalRooms[index]?.board ?? 'unknown',
  }));
  return {
    version: 1,
    taskId: task.id,
    status: 'prefill',
    displayOnly: true,
    saved: false,
    groupId,
    source: request,
    partyNames,
    facts: sourceFacts,
    missing: uniqueStrings(missing),
    draft,
    options,
  };
}
