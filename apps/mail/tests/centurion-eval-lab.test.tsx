/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('virtua', async () => {
  const { createElement, forwardRef } = await import('react');
  return {
    VList: forwardRef(
      (props: { count: number; children: (index: number) => ReactNode }, _ref) =>
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
    expect(occupancyFromText('Rooms : 2 Singles')).toEqual({ adults: 2 });
    const quotes: LabRow = {
      ...SYNTHETIC_LAB_INDEX.rows[0]!,
      proposedActions: [
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 0, request: { roomQty: 2 } },
        { tool: 'hms_quote_stay', title: 'Quote stay', status: 'live', colorIndex: 1, request: { roomQty: 7 } },
      ],
    };
    expect(enrichHitlProposed(quotes).slice(0, 2).map((item) => item.request.roomQty)).toEqual([2, 7]);
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
