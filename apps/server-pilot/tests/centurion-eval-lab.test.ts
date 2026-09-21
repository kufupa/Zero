import { describe, expect, it } from 'vitest';
import {
  assignThreadOutcome,
  buildCallGraph,
  EVAL_TOOL_CATALOGUE,
  highlightSpans,
  isUsefulEvalAttachment,
  locateQuoteSpans,
  mergeStaffUsedWithoutTouchingNeeded,
  normalizeGoldQuote,
  harvestStayDates,
  splitStayAsks,
  coerceRoomQty,
  rehydrateMailText,
  stripQuotedHistory,
  NEEDED_TOOL_CLUSTERS,
  NEEDED_TOOL_CONTRACTS,
  parseNeededTools,
  parseOccupancyFromBody,
  sortRequiredFirst,
  THREAD_OUTCOMES,
  type ThreadOutcome,
} from '../src/ops/centurion-eval-lab.js';

describe('centurion eval lab parsers', () => {
  it('exposes the mutually exclusive threadOutcome enum', () => {
    expect(THREAD_OUTCOMES).toEqual([
      'gold_human',
      'gold_channel_auto',
      'gold_pairing_miss',
      'other_desk',
      'no_reply_owed',
      'window_cutoff',
      'ingest_recovered',
      'true_gap',
    ]);
  });

  it('prefers human gold over unanswered flags', () => {
    expect(
      assignThreadOutcome({
        unanswered: true,
        writeStateIndependent: 'still_needed',
        hasHumanGold: true,
      }),
    ).toBe('gold_human');
  });

  it('treats skipped channel-auto gold on the thread as a response', () => {
    expect(
      assignThreadOutcome({
        unanswered: true,
        writeStateIndependent: 'still_needed',
        hasChannelAutoGold: true,
      }),
    ).toBe('gold_channel_auto');
  });

  it('uses pairing miss when a later or sibling outbound exists', () => {
    expect(
      assignThreadOutcome({
        unanswered: true,
        hasLaterOutbound: true,
      }),
    ).toBe('gold_pairing_miss');
    expect(
      assignThreadOutcome({
        unanswered: true,
        hasSiblingGold: true,
      }),
    ).toBe('gold_pairing_miss');
  });

  it('labels other-desk before true_gap', () => {
    expect(
      assignThreadOutcome({
        unanswered: true,
        otherDesk: 'penny',
      }),
    ).toBe('other_desk');
  });

  it('does not copy unanswered into still-needed / true_gap when no reply is owed', () => {
    expect(
      assignThreadOutcome({
        unanswered: true,
        writeStateIndependent: 'still_needed',
        noReplyOwed: true,
      }),
    ).toBe('no_reply_owed');
  });

  it('marks window cutoff and parse-failure ingest separately from true_gap', () => {
    expect(assignThreadOutcome({ unanswered: true, windowCutoff: true })).toBe('window_cutoff');
    expect(assignThreadOutcome({ unanswered: true, parseFailure: true })).toBe('ingest_recovered');
  });

  it('only returns true_gap when nothing else explains a missing Centurion gold', () => {
    expect(assignThreadOutcome({ unanswered: true })).toBe('true_gap');
    expect(assignThreadOutcome({})).toBe('true_gap');
  });

  it('keeps PDF and spreadsheet attachments and drops jpeg/png/gif', () => {
    expect(
      isUsefulEvalAttachment({ contentType: 'application/pdf', filename: 'rooming.pdf', byteSize: 12_000 }),
    ).toBe(true);
    expect(
      isUsefulEvalAttachment({
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'list.xlsx',
        byteSize: 8_000,
      }),
    ).toBe(true);
    expect(isUsefulEvalAttachment({ contentType: 'image/jpeg', filename: 'scan.jpg', byteSize: 400_000 })).toBe(
      false,
    );
    expect(isUsefulEvalAttachment({ contentType: 'image/png', filename: 'logo.png', byteSize: 2_000 })).toBe(
      false,
    );
    expect(
      isUsefulEvalAttachment({ contentType: 'application/pdf', filename: 'signature-logo.pdf', byteSize: 3_000 }),
    ).toBe(false);
  });

  it('parses occupancy from pax/people words and ignores for-N nights and years', () => {
    expect(parseOccupancyFromBody('please book 12 pax 3 nights')).toEqual({ paxTotal: 12, source: 'pax_word' });
    expect(parseOccupancyFromBody('stay for 6 nights in 2026')).toEqual({ paxTotal: null, source: 'unknown' });
    expect(parseOccupancyFromBody('2 adults 1 child')).toEqual({ paxTotal: 3, source: 'adults_children' });
  });

  it('sorts JSON Schema required keys first', () => {
    expect(sortRequiredFirst({ bedType: {}, arrival: {}, nights: {} }, ['arrival', 'nights'])).toEqual([
      'arrival',
      'nights',
      'bedType',
    ]);
  });

  it('wraps inbound spans in blue marks and gold spans in gold marks', () => {
    const text = 'book 12 Oct for Jane';
    const html = highlightSpans(
      text,
      [
        { field: 'arrival', start: 5, end: 11, side: 'inbound' },
        { field: 'guest', start: 16, end: 20, side: 'inbound' },
      ],
      'inbound',
    );
    expect(html).toContain('lab-span-inbound');
    expect(html).toContain('data-field="arrival"');
    expect(html).toContain('12 Oct');
  });
});

