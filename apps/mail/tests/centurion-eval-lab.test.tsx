/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('virtua', async () => {
  const { createElement, forwardRef } = await import('react');
  return {
    VList: forwardRef(
      (props: { count: number; children: (index: number) => unknown }, _ref) =>
        createElement(
          'div',
          { 'data-testid': 'lab-vlist' },
          Array.from({ length: props.count }, (_, index) => props.children(index)),
        ),
    ),
  };
});

import { CenturionEvalLab } from '../components/lab/centurion-eval-lab';
import {
  filterLabRows,
  highlightSpans,
  interestingFacts,
  isMailFolderRoute,
  LAB_FREEZE_TOOL_IDS,
  labReviewSchemaFor,
  normalizeDateSpanQuote,
  projectLabFills,
  sortRequiredFirst,
  splitStayAsks,
  coerceRoomQty,
  resolveProposedActions,
  proposedActionFacts,
  enrichHitlProposed,
  occupancyFromText,
  spansForPaint,
  stripQuotedHistory,
  SYNTHETIC_LAB_INDEX,
  THREAD_OUTCOME_COPY,
  valuesToSpans,
  type LabRow,
} from '../lib/lab/centurion-eval';
import { loadCenturionLabIndex, resetLabIndexCache } from '../lib/lab/load-centurion-index';

afterEach(() => {
  cleanup();
  resetLabIndexCache();
  vi.unstubAllGlobals();
});

