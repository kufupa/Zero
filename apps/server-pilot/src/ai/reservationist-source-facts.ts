import type { ValidatedDocumentFact } from './reservationist-document-facts.js';
import type { BookingRoomInput, BookingEvidence } from './reservationist-booking-packet.js';
import { quoteDigest, type QuoteRevision } from '../quote-proposal/quote-revision.js';

export class ReservationistSourceFactError extends Error {
  constructor(readonly status: 'blocked' | 'needs_clarification', readonly code: string) { super(code); }
}
const fail = (kind: 'missing' | 'mismatch', field: string): never => { throw new ReservationistSourceFactError(kind === 'missing' ? 'needs_clarification' : 'blocked', `source_fact_${field}_${kind}`); };
const boardLabels: Record<string, string> = { 'b&b':'breakfast', bb:'breakfast', dbb:'dinner_bed_breakfast', ro:'room_only', room_only: 'room_only', breakfast: 'breakfast', dinner_bed_breakfast: 'dinner_bed_breakfast', 'room only r': 'room_only', 'bed & breakfast r': 'breakfast', 'dinner bed & breakfast r': 'dinner_bed_breakfast', 'room only':'room_only', 'bed and breakfast':'breakfast', 'bed & breakfast':'breakfast', 'dinner bed and breakfast':'dinner_bed_breakfast', 'dinner bed & breakfast':'dinner_bed_breakfast', 'breakfast and dinner':'dinner_bed_breakfast','breakfast & dinner':'dinner_bed_breakfast','dinner and breakfast':'dinner_bed_breakfast','dinner & breakfast':'dinner_bed_breakfast','dinner, bed & breakfast':'dinner_bed_breakfast','dinner, bed and breakfast':'dinner_bed_breakfast','dinner, bed & breakfast r':'dinner_bed_breakfast', 'dinner, bed, breakfast & beverage r':'dinner_bed_breakfast', 'bed & breakfast nr':'breakfast', 'room only nr':'room_only', 'dinner bed & breakfast nr':'dinner_bed_breakfast', 'dinner, bed & breakfast nr':'dinner_bed_breakfast' };
/** Match only the exact name or an acronym explicitly printed in the native label. */
export function nativePartyLabelMatches(query:string,label:string):boolean{
 const normalized=(s:string)=>s.toLowerCase().replace(/\s+/g,' ').trim();
 if(normalized(query)===normalized(label))return true;
 if(!/^[A-Z][A-Z0-9]{1,11}$/.test(query.trim()))return false;
 const suffix=label.trim().match(/(?:\s[-–—]\s([A-Z][A-Z0-9]{1,11})|\s\(([A-Z][A-Z0-9]{1,11})\))$/);
 return (suffix?.[1]??suffix?.[2])===query.trim();
}
/** Bind original customer facts to independently authorized selected scope; this grants no authority. */
export function assertRevisionSourceFacts(facts: readonly ValidatedDocumentFact[], revision: QuoteRevision, rooms?: readonly BookingRoomInput[], originalGuestFacts: BookingEvidence['guestFacts'] = [], quotationAddressee?:{company:string;agency:string}): void {
  for (const fact of facts) {
    if (fact.verification !== 'text_verified') fail('missing', 'verification');
    if (fact.kind === 'dates') {
      if (!revision.groups.some(group => group.arrivalDate === fact.value.arrival && group.departureDate === fact.value.departure)) fail('mismatch', 'dates');
    } else if (fact.kind === 'room') {
      if(fact.value.quotationBasis==='per_room_rate'){
        if(rooms!==undefined)fail('mismatch','rate_example_booking');
        if(fact.value.quantity!==1||fact.value.childAges.length||![1,2].includes(fact.value.adults))fail('mismatch','rate_example');
      }
      const groups = revision.groups.filter(group => group.id === fact.value.roomRef || group.roomCode === fact.value.roomRef);
      if (!groups.length) fail('mismatch', 'room');
      if (groups.some(group => group.adults !== fact.value.adults || quoteDigest(group.childAges) !== quoteDigest(fact.value.childAges) || fact.value.quantity !== undefined && group.quantity !== fact.value.quantity)) fail('mismatch', 'room');
    } else if (fact.kind === 'board') {
      const value=typeof fact.value==='string'?fact.value:fact.value.board;
      const board = boardLabels[value.toLowerCase().replace(/\s+/g, ' ').trim()];
      if (!board) fail('missing', 'board');
      const target=typeof fact.value==='string'?undefined:fact.value.roomRef;
      const groups=target===undefined?revision.groups:revision.groups.filter(group=>group.id===target||group.roomCode===target);
      if (!groups.length || groups.some(group => group.board !== board)) fail('mismatch', 'board');
    } else if (fact.kind === 'party') {
      if (!revision.groups.some(group => Object.values(group.context).some(context => (context as {name?:string}).name === fact.value || rooms===undefined&&typeof (context as {name?:string}).name==='string'&&nativePartyLabelMatches(fact.value,(context as {name:string}).name))) && !(rooms===undefined&&revision.groups.every(group=>Object.keys(group.context).length===0)&&quotationAddressee&&[quotationAddressee.company,quotationAddressee.agency].includes(fact.value))) fail('mismatch', 'party');
    } else if (fact.kind === 'guest' && rooms !== undefined) {
      if (fact.value.roomRef === undefined || fact.value.roomIndex === undefined) fail('missing', 'guest_assignment');
      const groups = revision.groups.filter(group => group.id === fact.value.roomRef || group.roomCode === fact.value.roomRef);
      if (groups.length !== 1) fail(groups.length ? 'missing' : 'mismatch', 'guest_assignment');
      const group = groups[0];
      const assigned = rooms.filter(room => room.groupId === group.id && room.roomIndex === fact.value.roomIndex);
      if (assigned.length !== 1 || !assigned[0].guests.some(guest => guest.factRef === fact.id && guest.firstName === fact.value.firstName && guest.lastName === fact.value.lastName && guest.age === fact.value.age && guest.profileId === fact.value.profileId)) fail('mismatch', 'guest');
    } else if (fact.kind === 'reservation_reference') {
      fail('missing', 'reservation_lookup');
    }
  }
  if (rooms !== undefined && facts.some(fact => fact.kind === 'guest')) {
    for (const room of rooms) for (const guest of room.guests) {
      if (!facts.some(fact => fact.kind === 'guest' && fact.id === guest.factRef) && !originalGuestFacts.some(fact => fact.factRef === guest.factRef && fact.groupId === room.groupId && fact.roomIndex === room.roomIndex && fact.firstName === guest.firstName && fact.lastName === guest.lastName && fact.age === guest.age && fact.profileId === guest.profileId)) fail('missing', 'guest_source');
    }
  }
}
export type SourceOfferFactAttestation = { factDigests: Record<string, string> };
/** Opaque imported/override sources require exact server-attested facts; totals do not entail stay scope. */
export function assertSourceOfferFactAttestation(facts: readonly ValidatedDocumentFact[], attestation?: SourceOfferFactAttestation | null): void {
  const scoped = facts.filter(fact => fact.kind !== 'rate_claim' && fact.kind !== 'payment_claim');
  if (!scoped.length) return;
  const digests = attestation?.factDigests;
  if (!digests || typeof digests !== 'object' || Array.isArray(digests)) return fail('missing', 'attestation');
  if (Object.keys(digests).length !== scoped.length || scoped.some(fact => !Object.hasOwn(digests, fact.id))) fail('missing', 'attestation');
  if (scoped.some(fact => fact.verification !== 'text_verified' || digests[fact.id] !== quoteDigest(fact))) fail('mismatch', 'attestation');
}