describe('neededCount contracts', () => {
  it('covers every catalogue tool in floor/ceiling maps', () => {
    const { floor, ceiling } = parseNeededTools('hello');
    expect(EVAL_TOOL_CATALOGUE).toHaveLength(27);
    expect(Object.keys(NEEDED_TOOL_CONTRACTS).sort()).toEqual([...EVAL_TOOL_CATALOGUE].sort());
    const clustered = Object.values(NEEDED_TOOL_CLUSTERS).flat();
    expect(new Set(clustered).size).toBe(27);
    for (const tool of EVAL_TOOL_CATALOGUE) {
      expect(floor).toHaveProperty(tool);
      expect(ceiling).toHaveProperty(tool);
      expect(typeof floor[tool]).toBe('boolean');
      expect(typeof ceiling[tool]).toBe('boolean');
    }
  });

  it('tags cancel on cancel/release/no-show and not on a new book ask', () => {
    expect(parseNeededTools('please cancel reservation 123456').floor.hms_cancel_reservation).toBe(true);
    expect(parseNeededTools('kindly release the room for Smith').floor.hms_cancel_reservation).toBe(true);
    expect(parseNeededTools('guest is a no-show tonight').floor.hms_cancel_reservation).toBe(true);
    expect(parseNeededTools('please book these dates for two adults').floor.hms_cancel_reservation).toBe(false);
  });

  it('tags create on book-asks under 10 pax and not on quote-only or OTA', () => {
    expect(parseNeededTools('please book 2 adults 12 Oct').floor.hms_create_reservation).toBe(true);
    expect(parseNeededTools('kindly quote availability for 12 Oct').floor.hms_create_reservation).toBe(false);
    expect(parseNeededTools('kindly quote availability for 12 Oct').floor.hms_quote_stay).toBe(true);
    expect(parseNeededTools('SynXis new booking already created in channel').floor.hms_create_reservation).toBe(
      false,
    );
  });

  it('routes pax>=10 to group_block not individual create', () => {
    const parsed = parseNeededTools('please book 12 pax 3 nights');
    expect(parsed.floor.hms_create_reservation).toBe(false);
    expect(parsed.floor.hms_group_block_read).toBe(true);
  });

  it('does not tag stay writes on thanks/FYI/OTA-already-created', () => {
    const thanks = parseNeededTools('thank you, kindly received');
    expect(thanks.floor.hms_create_reservation).toBe(false);
    expect(thanks.floor.hms_amend_reservation).toBe(false);
    expect(thanks.floor.hms_cancel_reservation).toBe(false);
    expect(thanks.floor.hms_quote_stay).toBe(false);
  });

  it('tags amend, money, docs, and context from explicit asks', () => {
    expect(parseNeededTools('please amend the departure date').floor.hms_amend_reservation).toBe(true);
    expect(parseNeededTools('please send the folio and invoice').floor.hms_read_folio).toBe(true);
    expect(parseNeededTools('please send the folio and invoice').floor.hms_generate_invoice).toBe(true);
    expect(parseNeededTools('refund the prepayment').floor.hms_refund).toBe(true);
    expect(parseNeededTools('proof of payment attached, kindly post').floor.hms_post_payment).toBe(true);
    expect(parseNeededTools('email the folio to accounts').floor.hms_email_folio).toBe(true);
    expect(parseNeededTools('please send confirmation and proforma').floor.hms_send_reservation_confirmation).toBe(
      true,
    );
    expect(parseNeededTools('please send confirmation and proforma').floor.hms_generate_confirmation_proforma).toBe(
      true,
    );
    expect(parseNeededTools('quote document / quotation PDF').floor.hms_generate_quote_document).toBe(true);
    expect(parseNeededTools('see attached voucher PDF').floor.mail_read_artifact).toBe(true);
    expect(parseNeededTools('see attached voucher PDF').floor.hms_attach_guest_stay_document).toBe(true);
    expect(parseNeededTools('please send with attachments').floor['mail.send_with_attachments']).toBe(true);
    expect(parseNeededTools('list existing documents on the stay').floor.hms_list_documents).toBe(true);
    expect(parseNeededTools('list existing documents on the stay').floor.documents_list_existing).toBe(true);
    expect(parseNeededTools('read the existing tax invoice on file').floor.documents_read_existing).toBe(true);
    expect(parseNeededTools('company account billing to ABC Corp').floor.hms_company_account_read).toBe(true);
    expect(parseNeededTools('conference event BEO in the ballroom').floor.hms_event_read).toBe(true);
    expect(parseNeededTools('what is the parking policy').floor.property_read_knowledge).toBe(true);
    expect(parseNeededTools('SynXis channel manager notification').floor.mail_parse_channel_payload).toBe(true);
    expect(parseNeededTools('did we already email the guest from HMS').floor.hms_sent_email_audit).toBe(true);
    expect(parseNeededTools('add a trace / special request note').floor.hms_read_notes_traces).toBe(true);
  });

  it('implies find/read when a write has no confirmation number, not on every mail', () => {
    const cancelNoConf = parseNeededTools('please cancel Smith arrival 12 Oct');
    expect(cancelNoConf.floor.hms_cancel_reservation).toBe(true);
    expect(cancelNoConf.floor.hms_find_reservation).toBe(false);
    expect(cancelNoConf.ceiling.hms_find_reservation).toBe(true);
    expect(cancelNoConf.ceiling.hms_read_reservation).toBe(true);
    const cancelWithConf = parseNeededTools('please cancel confirmation 22883438');
    expect(cancelWithConf.ceiling.hms_find_reservation).toBe(false);
    const thanks = parseNeededTools('thank you, well received');
    expect(thanks.ceiling.hms_find_reservation).toBe(false);
  });

  it('uses attachment text for occupancy group routing', () => {
    const parsed = parseNeededTools('please book the attached rooming list', {
      attachmentText: 'guest list 15 pax',
    });
    expect(parsed.floor.hms_create_reservation).toBe(false);
    expect(parsed.floor.hms_group_block_read).toBe(true);
  });
});

