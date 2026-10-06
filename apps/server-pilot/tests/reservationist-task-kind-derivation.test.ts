import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {deriveReservationistTaskKinds,deriveReservationistAskSpans} from '../src/ai/worker.js';

describe('source task kinds for accommodation and existing-stay timing', () => {
  it.each([
    'Please confirm early check-in and late check-out for my upcoming stay. These requests are subject to availability. If there is an additional charge to guarantee late check-out, please let me know.',
    'Please advise the price for late check-out on my existing reservation.',
    'What is the cost of early check-in?',
    'Please advise late check-out\npricing and availability for my confirmed reservation.',
    'Please confirm late check-out. It is normally subject\nto availability.',
    'Please tell me the late check-out rate.',
    'Please advise the price for late check-out for my room.',
    'Please confirm early check-in subject to availability for our accommodation.',
  ])('keeps operational timing and conditional fees as questions: %s', text => {
    const kinds = deriveReservationistTaskKinds(text);
    expect(kinds).toContain('question');
    expect(kinds).not.toContain('quote');
    expect(kinds).not.toContain('new_booking');
  });

  it.each([
    'Please quote two rooms for our private family stay.',
    'Please advise room availability for two adults next weekend.',
    'What is the room price for two nights?',
    'Please supply contract rates for accommodation for our company.',
    'Please quote accommodation and advise the late check-out fee.',
    'Please advise the room price and the cost of late check-out.',
    'Please advise the late check-out fee and the room rates for a new stay.',
  ])('preserves an accommodation quotation obligation: %s', text => {
    expect(deriveReservationistTaskKinds(text)).toContain('quote');
  });

 it('preserves a direct private guest booking independently of quote wording', () => {
    expect(deriveReservationistTaskKinds('Please book a new room for our family from 12 to 14 October.')).toEqual(['new_booking']);
  });
  it.each(['Please reserve one room for one adult from 12 to 14 October 2026.','Kindly make a reservation for one adult tomorrow.','Please arrange accommodation for our delegation.'])('keeps explicit booking intent mandatory: %s',text=>{expect(deriveReservationistTaskKinds(text)).toContain('new_booking');});
  it('keeps explicit channel synchronization mandatory without creating a new booking',()=>{expect(deriveReservationistTaskKinds('Please synchronise this channel booking in your hotel system.')).toEqual(['channel_booking_sync']);});
  it('keeps proceed-to-book a new request unless an original offer is explicitly referenced',()=>{expect(deriveReservationistTaskKinds('Please proceed to book as below; and revert with invoice.')).toEqual(['new_booking']);expect(deriveReservationistTaskKinds('Thank you for the quote. Please proceed.')).toContain('acceptance');expect(deriveReservationistTaskKinds('Please proceed with the quoted offer.')).toContain('acceptance');});

 it('does not turn a request for an existing quotation into new pricing', () => {
    expect(deriveReservationistTaskKinds('Please resend the quotation Q-123.')).toEqual(['existing_document']);
  });
  it.each(['Could you provide a quote?','Please advise availability for 22 September and provide a quote?','Can you quote two rooms?'])('keeps a new pricing question as quote without a document obligation: %s',text=>{expect(deriveReservationistTaskKinds(text)).toEqual(['quote']);expect(deriveReservationistAskSpans(text,'m')).toEqual([]);});
  it('retains a distinct informational question beside requested prices',()=>{const text='Could you provide room rates and advise what room options are available?';expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);expect(deriveReservationistAskSpans(text,'m').map(a=>a.text)).toEqual(['room options']);});
  it('keeps a separate unfamiliar question in the same pricing sentence mandatory',()=>{const text='Could you quote a room and is the gym open?';expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);expect(deriveReservationistAskSpans(text,'m')).toHaveLength(1);});
  it('treats revised quote details as quote context while retaining explicit amendments',()=>{expect(deriveReservationistTaskKinds('We have a change in dates and numbers. Can I get a new quote for this?')).toEqual(['quote']);expect(deriveReservationistTaskKinds('Please amend the booking dates and quote the revised stay.')).toEqual(['quote','change']);expect(deriveReservationistTaskKinds('Please change arrival to 12 October.')).toContain('change');});
});

