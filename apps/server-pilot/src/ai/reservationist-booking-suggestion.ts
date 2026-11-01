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
  const boundaries = [
    text.search(/^(?:\s*>?\s*(?:From:|Sent:|Subject:|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:)|-{2,}\s*(?:Original Message|Forwarded message))/im),
    text.search(/^[\t ]*(?:(?:thank\s+you\s+and\s+)?(?:kind|warm|best)\s+regards|regards)[^\p{L}\p{N}\r\n]*$/imu),
  ].filter((position) => position >= 0);
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
  const zeroChild = /\b(?:no|without|zero|0)\s+(?:children|kids?|infants?|minors?)\b|\b(?:children|kids?)\s*[:=]\s*0\b/i;
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

/** Creates only a cited form prefill; it does not check HMS, price a stay, or authorize a save. */
export async function buildReservationistBookingSuggestion(input: {
  task: Task;
  facts: readonly ValidatedDocumentFact[];
  runtime: ReservationistRuntimeInput;
  attachmentAdmissions: readonly AttachmentAdmission[];
}): Promise<ReservationistBookingSuggestion | null> {
  const { task, runtime } = input;
  const request = citation(task.source);
  const trigger = runtime.messages.find((message) => message.id === runtime.trigger.id);
  if (
    task.kind !== 'new_booking' ||
    !request ||
    !trigger ||
    trigger.direction !== 'inbound' ||
    trigger.disclosure === 'staff_only' ||
    task.source.attachmentId !== `message:${trigger.id}` ||
    task.source.sourceHash !== hashText(trigger.text) ||
    task.source.page !== 1 ||
    task.source.end! > authoredEnd(trigger.text, trigger.sourceViews, task.source) ||
    trigger.text.slice(task.source.start!, task.source.end!) !== task.source.quote
  ) return null;

  const missing: string[] = [];
  const validFacts = input.facts.flatMap((fact) => {
    const source = sourceIsCurrent(fact, runtime, input.attachmentAdmissions);
    return source ? [{ fact, source }] : [];
  });
  if (validFacts.length !== input.facts.length) missing.push('Some stay facts are not bound to the current email or its current readable attachments.');

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
  const canPrefill =
    datePairs.size === 1 &&
    rooms.length > 0 &&
    !allocationConflict &&
    rooms.every(({ value }) => value.quantity !== null && value.childAges !== null && !(value.adults === 0 && value.childAges.length === 0)) &&
    partyNames.length <= 1 &&
    !missing.some((item) => item.startsWith('Some stay facts'));

  if (!canPrefill) {
    return {
      version: 1,
      taskId: task.id,
      status: 'needs_details',
      displayOnly: true,
      saved: false,
      groupId,
      source: request,
      partyNames,
      facts: sourceFacts,
      missing: uniqueStrings(missing),
    };
  }

  const stay = datePairs.values().next().value as (typeof dates)[number];
  const orderedGroups = [...grouped.values()].sort((a, b) =>
    a.source.start - b.source.start || a.value.roomRef.localeCompare(b.value.roomRef),
  );
  const physicalRooms: Array<{ roomRef: string; localIndex: number; adults: number; childAges: number[]; board: QuotedBoard }> = [];
  for (const group of orderedGroups) {
    const quantity = group.value.quantity!;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || physicalRooms.length + quantity > 96) {
      missing.push('Room quantity exceeds the supported preparation limit.');
      return {
        version: 1, taskId: task.id, status: 'needs_details', displayOnly: true, saved: false,
        groupId, source: request, partyNames, facts: sourceFacts, missing: uniqueStrings(missing),
      };
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

  const nameByRoom = new Map<string, Array<{ firstName: string; lastName: string }>>();
  for (const guest of guests) {
    if (!guest.roomRef) continue;
    const group = grouped.get(guest.roomRef);
    if (!group || group.value.quantity === null) continue;
    const localIndex = guest.roomIndex ?? (group.value.quantity === 1 ? 1 : undefined);
    if (localIndex === undefined || localIndex < 1 || localIndex > group.value.quantity) continue;
    const key = `${guest.roomRef}\0${localIndex}`;
    const names = nameByRoom.get(key) ?? [];
    if (!names.some((name) => name.firstName === guest.firstName && name.lastName === guest.lastName)) names.push({ firstName: guest.firstName, lastName: guest.lastName });
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
        const names = nameByRoom.get(`${room.roomRef}\0${room.localIndex}`), name = names?.length === 1 ? names[0] : undefined;
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
  } catch {
    return {
      version: 1, taskId: task.id, status: 'needs_details', displayOnly: true, saved: false,
      groupId, source: request, partyNames, facts: sourceFacts,
      missing: uniqueStrings([...missing, 'The current property form could not prepare a booking draft.']),
    };
  }
  if (!prefill.requests.length) {
    return {
      version: 1, taskId: task.id, status: 'needs_details', displayOnly: true, saved: false,
      groupId, source: request, partyNames, facts: sourceFacts,
      missing: uniqueStrings([...missing, 'The current property form could not prepare a booking draft.']),
    };
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