describe('gold-oracle spans and staff-used freeze', () => {
  it('locates first exact quote in the full body and skips misses without inventing offsets', () => {
    const body = 'Please quote 12 Oct to 14 Oct for Jane Smith confirmation 22883438';
    const { spans, unresolved } = locateQuoteSpans(body, [
      { field: 'arrival', side: 'inbound', quote: '12 Oct' },
      { field: 'guestName', side: 'inbound', quote: 'Jane Smith' },
      { field: 'rateCode', side: 'inbound', quote: 'BAR-NIGHTLY' },
    ]);
    expect(spans).toEqual([
      { field: 'arrival', start: 13, end: 19, side: 'inbound' },
      { field: 'guestName', start: 34, end: 44, side: 'inbound' },
    ]);
    expect(unresolved).toEqual([{ field: 'rateCode', reason: 'not_in_body' }]);
  });

  it('aliases text to quote so true_gap schema drift still locates', () => {
    const body = 'Group of 12 arriving 12 Oct';
    const { spans, unresolved } = locateQuoteSpans(body, [
      { field: 'arrival', side: 'inbound', text: '12 Oct' },
    ]);
    expect(spans).toEqual([{ field: 'arrival', start: 21, end: 27, side: 'inbound' }]);
    expect(unresolved).toEqual([]);
  });

  it('classifies empty quote, empty body, bad field, and whole-body dumps without inventing offsets', () => {
    const body = 'Short stay note';
    const { spans, unresolved } = locateQuoteSpans(body, [
      { side: 'inbound', text: 'stay' },
      { field: 'arrival', side: 'inbound', quote: '' },
      { field: 'payment', side: 'inbound', quote: 'paid' },
      { field: 'amount', side: 'inbound', quote: body },
      { field: 'guestName', side: 'inbound', quote: 'x'.repeat(400) },
    ]);
    expect(spans).toEqual([]);
    expect(unresolved).toEqual([
      { field: null, reason: 'bad_field' },
      { field: 'arrival', reason: 'empty_quote' },
      { field: 'payment', reason: 'bad_field' },
      { field: 'amount', reason: 'whole_body' },
      { field: 'guestName', reason: 'whole_body' },
    ]);
  });

  it('marks empty_body when the search text is missing', () => {
    const { spans, unresolved } = locateQuoteSpans('', [
      { field: 'arrival', side: 'inbound', quote: '12 Oct' },
    ]);
    expect(spans).toEqual([]);
    expect(unresolved).toEqual([{ field: 'arrival', reason: 'empty_body' }]);
  });

  it('rehydrates empty lab text from the snapshot body', () => {
    expect(rehydrateMailText('', 'Full inbound from snapshot')).toBe('Full inbound from snapshot');
    expect(rehydrateMailText('already here', 'snapshot')).toBe('already here');
  });

  it('rejects one-character quotes and strips quoted gold history', () => {
    const { spans, unresolved } = locateQuoteSpans('book a room please', [
      { field: 'status', side: 'inbound', quote: 'a' },
      { field: 'guestName', side: 'inbound', quote: 'room' },
    ]);
    expect(spans).toEqual([{ field: 'guestName', start: 7, end: 11, side: 'inbound' }]);
    expect(unresolved).toEqual([{ field: 'status', reason: 'empty_quote' }]);
    const stripped = stripQuotedHistory('Thanks.\n\nFrom: Desk\nSubject: FW: CIDB\nPlease quote');
    expect(stripped).toContain('Thanks.');
    expect(stripped).not.toContain('From: Desk');
  });

  it('harvests Check-in/Check-out date tokens without labels', () => {
    expect(
      harvestStayDates('*\tCheck-in: 15 september\nCheck-out: 19/09/2026\nGOOD DAY'),
    ).toEqual({ arrival: '15 september', departure: '19/09/2026' });
    expect(harvestStayDates('no dates here')).toEqual({});
  });

  it('splits Arrive/Depart/Rooms blocks and rejects year roomQty', () => {
    const asks = splitStayAsks(
      'Arrive : 15 September 2026\nDepart : 17 September 2026\nRooms : 2 Singles\nArrive : 15 September 2026\nDepart : 18 September 2026\nRooms : 7 Singles',
    );
    expect(asks.map((ask) => ask.roomQty)).toEqual([2, 7]);
    expect(asks[0]?.departure).toBe('17 September 2026');
    expect(asks[1]?.departure).toBe('18 September 2026');
    expect(coerceRoomQty('2026')).toBeUndefined();
    expect(splitStayAsks('quotation from 6th April to 10th April 2026')[0]).toMatchObject({
      arrival: '6th April',
      departure: '10th April 2026',
    });
  });

  it('normalizeGoldQuote copies text into quote and keeps enum fields', () => {
    expect(normalizeGoldQuote({ field: 'arrival', side: 'inbound', text: '12 Oct' })).toEqual({
      field: 'arrival',
      side: 'inbound',
      quote: '12 Oct',
    });
  });

  it('refuses to overwrite neededCount when merging staff-used freeze', () => {
    const needed = {
      hms_find_reservation: { neededCount: 16, threshold95: 'met' },
      hms_quote_stay: { neededCount: 184, threshold95: 'met' },
    };
    const staff = { hms_find_reservation: 164, hms_quote_stay: 90 };
    const merged = mergeStaffUsedWithoutTouchingNeeded(needed, staff);
    expect(merged.hms_find_reservation.neededCount).toBe(16);
    expect(merged.hms_quote_stay.neededCount).toBe(184);
    expect(merged.hms_find_reservation.staffUsedCount).toBe(164);
    expect(merged.hms_quote_stay.staffUsedCount).toBe(90);
    expect(needed.hms_find_reservation.neededCount).toBe(16);
  });

  it('marks find and read alwaysInStack even when ask count stays 16', () => {
    const graph = buildCallGraph({
      ask: { hms_find_reservation: 16, hms_read_reservation: 17, hms_quote_stay: 184 },
      staffUsed: { hms_find_reservation: 164, hms_read_reservation: 157, hms_quote_stay: 90 },
    });
    expect(graph.hms_find_reservation).toMatchObject({
      ask: 16,
      staffUsed: 164,
      alwaysInStack: true,
    });
    expect(graph.hms_read_reservation.alwaysInStack).toBe(true);
    expect(graph.hms_quote_stay.alwaysInStack).toBe(false);
  });
});

describe('threadOutcome assignment is exhaustive', () => {
  it('never returns a string outside the enum', () => {
    const samples: ThreadOutcome[] = [
      assignThreadOutcome({ hasHumanGold: true }),
      assignThreadOutcome({ hasChannelAutoGold: true }),
      assignThreadOutcome({ hasLaterOutbound: true }),
      assignThreadOutcome({ otherDesk: 'kamala' }),
      assignThreadOutcome({ noReplyOwed: true }),
      assignThreadOutcome({ windowCutoff: true }),
      assignThreadOutcome({ parseFailure: true }),
      assignThreadOutcome({ unanswered: true }),
    ];
    for (const outcome of samples) {
      expect(THREAD_OUTCOMES).toContain(outcome);
    }
  });
});