describe('current authored obligations preserve original source spans',()=>{
 it('keeps quote and policy inquiries distinct from cancellation actions, date labels and document mentions',()=>{
  const text='I request a quotation for a hotel reservation.\nCheck-in Date: 16 November\nCheck-out Date: 20 November\nCould you please provide your best available rates and advise what room options are available for these dates? Kindly include applicable taxes, breakfast options, and cancellation policy details.\nI look forward to your quotation.';
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);expect(deriveReservationistAskSpans(text,'m').map(a=>a.text)).toEqual(['room options','taxes','breakfast options','cancellation policy']);
 });
 it.each(['Please advise the cancellation policy.','What is your cancellation fee?','Please send the cancellation terms.'])('does not prepare cancellation from policy nouns: %s',text=>{expect(deriveReservationistTaskKinds(text)).not.toContain('cancel_request');expect(deriveReservationistTaskKinds(text)).toContain('question');});
 it.each(['Please cancel my booking.','I request cancellation of reservation ABC123.','Please process the cancellation for my stay.'])('retains explicit cancellation action: %s',text=>{expect(deriveReservationistTaskKinds(text)).toContain('cancel_request');});
 it('binds only requested document nouns to their original request clause',()=>{const text='Please send a receipt. I look forward to your quotation.';expect(deriveReservationistAskSpans(text,'m').map(a=>a.text)).toEqual(['receipt']);});
 it('retains a directly requested stay-date lookup but ignores check-in date labels',()=>{expect(deriveReservationistAskSpans('Hotel reservation.\nCheck-in Date: 16 November\nCheck-out Date: 20 November','m')).toEqual([]);expect(deriveReservationistAskSpans('Please verify arrival and departure dates for reservation ABC123.','m').map(a=>a.text)).toEqual(['arrival and departure dates']);});
 const current='Hi team,\r\n\r\nPlease book two rooms for 6 to 7 October.\r\nPlease bill back all charges to our corporate account.\r\n';
 const old='We accept your quotation. Please change the arrival. Can you send the payment link?';
 it.each([
  `From: Reservations <hotel@example.test>\nSent: Monday\n${old}`,
  `Sent: Monday\nFrom: Reservations <hotel@example.test>\n${old}`,
  `On Monday, Reservations <hotel@example.test> wrote:\n${old}`,
  `On Monday, Reservations\n<hotel@example.test>\nwrote:\n${old}`,
  `-----Original Message-----\n${old}`,
  `Begin forwarded message:\n${old}`,
  `> ${old}`,
 ])('does not reactivate quoted acceptance, changes or questions: %s',history=>{
  const text=current+'\r\n'+history;
  expect(deriveReservationistTaskKinds(text)).toEqual(['new_booking','question']);
  expect(deriveReservationistAskSpans(text,'m')).toEqual([{sourceId:'message:m',start:text.indexOf('bill back'),end:text.indexOf('corporate account')+'corporate account'.length,text:'bill back all charges to our corporate account'}]);
 });
 it.each(['Warm regards,','Kind regards,','-- ','This e-mail and any attachments thereto may contain confidential information.'])('does not derive obligations from a signature/footer: %s',footer=>{
  const text='Please book one room.\n\n'+footer+'\nNo responsibility is accepted for any late arrival or change.\nPlease check the payment policy?';
  expect(deriveReservationistTaskKinds(text)).toEqual(['new_booking']);expect(deriveReservationistAskSpans(text,'m')).toEqual([]);
 });
 it.each(['Thank you and kind regards','We respect your privacy and acknowledge that this email will contain personal details.'])('retains the original authored prefix before footer marker: %s',footer=>{const text='Please quote two rooms.\n'+footer+'\nData Protection Policy and payment disclaimer.';expect(deriveReservationistTaskKinds(text)).toEqual(['quote']);expect(deriveReservationistAskSpans(text,'m')).toEqual([]);});
 it('retains every mixed current quote and question with original CRLF offsets and hash',()=>{
  const text='\r\nPlease quote accommodation.\r\nIs parking available?\r\nWhat time is the shuttle?\r\n\r\nFrom: Prior guest\r\nWe accept the quote. What is the payment policy?';
  const digest=createHash('sha256').update(text).digest('hex');
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);
  const asks=deriveReservationistAskSpans(text,'m');expect(asks.map(a=>a.text)).toEqual(['parking','shuttle']);
  for(const ask of asks){expect(text.slice(ask.start,ask.end)).toBe(ask.text);expect(ask.end).toBeLessThan(text.indexOf('From:'));}
  expect(createHash('sha256').update(text).digest('hex')).toBe(digest);
 });
 it('does not hide asks under ordinary prose using history-like words',()=>{
  const text='Please quote two rooms. From our company, please advise the parking policy?\nWe arrive on Monday.';
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);expect(deriveReservationistAskSpans(text,'m').map(a=>a.text)).toEqual(['parking','policy']);
 });
 it.each(['Please confirm that this booking is cancelled','Has my reservation been cancelled?','Please verify whether the booking is confirmed.','Have you made the reservation?'])('keeps an explicit completed-state inquiry as a mandatory read: %s',text=>{
  expect(deriveReservationistTaskKinds(text)).toEqual(['question']);const asks=deriveReservationistAskSpans(text,'m');expect(asks).toHaveLength(1);expect(text.slice(asks[0]!.start,asks[0]!.end)).toBe(asks[0]!.text);
 });
 it.each([['Please cancel my booking.',['cancel_request']],['Please book a new room.',['new_booking']],['Please accept the quotation.',['quote','acceptance']],['Please confirm that this booking is cancelled. Please book a new room.',['new_booking','question']],['Please cancel my booking and confirm its reservation status.',['cancel_request','question']],['Please confirm that this booking is cancelled and book a new room.',['new_booking','question']]])('retains actual actions beside status inquiries: %s',(text,kinds)=>{
  expect(deriveReservationistTaskKinds(text as string)).toEqual(kinds);
 });
});