describe('centurion eval lab', () => {
  it('registers a /lab/centurion route and does not touch /mail folders', () => {
    const routes = readFileSync(join(process.cwd(), 'app/routes.ts'), 'utf8');
    const mailFolder = readFileSync(join(process.cwd(), 'app/(routes)/mail/[folder]/page.tsx'), 'utf8');
    const labLayout = readFileSync(join(process.cwd(), 'app/(routes)/lab/layout.tsx'), 'utf8');
    const navigation = readFileSync(join(process.cwd(), 'config/navigation.ts'), 'utf8');
    const labUi = readFileSync(join(process.cwd(), 'components/lab/centurion-eval-lab.tsx'), 'utf8');
    const loader = readFileSync(join(process.cwd(), 'lib/lab/load-centurion-index.ts'), 'utf8');
    expect(routes).toContain("prefix('/lab'");
    expect(routes).toContain("route('/centurion'");
    expect(routes).not.toMatch(/mail\/\[folder\].*lab/);
    expect(isMailFolderRoute('/lab/centurion')).toBe(false);
    expect(isMailFolderRoute('/mail/inbox')).toBe(true);
    expect(mailFolder).not.toContain('CenturionEvalLab');
    expect(labLayout).toContain('AppSidebar');
    expect(labLayout).toContain('LabIndexProvider');
    expect(labLayout).toContain('export function HydrateFallback');
    expect(labLayout).not.toContain('loadCenturionLabIndex');
    expect(navigation).toContain("path: '/lab'");
    expect(navigation).toContain("url: '/lab/centurion'");
    expect(navigation).toContain("url: '/mail/inbox'");
    expect(navigation).toContain("title: 'Tools'");
    expect(navigation).toContain('LAB_FREEZE_TOOL_IDS.map');
    expect(labUi).toContain("from 'virtua'");
    expect(labUi).toContain('<VList');
    expect(labUi).toContain('whitespace-pre-wrap');
    expect(labUi).not.toContain('ExtractBlock');
    expect(labUi).toContain('Already done');
    expect(labUi).toContain('needs_human');
    expect(labUi).toContain('lg:h-[calc(100dvh-8px)]');
    expect(labUi).toContain('sticky top-0');
    expect(loader).not.toMatch(/source:\s*'synthetic'/);
    expect(loader).not.toMatch(/return SYNTHETIC_LAB_INDEX/);
    const root = readFileSync(join(process.cwd(), 'app/root.tsx'), 'utf8');
    const labPage = readFileSync(join(process.cwd(), 'app/(routes)/lab/centurion/page.tsx'), 'utf8');
    const toolPage = readFileSync(join(process.cwd(), 'app/(routes)/lab/centurion/[tool]/page.tsx'), 'utf8');
    expect(root).toMatch(/^export function HydrateFallback/m);
    expect(labPage).not.toContain('loadCenturionLabIndex');
    expect(toolPage).not.toContain('loadCenturionLabIndex');
  });

  it('shows a loading shell instead of a blank page or synthetic mail when the index is still fetching', () => {
    render(<CenturionEvalLab />);
    expect(screen.getByTestId('lab-index-loading')).toBeTruthy();
    expect(screen.queryByTestId('lab-index-error')).toBeNull();
    expect(screen.queryByText('Quote for 12 Oct')).toBeNull();
  });

  it('renders synthetic inbound pink spans, blue gold, channel-auto chip, required stars, and interesting facts', () => {
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} />);
    expect(screen.getByTestId('centurion-eval-lab')).toBeTruthy();
    expect(screen.getByTestId('lab-tool-list').textContent).toContain('hms_quote_stay');
    const inboundHtml = highlightSpans(
      SYNTHETIC_LAB_INDEX.rows[0]!.inbound.textBody,
      SYNTHETIC_LAB_INDEX.rows[0]!.spans,
      'inbound',
    );
    expect(inboundHtml).toContain('lab-span-action-0');
    const goldHtml = highlightSpans(
      SYNTHETIC_LAB_INDEX.rows[0]!.gold!.textBody,
      SYNTHETIC_LAB_INDEX.rows[0]!.spans,
      'gold',
    );
    expect(goldHtml).toContain('lab-span-gold-auto');
    expect(screen.getByTestId('lab-gold-auto')).toBeTruthy();
    expect(screen.getByTestId('lab-gold-auto').className).not.toMatch(/bg-pink-50/);
    expect(screen.getByTestId('channel-auto-chip').textContent).toContain('channelAuto');
    expect(screen.getByTestId('interesting-fact').textContent).toMatch(/bedType|rateCode/);
    expect(screen.getByTestId('lab-io-pane').textContent).toContain('arrival *');
    expect(sortRequiredFirst({ bedType: {}, arrival: {} }, ['arrival'])[0]).toBe('arrival');
    expect(document.querySelector('style')?.textContent).toMatch(/\.lab-span-action-0 \{ background: #fbbf24/);
    expect(document.querySelector('style')?.textContent).toMatch(/\.lab-span-gold \{ background: #93c5fd/);
    expect(screen.getByTestId('lab-schema-input').className).toContain('lab-schema-request');
    expect(screen.getByTestId('lab-schema-staff-did').className).toContain('lab-schema-response');
  });

  it('shows true_gap copy when gold is empty, never "unanswered"', () => {
    const gapOnly = { generated: 'synthetic', rows: [SYNTHETIC_LAB_INDEX.rows[1]!] };
    render(<CenturionEvalLab index={gapOnly} />);
    expect(screen.getByTestId('lab-empty-gold')).toBeTruthy();
    expect(screen.getByTestId('thread-outcome-copy').textContent).toBe(THREAD_OUTCOME_COPY.true_gap);
    expect(screen.getByTestId('thread-outcome-copy').textContent).not.toMatch(/unanswered/i);
  });

  it('lists neededCount on the tool filter, not tagCount', () => {
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} />);
    expect(screen.getByTestId('lab-tool-list').textContent).toMatch(/hms_quote_stay\s+1/);
    expect(screen.getByTestId('lab-tool-list').textContent).not.toMatch(/tagCount|family|still_needed|outbound 505/i);
    expect(filterLabRows(SYNTHETIC_LAB_INDEX, { tool: 'hms_quote_stay' }).map((row) => row.inboundId)).toEqual([
      'syn-blue-pink',
      'syn-staff-only-quote',
    ]);
  });

  it('shows staffUsedCount next to neededCount and schema pane follows the selected tool', () => {
    const index = {
      ...SYNTHETIC_LAB_INDEX,
      neededCounts: [
        { tool: 'hms_quote_stay', neededCount: 184, staffUsedCount: 90 },
        { tool: 'hms_find_reservation', neededCount: 16, staffUsedCount: 164 },
      ],
    };
    render(<CenturionEvalLab index={index} />);
    expect(screen.getByTestId('lab-tool-list').textContent).toMatch(/hms_quote_stay\s+184\s+90/);
    expect(screen.getByTestId('lab-tool-list').textContent).toMatch(/hms_find_reservation\s+16\s+164/);
    fireEvent.click(screen.getByTestId('tool-hms_find_reservation'));
    expect(screen.getByTestId('lab-io-pane').textContent).toContain('confirmationNumber');
    expect(screen.getByTestId('lab-io-pane').textContent).not.toContain('query *');
    expect(screen.getByTestId('lab-io-pane').textContent).not.toContain('arrival *');
  });

  it('filters HITL true_gap rows via outcome chip and facets without mail folders', () => {
    expect(filterLabRows(SYNTHETIC_LAB_INDEX, { outcome: 'true_gap' }).map((row) => row.inboundId)).toEqual([
      'syn-true-gap',
    ]);
    expect(filterLabRows(SYNTHETIC_LAB_INDEX, { facet: 'travel_agent' }).map((row) => row.inboundId)).toEqual([
      'syn-blue-pink',
    ]);
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} />);
    fireEvent.click(screen.getByTestId('outcome-true_gap'));
    expect(screen.getByTestId('lab-thread-list').textContent).toContain('Where is my booking');
    expect(screen.getByTestId('lab-thread-list').textContent).not.toContain('Quote for 12 Oct');
    expect(screen.getByTestId('thread-outcome-copy').textContent).toBe(THREAD_OUTCOME_COPY.true_gap);
    expect(screen.getByTestId('lab-facet-chips').textContent).toContain('travel_agent');
    expect(isMailFolderRoute('/lab/centurion')).toBe(false);
  });

  it('registers a closed review schema for every freeze tool and never falls back to find query', () => {
    expect(LAB_FREEZE_TOOL_IDS).toHaveLength(27);
    for (const tool of LAB_FREEZE_TOOL_IDS) {
      const schema = labReviewSchemaFor(tool);
      expect(schema.title).toBeTruthy();
      expect(schema.input.properties).toBeTruthy();
      expect(schema.output.properties).toBeTruthy();
    }
    const create = labReviewSchemaFor('hms_create_reservation');
    expect(create.input.required).toEqual([
      'arrival',
      'departure',
      'adults',
      'sourceOfBusiness',
      'roomType',
      'ratePlan',
      'track',
      'firstName',
      'lastName',
    ]);
    expect(create.input.properties).not.toHaveProperty('boardBasis');
    expect(create.input.properties).not.toHaveProperty('guestName');
    expect(create.output.properties).toHaveProperty('mealPlan');
    const quote = labReviewSchemaFor('hms_quote_stay');
    expect(quote.input.properties).toHaveProperty('arrival');
    expect(quote.input.properties).toHaveProperty('departure');
    expect(quote.input.properties).not.toHaveProperty('candidateId');
    expect(quote.output.properties).not.toHaveProperty('candidateId');
    const find = labReviewSchemaFor('hms_find_reservation');
    expect(find.input.properties).toHaveProperty('confirmationNumber');
    expect(find.input.properties).toHaveProperty('guestName');
    expect(find.input.properties).toHaveProperty('arrival');
    expect(find.input.properties).toHaveProperty('departure');
    expect(find.input.properties).not.toHaveProperty('query');
    expect(find.input.properties).not.toHaveProperty('candidateId');
    const unknown = labReviewSchemaFor('not_a_real_tool');
    expect(Object.keys(unknown.input.properties ?? {})).toEqual([]);
    expect(Object.keys(unknown.output.properties ?? {})).toEqual([]);
    expect(unknown.input.properties).not.toHaveProperty('query');
  });

  it('projects inbound request into input and gold usedResult into output for the selected tool', () => {
    const quoteRow = SYNTHETIC_LAB_INDEX.rows[0]!;
    const quoteFills = projectLabFills(quoteRow, 'hms_quote_stay');
    expect(quoteFills.input.arrival).toBeTruthy();
    expect(quoteFills.output.rateCode).toBe('BAR');
    expect(quoteFills.input).not.toHaveProperty('rateCode');
    const findFromQuote = projectLabFills(quoteRow, 'hms_find_reservation');
    expect(findFromQuote.output).not.toHaveProperty('rateQuoted');
    expect(findFromQuote.output).not.toHaveProperty('rateCode');
    const gapRow = SYNTHETIC_LAB_INDEX.rows[1]!;
    const gapOut = projectLabFills(gapRow, 'hms_find_reservation');
    expect(gapOut.output).toEqual({});
    expect(gapOut.input.confirmationNumber).toBe('ABC123');
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} />);
    expect(screen.getByTestId('lab-schema-input').textContent).toMatch(/arrival/);
    expect(screen.getByTestId('lab-schema-staff-did').textContent).toMatch(/rateCode/);
    expect(screen.getByTestId('lab-schema-staff-did').textContent).toContain('BAR');
    cleanup();
    const gapOnly = { generated: 'synthetic', rows: [gapRow] };
    render(<CenturionEvalLab index={gapOnly} />);
    expect(screen.getByTestId('lab-schema-staff-did').textContent).toMatch(/No captured PMS response|∅/);
    expect(screen.getByTestId('lab-empty-gold')).toBeTruthy();
  });

  it('fails loud on a missing live index and never returns the synthetic fixture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const result = await loadCenturionLabIndex(new Request('http://zero.local/lab/centurion'));
    expect(result.source).toBe('error');
    expect(result).toMatchObject({ error: { status: 404 } });
    expect(result).not.toHaveProperty('index');
    render(<CenturionEvalLab error={{ status: 404, message: 'lab index HTTP 404' }} />);
    expect(screen.getByTestId('lab-index-error').textContent).toMatch(/404/);
    expect(screen.queryByText('Quote for 12 Oct')).toBeNull();
    expect(screen.queryByText('Where is my booking')).toBeNull();
  });

  it('includes ask-only and staffUsed-only rows in a tool folder and keeps lab off /mail', async () => {
    const routes = readFileSync(join(process.cwd(), 'app/routes.ts'), 'utf8');
    expect(routes).toMatch(/centurion\/:tool/);
    expect(isMailFolderRoute('/lab/centurion/hms_quote_stay')).toBe(false);
    await expect(loadCenturionLabIndex(new Request('http://zero.local/mail/inbox'))).rejects.toThrow(
      /must not mount under \/mail/,
    );
    expect(filterLabRows(SYNTHETIC_LAB_INDEX, { tool: 'hms_quote_stay' }).map((row) => row.inboundId)).toEqual([
      'syn-blue-pink',
      'syn-staff-only-quote',
    ]);
    expect(filterLabRows(SYNTHETIC_LAB_INDEX, { tool: 'hms_find_reservation' }).map((row) => row.inboundId)).toEqual([
      'syn-blue-pink',
      'syn-true-gap',
    ]);
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} selectedTool="hms_quote_stay" />);
    expect(screen.getByTestId('lab-thread-list').textContent).toContain('Quote for 12 Oct');
    expect(screen.getByTestId('lab-thread-list').textContent).toContain('Staff quoted without ask flag');
    expect(screen.getByTestId('lab-thread-list').textContent).not.toContain('Where is my booking');
    cleanup();
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} selectedTool="not_a_real_tool" />);
    expect(screen.getByTestId('lab-empty-tool')).toBeTruthy();
  });

  it('does not copy find Input dates into Find Output when usedResult echoes inbound', () => {
    const findSchema = labReviewSchemaFor('hms_find_reservation');
    expect(Object.keys(findSchema.output.properties ?? {})).toEqual([
      'confirmationNumber',
      'status',
      'roomType',
    ]);
    expect(findSchema.output.properties).not.toHaveProperty('arrival');
    expect(findSchema.output.properties).not.toHaveProperty('departure');
    const row: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[1]!,
      inbound: {
        subject: 'Request for Accommodation',
        textBody: 'Check in: 15/09/2026\nCheck out: 19/09/2026\nGOOD DAY',
      },
      gold: {
        id: 'syn-accom-gold',
        subject: 'RE: Request for Accommodation',
        textBody: 'Thank you. Please see attached quotation.',
        channelAuto: false,
      },
      request: { arrival: '15/09/2026', departure: '19/09/2026' },
      usedResult: {
        roomType: 'GOOD DAY',
        arrival: '15/09/2026',
        departure: '19/09/2026',
        guestName: 'Choosing The Centurion Hotel',
      },
      spans: [
        { field: 'arrival', start: 10, end: 20, side: 'inbound' },
        { field: 'departure', start: 32, end: 42, side: 'inbound' },
      ],
    };
    const fills = projectLabFills(row, 'hms_find_reservation');
    expect(fills.input.arrival).toBe('15/09/2026');
    expect(fills.input.departure).toBe('19/09/2026');
    expect(fills.output).not.toHaveProperty('arrival');
    expect(fills.output).not.toHaveProperty('departure');
    expect(fills.output.roomType).not.toBe('GOOD DAY');
  });

  it('paints only schema fields for the selected tool and drops illegal span names', () => {
    const body = 'stayDatesX tax invoice 15/09/2026 extra';
    const spans = [
      { field: 'stayDates', start: 0, end: 9, side: 'inbound' as const },
      { field: 'docType', start: 11, end: 22, side: 'inbound' as const },
      { field: 'arrival', start: 23, end: 33, side: 'inbound' as const },
    ];
    expect(spansForPaint(spans, 'hms_find_reservation').map((span) => span.field)).toEqual(['arrival']);
    expect(spansForPaint(spans, 'hms_generate_invoice').map((span) => span.field)).toEqual(['docType']);
    const html = highlightSpans(body, spansForPaint(spans, 'hms_find_reservation'), 'inbound');
    expect(html).not.toMatch(/data-field="docType"/);
    expect(html).not.toMatch(/data-field="stayDates"/);
    expect(html).toMatch(/data-field="arrival"/);
  });

  it('strips Check-in/Check-out labels so arrival is the date token', () => {
    expect(normalizeDateSpanQuote('arrival', '*\tCheck-in: 15 september')).toBe('15 september');
    expect(normalizeDateSpanQuote('departure', 'Check out: 19/09/2026')).toBe('19/09/2026');
    expect(normalizeDateSpanQuote('guestName', 'Check-in: 15 september')).toBe('Check-in: 15 september');
  });

  it('keeps interesting chips on gold-field enum keys only', () => {
    expect(
      interestingFacts(['check-in time', 'hms_attach_guest_stay_document', 'rateCode', 'roomType']),
    ).toEqual(['rateCode', 'roomType']);
  });

  it('shows staff gold without quoted From history and renders prior inbound plus PDF extract', () => {
    const goldBody = [
      'Good day Adrie,',
      '',
      'Please see attached quotation.',
      '',
      'From: Guest <guest@example.com>',
      'Sent: Monday',
      'Subject: FW: URGENT QUOTE REQUEST - CIDB (15 - 18 SEPTEMBER)',
      '',
      'Please quote 9 singles.',
    ].join('\n');
    const stripped = stripQuotedHistory(goldBody);
    expect(stripped).toContain('Please see attached quotation.');
    expect(stripped).not.toContain('From: Guest');
    expect(stripped).not.toContain('URGENT QUOTE REQUEST - CIDB');
    const row: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[2]!,
      inboundId: 'syn-cidb',
      inbound: { subject: 'FW: URGENT QUOTE REQUEST - CIDB', textBody: 'Please quote 9 singles.' },
      gold: {
        id: 'syn-cidb-gold',
        subject: 'RE: URGENT QUOTE REQUEST - CIDB',
        textBody: goldBody,
        channelAuto: false,
      },
      priorInbounds: [{ id: 'syn-prior', subject: 'Voucher Generated', textBody: 'Voucher for prior stay.' }],
      attachmentText: 'PDF: 9 singles 15 Sep to 18 Sep',
      attachmentRefs: [{ filename: 'quote.pdf', contentType: 'application/pdf', byteSize: 12 }],
      staffFilledAbsentFromInbound: ['check-in time', 'rateCode'],
      spans: [{ field: 'stayDates', start: 0, end: 7, side: 'inbound' }],
    };
    render(<CenturionEvalLab index={{ generated: 'synthetic', rows: [row] }} selectedTool="hms_quote_stay" />);
    const goldCard = screen.getByTestId('lab-gold-body');
    expect(goldCard.textContent).toContain('Please see attached quotation.');
    expect(goldCard.textContent).not.toContain('From: Guest');
    expect(screen.getByTestId('lab-quoted-history')).toBeTruthy();
    expect(screen.getByTestId('lab-prior-inbound').textContent).toContain('Voucher Generated');
    expect(screen.getByTestId('lab-attachment-text').textContent).toContain('9 singles');
    expect(screen.getByTestId('interesting-fact').textContent).toContain('rateCode');
    expect(screen.getByTestId('interesting-fact').textContent).not.toContain('check-in time');
    expect(screen.getByTestId('lab-gold-split')).toBeTruthy();
    expect(screen.getByTestId('lab-gold-body').textContent).toContain('Please see attached quotation.');
    expect(screen.getByTestId('lab-quote-rate-proof').textContent).toContain('Not a mailbox guest.');
  });

  it('builds inbound spans from request values on PDF/prior text', () => {
    const text = 'PDF: 9 singles 15 Sep to 18 Sep';
    const spans = valuesToSpans(text, { arrival: '15 Sep', roomType: '9 singles' }, 'inbound', 'hms_quote_stay');
    expect(spans.map((span) => span.field).sort()).toEqual(['arrival', 'roomType']);
    const html = highlightSpans(text, spans, 'inbound');
    expect(html).toMatch(/data-field="arrival"/);
    expect(html).toMatch(/data-field="roomType"/);
  });

  it('splits CIDB-style Arrive/Depart/Rooms into two stay asks and rejects year qty', () => {
    const body = [
      'Arrive : 15 September 2026',
      'Depart : 17 September 2026',
      'Rooms : 2 Singles',
      'Arrive : 15 September 2026',
      'Depart : 18 September 2026',
      'Rooms : 7 Singles',
    ].join('\n');
    const asks = splitStayAsks(body);
    expect(asks).toEqual([
      { arrival: '15 September 2026', departure: '17 September 2026', roomQty: 2, roomType: 'Singles' },
      { arrival: '15 September 2026', departure: '18 September 2026', roomQty: 7, roomType: 'Singles' },
    ]);
    expect(coerceRoomQty('2026')).toBeUndefined();
    expect(coerceRoomQty(['17 September 2026', '18 September 2026'])).toBeUndefined();
    const row: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[2]!,
      tools: ['hms_quote_stay'],
      inbound: { subject: 'FW: URGENT QUOTE REQUEST - CIDB', textBody: body },
      request: { arrival: '15 September 2026', departure: ['17 September 2026', '18 September 2026'], roomQty: '2026' },
      stayAsks: asks,
      spans: [],
    };
    const first = projectLabFills(row, 'hms_quote_stay', 0);
    const second = projectLabFills(row, 'hms_quote_stay', 1);
    expect(first.input.roomQty).toBe(2);
    expect(first.input.departure).toBe('17 September 2026');
    expect(second.input.roomQty).toBe(7);
    expect(second.input.departure).toBe('18 September 2026');
    const html = highlightSpans(body, valuesToSpans(body, first.input, 'inbound', 'hms_quote_stay'), 'inbound');
    expect(html).toMatch(/data-field="arrival"/);
    expect(html).toMatch(/data-field="departure"/);
    expect(html).toMatch(/data-field="roomQty"/);
    expect(html).not.toMatch(/data-field="roomQty">2026/);
    const derived = resolveProposedActions(row);
    const derivedQuotes = derived.filter((item) => item.tool === 'hms_quote_stay');
    expect(derivedQuotes).toHaveLength(2);
    expect(derivedQuotes[0]?.title).toBe('Quote stay');
    expect(derivedQuotes[0]?.colorIndex).toBe(0);
    expect(derivedQuotes[1]?.colorIndex).toBe(1);
    expect(derived.map((item) => item.tool)).toEqual(
      expect.arrayContaining(['hms_quote_stay', 'hms_find_reservation', 'hms_read_reservation']),
    );
    expect(proposedActionFacts(derived[0]!.request)).toMatch(/2/);
    expect(proposedActionFacts(derived[1]!.request)).toMatch(/7/);
    const reRow: LabRow = {
      ...row,
      inboundId: 'cidb-re',
      inbound: { subject: 'RE: URGENT QUOTE REQUEST - CIDB', textBody: 'Please amend to 3 and 6 singles.' },
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { arrival: '15 September 2026', departure: '17 September 2026', roomQty: 3, roomType: 'Singles' } },
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 1, request: { arrival: '15 September 2026', departure: '18 September 2026', roomQty: 6, roomType: 'Singles' } },
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'superseded', colorIndex: 2, request: { arrival: '15 September 2026', departure: '17 September 2026', roomQty: 2, roomType: 'Singles' } },
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'superseded', colorIndex: 3, request: { arrival: '15 September 2026', departure: '18 September 2026', roomQty: 7, roomType: 'Singles' } },
      ],
    };
    const reLive = resolveProposedActions(reRow).filter((item) => item.status === 'live');
    const reFolded = resolveProposedActions(reRow).filter((item) => item.status === 'superseded');
    expect(reLive.filter((item) => item.tool === 'hms_quote_stay').map((item) => item.request.roomQty)).toEqual([
      3, 6,
    ]);
    expect(reFolded.map((item) => item.request.roomQty)).toEqual([2, 7]);
    render(
      <CenturionEvalLab
        index={{ generated: 'synthetic', rows: [{ ...row, gold: SYNTHETIC_LAB_INDEX.rows[2]!.gold }] }}
        selectedTool="hms_quote_stay"
      />,
    );
    expect(screen.queryByTestId('lab-stay-asks')).toBeNull();
    expect(screen.getByTestId('lab-action-live-0').textContent).toContain('Quote stay');
    expect(screen.getAllByTestId('lab-action-then').length).toBeGreaterThan(0);
    expect(screen.getByTestId('lab-action-live-0').textContent).toContain('2');
    expect(screen.getByTestId('lab-action-live-1').textContent).toContain('7');
    expect(screen.getByTestId('lab-reading-pane').innerHTML).toMatch(/lab-span-action-0/);
    expect(screen.getByTestId('lab-reading-pane').innerHTML).toMatch(/lab-span-action-1/);
    expect(screen.getByTestId('lab-reading-pane').innerHTML).toMatch(/data-field="arrival"/);
    expect(screen.getByTestId('lab-reading-pane').innerHTML).toMatch(/data-field="roomQty"/);
    expect(screen.getByTestId('lab-schema-input').textContent).toMatch(/roomQty\s*2/);
    expect(screen.getByTestId('lab-schema-input').textContent).not.toMatch(/roomQty\s*2026/);
    expect(screen.getByTestId('lab-schema-input').textContent).not.toContain('[');
    expect(screen.getByTestId('lab-inbound-card')).toBeTruthy();
    cleanup();
    render(
      <CenturionEvalLab
        index={{ generated: 'synthetic', rows: [{ ...reRow, gold: SYNTHETIC_LAB_INDEX.rows[2]!.gold }] }}
        selectedTool="hms_quote_stay"
      />,
    );
    expect(screen.getByTestId('lab-action-live-0').textContent).toContain('3');
    expect(screen.getByTestId('lab-action-live-1').textContent).toContain('6');
    expect(screen.getByTestId('lab-action-already').textContent).toMatch(/2|7/);
    cleanup();
    const skipRow: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[1]!,
      inboundId: 'skip-other-desk',
      threadOutcome: 'other_desk',
      otherDesk: 'Martha',
      proposedActions: [],
    };
    render(<CenturionEvalLab index={{ generated: 'synthetic', rows: [skipRow] }} />);
    expect(screen.getByTestId('lab-action-empty').textContent).toMatch(/No HMS write/);
    expect(splitStayAsks('quotation from 6th April to 10th April 2026')).toEqual([
      { arrival: '6th April', departure: '10th April 2026' },
    ]);
  });

  it('keeps Proposed for remaining writes on no_reply_owed and shows needs_human', () => {
    const base = SYNTHETIC_LAB_INDEX.rows[1]!;
    const folioRow: LabRow = {
      ...base,
      inboundId: 'noreply-folio',
      threadOutcome: 'no_reply_owed',
      threadOutcomeCopy: THREAD_OUTCOME_COPY.no_reply_owed,
      otherDesk: null,
      channelAuto: false,
      tools: ['hms_read_folio'],
      needed: { hms_read_folio: true },
    };
    delete (folioRow as { proposedActions?: unknown }).proposedActions;
    const derived = resolveProposedActions(folioRow);
    expect(derived.map((item) => item.tool)).toContain('hms_read_folio');
    render(<CenturionEvalLab index={{ generated: 'synthetic', rows: [folioRow] }} selectedTool="hms_read_folio" />);
    expect(screen.getByTestId('lab-action-live-0').textContent).toMatch(/folio/i);
    expect(screen.queryByTestId('lab-action-empty')).toBeNull();
    cleanup();
    const humanRow: LabRow = {
      ...base,
      inboundId: 'needs-human-row',
      tools: ['hms_event_read'],
      needed: { hms_event_read: true },
      proposedActions: [
        {
          tool: 'hms_event_read',
          title: 'Read event',
          status: 'needs_human',
          colorIndex: 0,
          request: { confirmationNumber: '123' },
        },
      ],
    };
    render(<CenturionEvalLab index={{ generated: 'synthetic', rows: [humanRow] }} selectedTool="hms_event_read" />);
    expect(screen.getByTestId('lab-action-live-0').textContent).toMatch(/needs human/i);
    cleanup();
    const deskRow: LabRow = {
      ...base,
      inboundId: 'desk-with-needed',
      threadOutcome: 'other_desk',
      otherDesk: 'Martha',
      needed: { hms_read_folio: true },
    };
    delete (deskRow as { proposedActions?: unknown }).proposedActions;
    expect(resolveProposedActions(deskRow)).toEqual([]);
  });

  it('shows list verbs, skip chip, staff-did miss, and enriches primary writes', () => {
    render(<CenturionEvalLab index={SYNTHETIC_LAB_INDEX} />);
    expect(screen.getAllByTestId('lab-row-verbs')[0]!.textContent).toMatch(/Quote stay/);
    fireEvent.click(screen.getByTestId('proposed-skip'));
    expect(screen.queryByTestId('lab-row-verbs')).toBeNull();
    cleanup();
    const gapOnly = { generated: 'synthetic', rows: [SYNTHETIC_LAB_INDEX.rows[1]!] };
    render(<CenturionEvalLab index={gapOnly} />);
    expect(screen.getByTestId('lab-staff-did-missing').textContent).toMatch(/No captured PMS response/);
    fireEvent.keyDown(window, { key: 'j' });
    cleanup();
    const folioRow: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[1]!,
      inboundId: 'enrich-folio',
      inbound: { subject: 'Invoice', textBody: 'Please send folio for 12 pax arriving 12 Oct.' },
      needed: { hms_read_folio: true, mail_read_artifact: true },
      tools: ['hms_read_folio', 'mail_read_artifact'],
      proposedActions: [
        {
          tool: 'mail_read_artifact',
          title: 'Read mail artifact',
          status: 'live',
          colorIndex: 0,
          request: {},
        },
      ],
    };
    const enriched = enrichHitlProposed(folioRow);
    expect(enriched.map((item) => item.tool)).toContain('hms_read_folio');
    expect(enriched.map((item) => item.tool)).not.toContain('mail_read_artifact');
    expect(occupancyFromText(folioRow.inbound.textBody)).toEqual({ adults: 12 });
    expect(occupancyFromText('Rooms : 2 Singles')).toEqual({});
    const quotes: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[0]!,
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { roomQty: 2 } },
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 1, request: { roomQty: 7 } },
      ],
    };
    expect(enrichHitlProposed(quotes).slice(0, 2).map((item) => item.request.roomQty)).toEqual([2, 7]);
    expect(enrichHitlProposed(quotes).slice(0, 2).every((item) => item.request.adults == null)).toBe(true);
    const singles: LabRow = {
      ...quotes,
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { roomQty: 3, roomType: 'Singles', adults: 3 } },
      ],
    };
    const routed = enrichHitlProposed(singles).find((item) => item.tool === 'hms_quote_stay');
    expect(routed?.request.roomType).toBeUndefined();
    expect(routed?.request.bedPreference).toBe('single');
    expect(routed?.request.adults).toBeUndefined();
    const suite: LabRow = {
      ...quotes,
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { roomType: 'Suite' } },
      ],
    };
    expect(enrichHitlProposed(suite).find((item) => item.tool === 'hms_quote_stay')?.request.roomType).toBe('SUITE');
    const product: LabRow = {
      ...quotes,
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { roomType: 'Standard Queen' } },
      ],
    };
    const productRouted = enrichHitlProposed(product).find((item) => item.tool === 'hms_quote_stay');
    expect(productRouted?.request.roomType).toBeUndefined();
    expect(productRouted?.request.bedPreference).toBeUndefined();
    const fromPdf: LabRow = {
      ...quotes,
      attachmentText: 'Check In: Thursday 10/09/2026\nCheck Out: Friday 11/09/2026\nRATE IS INCLUSIVE OF BREAKFAST',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const filled = enrichHitlProposed(fromPdf).find((item) => item.tool === 'hms_quote_stay');
    expect(filled?.request.arrival).toBe('10/09/2026');
    expect(filled?.request.departure).toBe('11/09/2026');
    expect(filled?.request.boardBasis).toBeUndefined();
    const twoRates: LabRow = {
      ...quotes,
      attachmentText: 'Rate per night: R1450.00 – Single / R1670.00 – Double',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    expect(enrichHitlProposed(twoRates).find((item) => item.tool === 'hms_quote_stay')?.request.rateQuoted).toBeUndefined();
    const oneRate: LabRow = {
      ...quotes,
      attachmentText: '14 - 18 Sep 2026 1 Single rate Dinner bed and Breakfast 4 R1 900,00 R7 600,00',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const rated = enrichHitlProposed(oneRate).find((item) => item.tool === 'hms_quote_stay');
    expect(rated?.request.rateQuoted).toBe('1900.00');
    expect(rated?.request.boardBasis).toBeUndefined();
    expect(rated?.request.bedPreference).toBeUndefined();
    const slip: LabRow = {
      ...quotes,
      attachmentText: 'Authorisation failed. Not a room quote. Amount 2910.00',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    expect(enrichHitlProposed(slip).find((item) => item.tool === 'hms_quote_stay')?.request.rateQuoted).toBeUndefined();
    const zar: LabRow = {
      ...quotes,
      attachmentText: 'Single rate Monday, 20, 2026 ZAR 1,940.00',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { rateQuoted: '202026.00' } },
      ],
    };
    expect(enrichHitlProposed(zar).find((item) => item.tool === 'hms_quote_stay')?.request.rateQuoted).toBe('1940.00');
    const ordinal: LabRow = {
      ...quotes,
      attachmentText: 'Arrival – Wednesday, 16th September 2026\nDeparture – Saturday, 19th September 2026\nAverage Daily rate:\nZAR 1420.00',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { arrival: '18 September', departure: '18-09-2026' } },
      ],
    };
    const ordinalFilled = enrichHitlProposed(ordinal).find((item) => item.tool === 'hms_quote_stay');
    expect(ordinalFilled?.request.arrival).toBe('16th September 2026');
    expect(ordinalFilled?.request.departure).toBe('19th September 2026');
    expect(ordinalFilled?.request.rateQuoted).toBe('1420.00');
    const agreed: LabRow = {
      ...quotes,
      attachmentText: 'The agreed rate is R1,800.00 for a double room, inclusive of dinner, bed, and breakfast.',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const agreedFilled = enrichHitlProposed(agreed).find((item) => item.tool === 'hms_quote_stay');
    expect(agreedFilled?.request.rateQuoted).toBe('1800.00');
    expect(agreedFilled?.request.boardBasis).toBeUndefined();
    const ping: LabRow = {
      ...quotes,
      inbound: { subject: 'Rooms', textBody: 'Please update room availability. Advise vacant, clean, inspected rooms you are READY.' },
      attachmentText: '',
      threadOutcome: 'no_reply_owed',
      needed: { hms_quote_stay: true },
      tools: ['hms_quote_stay', 'hms_find_reservation', 'hms_read_reservation'],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { arrival: '1 October 2026' } },
        { tool: 'hms_find_reservation', title: 'Find reservation', status: 'live', colorIndex: 1, request: {} },
        { tool: 'hms_read_reservation', title: 'Read reservation', status: 'live', colorIndex: 2, request: {} },
      ],
    };
    expect(enrichHitlProposed(ping)).toEqual([]);
    const sameDay: LabRow = {
      ...quotes,
      attachmentText: 'Arrival – Wednesday, 16th September 2026\nArrival 16-09-2026\nCheck-out Mon, 02 Nov\n2026',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { arrival: '18 September', departure: '26-09-20' } },
      ],
    };
    const same = enrichHitlProposed(sameDay).find((item) => item.tool === 'hms_quote_stay');
    expect(same?.request.arrival).toBe('16th September 2026');
    expect(same?.request.departure).toBe('02 Nov 2026');
    const beds: LabRow = {
      ...quotes,
      attachmentText: 'Check-in: 24 September 2026\nSingle rooms: 1\nTwin rooms: 7',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { roomQty: 1, bedPreference: 'single' } },
      ],
    };
    const mixed = enrichHitlProposed(beds).find((item) => item.tool === 'hms_quote_stay');
    expect(mixed?.request.bedPreference).toBeUndefined();
    expect(mixed?.request.roomQty).toBeUndefined();
    const shortYear: LabRow = {
      ...quotes,
      attachmentText: 'Check in - 14 Sep\nCheck in - 14 Sep 26\nCheck out - 21 Sep\n4 Single rooms',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { adults: 4 } },
      ],
    };
    const short = enrichHitlProposed(shortYear).find((item) => item.tool === 'hms_quote_stay');
    expect(short?.request.arrival).toBe('14 Sep 26');
    expect(short?.request.adults).toBeUndefined();
    const iso: LabRow = {
      ...quotes,
      inbound: { subject: 'Stay', textBody: 'Check-in: 2026-11-02\nCheck-out: 2026-11-05\nStandard double – R2300.00 Bed & Breakfast per night.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { arrival: '1 September 2026', departure: '15 October 2026' } },
      ],
    };
    const isoFilled = enrichHitlProposed(iso).find((item) => item.tool === 'hms_quote_stay');
    expect(isoFilled?.request.arrival).toBe('2026-11-02');
    expect(isoFilled?.request.departure).toBe('2026-11-05');
    expect(isoFilled?.request.rateQuoted).toBe('2300.00');
    const spaced: LabRow = {
      ...quotes,
      inbound: { subject: 'Rate', textBody: 'the rate will be R3 870 BB per night in a twin room.\nSent: 09 September 2026 10:19' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const spacedFilled = enrichHitlProposed(spaced).find((item) => item.tool === 'hms_quote_stay');
    expect(spacedFilled?.request.rateQuoted).toBe('3870.00');
    expect(spacedFilled?.request.boardBasis).toBeUndefined();
    const subscription: LabRow = {
      ...quotes,
      inbound: { subject: 'Offer', textBody: 'For only R199 per month, the tool gives you access to tenders.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { amount: '199.00' } },
      ],
    };
    expect(enrichHitlProposed(subscription).find((item) => item.tool === 'hms_quote_stay')?.request.amount).toBeUndefined();
    const duplicatedDay: LabRow = {
      ...quotes,
      inbound: { subject: 'Dates', textBody: 'Arrival: 14 October\nDeparture: 15 October 15' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { departure: '15 October 15' },
        },
      ],
    };
    expect(enrichHitlProposed(duplicatedDay).find((item) => item.tool === 'hms_quote_stay')?.request.departure).toBe('15 October');
    const newsDate: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Holiday',
        textBody: 'Travelers leave on the 19th September and return on the 4th October 2026 for a public holiday.',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { arrival: '19th September', departure: '4th October 2026' },
        },
      ],
    };
    const newsFilled = enrichHitlProposed(newsDate).find((item) => item.tool === 'hms_quote_stay');
    expect(newsFilled?.request.arrival).toBeUndefined();
    expect(newsFilled?.request.departure).toBeUndefined();
    const fullBoard: LabRow = {
      ...quotes,
      inbound: { subject: 'Meals', textBody: 'Breakfast, lunch and dinner to be included.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    expect(enrichHitlProposed(fullBoard).find((item) => item.tool === 'hms_quote_stay')?.request.boardBasis).toBeUndefined();
    const glued: LabRow = {
      ...quotes,
      inbound: { subject: 'Dates', textBody: 'Check in 21Sep 26\nCheck Out 22Sep' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const gluedFilled = enrichHitlProposed(glued).find((item) => item.tool === 'hms_quote_stay');
    expect(gluedFilled?.request.arrival).toBe('21Sep 26');
    expect(gluedFilled?.request.departure).toBe('22Sep');
    const rangeStay: LabRow = {
      ...quotes,
      inbound: { subject: 'Gov', textBody: 'Check in 14-16September 2026' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const rangeFilled = enrichHitlProposed(rangeStay).find((item) => item.tool === 'hms_quote_stay');
    expect(rangeFilled?.request.arrival).toBe('14 September 2026');
    expect(rangeFilled?.request.departure).toBe('16 September 2026');
    const bankAndStay: LabRow = {
      ...quotes,
      inbound: { subject: 'Pay', textBody: 'Bank payment notification.\nCheck in date: 13/09/2026\nCheck out date: 18/09/2026' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const bankFilled = enrichHitlProposed(bankAndStay).find((item) => item.tool === 'hms_quote_stay');
    expect(bankFilled?.request.arrival).toBe('13/09/2026');
    expect(bankFilled?.request.departure).toBe('18/09/2026');
    const bbAndRoom: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Rate',
        textBody: 'For the same room type is R1780.00 Bed & Breakfast per night & R1605.00 room only.',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { rateQuoted: '1780.00' } },
      ],
    };
    expect(enrichHitlProposed(bbAndRoom).find((item) => item.tool === 'hms_quote_stay')?.request.rateQuoted).toBeUndefined();
    const slicedDay: LabRow = {
      ...quotes,
      inbound: { subject: 'Dates', textBody: 'Check in: 11/09/2026\nCheck out : 112/09/2026' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { departure: '12/09/2026' },
        },
      ],
    };
    const slicedFilled = enrichHitlProposed(slicedDay).find((item) => item.tool === 'hms_quote_stay');
    expect(slicedFilled?.request.arrival).toBe('11/09/2026');
    expect(slicedFilled?.request.departure).toBeUndefined();
    const shortNumeric: LabRow = {
      ...quotes,
      inbound: { subject: 'Dates', textBody: 'Check IN: 20/09\nCheck OUT: 21/09' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const shortFilled = enrichHitlProposed(shortNumeric).find((item) => item.tool === 'hms_quote_stay');
    expect(shortFilled?.request.arrival).toBe('20/09');
    expect(shortFilled?.request.departure).toBe('21/09');
    const monthFirst: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody:
          'Arrival : Tuesday, September 22, 2026\nDeparture : Wednesday, September 23, 2026\nDaily Rate : Tuesday, September 22, 2026 ZAR 1,940.00',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const monthFirstFilled = enrichHitlProposed(monthFirst).find((item) => item.tool === 'hms_quote_stay');
    expect(monthFirstFilled?.request.arrival).toBe('September 22, 2026');
    expect(monthFirstFilled?.request.departure).toBe('September 23, 2026');
    expect(monthFirstFilled?.request.rateQuoted).toBe('1940.00');
    const andOut: LabRow = {
      ...quotes,
      inbound: { subject: 'Stay', textBody: 'Guest is check in 16 and out 18 Sep.\nDinner bed and breakfast please.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const andOutFilled = enrichHitlProposed(andOut).find((item) => item.tool === 'hms_quote_stay');
    expect(andOutFilled?.request.arrival).toBe('16 Sep');
    expect(andOutFilled?.request.departure).toBe('18 Sep');
    expect(andOutFilled?.request.boardBasis).toBeUndefined();
    const rateBasis: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: 'Check-In:21 Sep 2026 Check-Out:25 Sep 2026 Rate Basis:Breakfast',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const rateBasisFilled = enrichHitlProposed(rateBasis).find((item) => item.tool === 'hms_quote_stay');
    expect(rateBasisFilled?.request.arrival).toBe('21 Sep 2026');
    expect(rateBasisFilled?.request.departure).toBe('25 Sep 2026');
    expect(rateBasisFilled?.request.boardBasis).toBeUndefined();
    const dinnerOrders = [
      'Service : B&B and dinner with soft drink',
      'On government rate (bed, breakfast, dinner with 02 soft drinks & parking)',
      'Please include breakfast and dinner, dinner capped at R250.',
    ];
    for (const textBody of dinnerOrders) {
      const row: LabRow = {
        ...quotes,
        inbound: { subject: 'Stay', textBody },
        attachmentText: '',
        gold: null,
        priorInbounds: [],
        proposedActions: [
          { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
        ],
      };
      expect(enrichHitlProposed(row).find((item) => item.tool === 'hms_quote_stay')?.request.boardBasis).toBeUndefined();
    }
    const timesOnly: LabRow = {
      ...quotes,
      inbound: { subject: 'Stay', textBody: 'What time will dinner & breakfast times be each day?' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    expect(enrichHitlProposed(timesOnly).find((item) => item.tool === 'hms_quote_stay')?.request.boardBasis).toBeUndefined();
    const manyBeds: LabRow = {
      ...quotes,
      inbound: { subject: 'Stay', textBody: 'Need queen rooms and twin rooms.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { bedPreference: 'twin', bedType: 'queen' },
        },
      ],
    };
    const manyBedsFilled = enrichHitlProposed(manyBeds).find((item) => item.tool === 'hms_quote_stay');
    expect(manyBedsFilled?.request.bedPreference).toBeUndefined();
    expect(manyBedsFilled?.request.bedType).toBeUndefined();
    const statedPax: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: 'Dinner, bed and breakfast for 17 people Check-in 21/09/2026 and check-out 23/09/2026',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { roomQty: 17, adults: 17 },
        },
      ],
    };
    expect(enrichHitlProposed(statedPax).find((item) => item.tool === 'hms_quote_stay')?.request.adults).toBe(17);
    const markdownDates: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: '*Check-in:* 01 November 2026\n*Check-out:* 19 December 2026',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const markdownFilled = enrichHitlProposed(markdownDates).find((item) => item.tool === 'hms_quote_stay');
    expect(markdownFilled?.request.arrival).toBe('01 November 2026');
    expect(markdownFilled?.request.departure).toBe('19 December 2026');
    const boardLine: LabRow = {
      ...quotes,
      inbound: { subject: 'Stay', textBody: 'Check In\nCheck Out\nBed & Breakfast' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    expect(enrichHitlProposed(boardLine).find((item) => item.tool === 'hms_quote_stay')?.request.boardBasis).toBeUndefined();
    const fromTo: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: 'Room Reservation from 19 Sept to 21 Sept 2026 (2 Nights Stay)',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const fromToFilled = enrichHitlProposed(fromTo).find((item) => item.tool === 'hms_quote_stay');
    expect(fromToFilled?.request.arrival).toBe('19 Sept 2026');
    expect(fromToFilled?.request.departure).toBe('21 Sept 2026');
    const commaWeekday: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: 'checking in Thursday, 17 September 2026 and checking out, Saturday, 19 September 2026',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const commaFilled = enrichHitlProposed(commaWeekday).find((item) => item.tool === 'hms_quote_stay');
    expect(commaFilled?.request.arrival).toBe('17 September 2026');
    expect(commaFilled?.request.departure).toBe('19 September 2026');
    const dinnerCap: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: 'Check-in: 28 September 2026\nCheck-out: 30 September 2026\nPlease include breakfast and dinner, dinner capped at R250.',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { amount: '250.00' },
        },
      ],
    };
    const dinnerCapFilled = enrichHitlProposed(dinnerCap).find((item) => item.tool === 'hms_quote_stay');
    expect(dinnerCapFilled?.request.amount).toBeUndefined();
    expect(dinnerCapFilled?.request.boardBasis).toBeUndefined();
    const airline: LabRow = {
      ...quotes,
      inbound: { subject: 'Tickets', textBody: 'Remember to check in prior to departure.\n\nSent: Monday, 14 September 2026 14:32' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { amount: 'r 2026' } },
      ],
    };
    const airlineFilled = enrichHitlProposed(airline).find((item) => item.tool === 'hms_quote_stay');
    expect(airlineFilled?.request.arrival).toBeUndefined();
    expect(airlineFilled?.request.amount).toBeUndefined();
    const ofOctober: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Stay',
        textBody: 'so we check in on the 12th of October and Check out on the 15th of October.',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { arrival: 'on the 12th of October and', departure: 'on the 15th of October.' },
        },
      ],
    };
    const ofOctoberFilled = enrichHitlProposed(ofOctober).find((item) => item.tool === 'hms_quote_stay');
    expect(ofOctoberFilled?.request.arrival).toBe('12th of October');
    expect(ofOctoberFilled?.request.departure).toBe('15th of October');
    const bedAmp: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Rate',
        textBody: 'Standard room is R1940.00 per night Bed & Breakfast',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: {} },
      ],
    };
    const bedAmpFilled = enrichHitlProposed(bedAmp).find((item) => item.tool === 'hms_quote_stay');
    expect(bedAmpFilled?.request.rateQuoted).toBe('1940.00');
    expect(bedAmpFilled?.request.boardBasis).toBeUndefined();
    expect(bedAmpFilled?.request.roomType).toBeUndefined();
    const multiCheck: LabRow = {
      ...quotes,
      inbound: {
        subject: 'Rooming',
        textBody:
          'One guest will now only be checking in on 16 September 2026 and checking out on 17 September 2026. Another guest will need to check in on 14 September 2026.',
      },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { rateQuoted: 'R2500.00' },
        },
      ],
    };
    const multiFilled = enrichHitlProposed(multiCheck).find((item) => item.tool === 'hms_quote_stay');
    expect(multiFilled?.request.arrival).toBeUndefined();
    expect(multiFilled?.request.rateQuoted).toBeUndefined();
    const dinnerBedOnly: LabRow = {
      ...quotes,
      inbound: { subject: 'Policy', textBody: 'Dinner, Bed is listed on the menu. No stay rate.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { boardBasis: 'dinner_bed_breakfast' },
        },
      ],
    };
    expect(enrichHitlProposed(dinnerBedOnly).find((item) => item.tool === 'hms_quote_stay')?.request.boardBasis).toBeUndefined();
    const prefixedRate: LabRow = {
      ...quotes,
      inbound: { subject: 'Rate', textBody: 'The rate will be R2500.00 Single per room per night – Bed and Breakfast.' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        {
          tool: 'hms_quote_stay',
          title: 'Quote stay',
          status: 'live',
          colorIndex: 0,
          request: { rateQuoted: 'R2500.00' },
        },
      ],
    };
    const prefixedFilled = enrichHitlProposed(prefixedRate).find((item) => item.tool === 'hms_quote_stay');
    expect(prefixedFilled?.request.rateQuoted).toBe('2500.00');
    expect(prefixedFilled?.request.boardBasis).toBeUndefined();
    const openWindow: LabRow = {
      ...quotes,
      inbound: { subject: 'Programme', textBody: 'Applications Open: 1 September 2026 – 15 October 2026' },
      attachmentText: '',
      gold: null,
      priorInbounds: [],
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { arrival: '1 September 2026', departure: '15 October 2026' } },
      ],
    };
    const opened = enrichHitlProposed(openWindow).find((item) => item.tool === 'hms_quote_stay');
    expect(opened?.request.arrival).toBeUndefined();
    expect(opened?.request.departure).toBeUndefined();
    const conflict: LabRow = {
      ...quotes,
      attachmentText: 'Departure – Saturday, 19th September 2026\nDeparture 18-09-2026',
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { departure: '18-09-2026' } },
      ],
    };
    expect(enrichHitlProposed(conflict).find((item) => item.tool === 'hms_quote_stay')?.request.departure).toBeUndefined();
    const quoteDoc: LabRow = {
      ...quotes,
      tools: ['hms_quote_stay', 'hms_generate_quote_document'],
      needed: { hms_quote_stay: true },
      staffUsed: { hms_generate_quote_document: true },
    };
    expect(enrichHitlProposed(quoteDoc).map((item) => item.tool)).toContain('hms_generate_quote_document');
    const emailFolio: LabRow = {
      ...folioRow,
      tools: ['hms_read_folio', 'hms_email_folio'],
      needed: { hms_read_folio: true },
      staffUsed: { hms_email_folio: true },
    };
    expect(enrichHitlProposed(emailFolio).map((item) => item.tool)).toContain('hms_email_folio');
    const companyStaff: LabRow = {
      ...folioRow,
      tools: ['hms_find_reservation'],
      needed: {},
      staffUsed: { hms_company_account_read: true },
      proposedActions: [],
    };
    expect(enrichHitlProposed(companyStaff).map((item) => item.tool)).toContain('hms_company_account_read');
  });
});