describe('commercial intent uses the requested object',()=>{
 it('keeps a direct booking plus card-payment question independent of incidental website costs',()=>{
  const text='Good day.\nI need to book a four night stay at your hotel for my wife and I for\nOctober 15 to 18 this year. I wanted to do it on your own internet site to\ncut out middlemen costs, but it has no facility to accept card payment via\nmy debit card. What do you suggest I do? I had joined your\nmembership rewards offer while I was on the site.';
  expect(deriveReservationistTaskKinds(text)).toEqual(['new_booking','question']);
 });
 it.each(['Please book a room. Your site cannot accept my credit card payment. What should I do?','Please reserve two rooms. I want to avoid agency costs. Do you accept debit cards?','Please make a booking. The site accepts card payment, but mine was declined. Can you help?'])('does not turn payment acceptance or incidental costs into offer acceptance/pricing: %s',text=>{expect(deriveReservationistTaskKinds(text)).toEqual(['new_booking','question']);});
 it.each(['I accept your quotation.','We have accepted the offer.','Please accept this booking.','Thank you for the quote. We accept.'])('preserves explicit commercial acceptance: %s',text=>{expect(deriveReservationistTaskKinds(text)).toContain('acceptance');});
 it.each(['What is the cost of two rooms?','Please advise accommodation costs.','Please supply room rates.','Please book a room and quote the stay cost.'])('preserves a genuine accommodation pricing request: %s',text=>{expect(deriveReservationistTaskKinds(text)).toContain('quote');});
 it.each(['Thank you for the quote. Do you accept card payment?','Thank you for the quote. My card payment was accepted.'])('keeps payment acceptance distinct even when an original quote is mentioned: %s',text=>{expect(deriveReservationistTaskKinds(text)).not.toContain('acceptance');});
});


describe('generic question spans retain exact authored boundaries',()=>{
 it.each(['Earlier context. What do you suggest I do?','Earlier context.  Can you help?','Earlier context.\r\n\tWhat should happen next?'])('trims separator whitespace while preserving original offsets: %s',text=>{
  const asks=deriveReservationistAskSpans(text,'m');expect(asks).toHaveLength(1);const ask=asks[0]!;expect(ask.text).toBe(ask.text.trim());expect(text.slice(ask.start,ask.end)).toBe(ask.text);expect(ask.start).toBe(text.indexOf(ask.text));
 });
 it('retains a trailing confirmation when intervening context introduces a second guest target',()=>{
  const text='Can I confirm you made two room reservations?\nI received my confirmation, but I did not get a confirmation letter for another guest.\nPlease confirm?';
  expect(deriveReservationistTaskKinds(text)).toEqual(['question']);const asks=deriveReservationistAskSpans(text,'m');expect(asks.map(a=>a.text)).toEqual(['Can I confirm you made two room reservations?','Please confirm?']);
 });
 it('retains separate explicit confirmation subjects',()=>{
  const text='Have you made the reservation?\nPlease confirm the airport transfer?';const asks=deriveReservationistAskSpans(text,'m');expect(asks.map(a=>a.text)).toEqual(['Have you made the reservation?','transfer']);for(const ask of asks)expect(text.slice(ask.start,ask.end)).toBe(ask.text);
 });
});


describe('returned signed offer is acceptance rather than new pricing',()=>{
 it.each(['Please see attached signed quote.','Please find the signed quotation attached.','We return the signed offer attached.','Attached is the signed quote.'])('keeps submitted original offer intent: %s',text=>{expect(deriveReservationistTaskKinds(text)).toEqual(['acceptance']);expect(deriveReservationistAskSpans(text,'m')).toEqual([]);});
 it('retains separately requested new pricing beside the signed original',()=>{expect(deriveReservationistTaskKinds('Please see attached signed quote. Please quote an additional room.')).toEqual(['quote','acceptance']);});
 it('retains separately requested amendment beside the signed original',()=>{expect(deriveReservationistTaskKinds('Please see attached signed quote. Please amend the arrival date.')).toEqual(['acceptance','change']);});
 it.each(['We have not attached a signed quote.','Please send a quotation for me to sign.','We will return the signed quote later.','Please see attached unsigned quotation.'])('does not establish submitted acceptance from %s',text=>{expect(deriveReservationistTaskKinds(text)).not.toContain('acceptance');});
});


describe('requested quotation benefits remain independent original obligations',()=>{
 it.each([
  ['Please quote one room. Please explain the accommodation benefits.','accommodation benefits'],
  ['Please quote rooms and advise any hotel benefits you can offer.','hotel benefits'],
  ['We would appreciate your best competitive rates for our procurement and any\nvalue-added inclusions or benefits you may be able to extend for the above\nrequirement.','value-added inclusions or benefits'],
 ])('binds the requested benefits without inventing approval: %s',(text,topic)=>{
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote','question']);
  const asks=deriveReservationistAskSpans(text,'m');expect(asks).toHaveLength(1);expect(asks[0].text).toBe(topic);
  expect(text.slice(asks[0].start,asks[0].end)).toBe(topic);
 });
 it.each([
  'Please quote one room. We advertise hotel benefits worldwide.',
  'Please quote one room. Do not provide hotel benefits.',
  'Please quote one room.\nRegards\nPlease explain our hotel benefits.',
  'Please quote one room.\nFrom: Prior staff\nPlease explain the accommodation benefits.',
  'Please quote one room. Please explain employee benefits.',
  'Please quote one room and explain employee benefits.',
  'Please quote one room.\n> Please explain the accommodation benefits.',
  'Please quote one room.\nWe advertise hotel benefits you can enjoy worldwide.',
 ])('does not promote incidental, excluded or foreign benefits to obligations: %s',text=>{
  expect(deriveReservationistTaskKinds(text)).toEqual(['quote']);expect(deriveReservationistAskSpans(text,'m')).toEqual([]);
 });
});
