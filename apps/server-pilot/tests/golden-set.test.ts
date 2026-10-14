import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertHmsNeededMatchesGolden,
  extractConfirmationNumberFromFilename,
  extractionRooms,
  goldenRowsSha256,
  isCrossThreadBookingMatch,
  isPathWithin,
  isSafeAttachmentId,
  inferChangeTypes,
  latestSucceededExtractions,
  parseGoldenRow,
  parseHmsNeededFile,
  parseOfferPdfAnswer,
  resolveCancellationEvidence,
  resolvePrivateOutputPath,
  scoreGoldenRows,
  selectDiverseGoldenRows,
  type GoldenCandidate,
  type GoldenRow,
} from '../scripts/golden-set.js';

function candidate(
  messageId: string,
  senderDomain: string | null,
  stayDate: string | null,
  receivedAt: string,
): GoldenCandidate {
  return {
    message_id: messageId,
    class: 'quote',
    answer: {},
    evidence: { inbound_message_id: messageId, staff_message_ids: [], pdf_files: [] },
    sender_domain: senderDomain,
    stay_date: stayDate,
    received_at: receivedAt,
  };
}

describe('golden-set diversity selection', () => {
  it('prefers in-window stays, then newest mail, with at most two rows per domain and class', () => {
    const candidates = [
      candidate('q-old-stay', 'same.example', '2026-09-11', '2026-10-07T10:00:00Z'),
      candidate('q-latest', 'same.example', '2026-09-20', '2026-10-06T10:00:00Z'),
      candidate('q-next', 'same.example', '2026-09-15', '2026-10-05T10:00:00Z'),
      candidate('q-other-domain', 'other.example', '2026-09-18', '2026-10-04T10:00:00Z'),
    ];

    const selected = selectDiverseGoldenRows(candidates, { quote: 3 });

    expect(selected.rows.map((row) => row.message_id)).toEqual([
      'q-latest',
      'q-next',
      'q-other-domain',
    ]);
    expect(selected.availableByClass.quote).toBe(4);
    expect(selected.selectedByClass.quote).toBe(3);
  });

  it('keeps one answer row per email when evidence could qualify for multiple classes', () => {
    const quote = candidate('same-message', 'same.example', null, '2026-10-06T10:00:00Z');
    const create: GoldenCandidate = { ...quote, class: 'create' };

    const selected = selectDiverseGoldenRows([quote, create], { quote: 1, create: 1 });

    expect(selected.rows).toHaveLength(1);
    expect(selected.rows[0]).toMatchObject({ message_id: 'same-message', class: 'create' });
  });

  it('applies the same two-row cap to candidates without a known sender domain', () => {
    const selected = selectDiverseGoldenRows(
      [
        candidate('missing-domain-1', null, null, '2026-10-07T10:00:00Z'),
        candidate('missing-domain-2', null, null, '2026-10-06T10:00:00Z'),
        candidate('missing-domain-3', null, null, '2026-10-05T10:00:00Z'),
      ],
      { quote: 3 },
    );

    expect(selected.rows).toHaveLength(2);
  });
});

describe('golden offer PDF parsing', () => {
  it('extracts stay, rooms, board, party, rate plan, and explicit total', () => {
    const answer = parseOfferPdfAnswer([
      'Quotation',
      'Arrival Date: 12-Sep-2026',
      'Departure Date: 14-Sep-2026',
      '2 x Standard Queen',
      'Board: Bed & Breakfast',
      'Company: Acme Travel Group',
      'Rate Plan: BARBB',
      'Grand Total: ZAR 5,600.00',
    ].join('\n'));

    expect(answer).toEqual({
      dates: [{ arrival: '2026-09-12', departure: '2026-09-14' }],
      rooms: [{ count: 2, room_type: 'Standard Queen' }],
      room_count: 2,
      room_type: 'Standard Queen',
      board: 'Bed & Breakfast',
      party: { company: 'Acme Travel Group', agency: null },
      rate_plan: 'BARBB',
      total: '5600.00',
    });
  });

  it('leaves an unlabelled rate amount unknown instead of guessing the total', () => {
    const answer = parseOfferPdfAnswer([
      'Arrival Date: 12-Sep-2026',
      'Departure Date: 14-Sep-2026',
      'Rate per night: R2,800.00',
    ].join('\n'));

    expect(answer.total).toBeNull();
  });
});

describe('confirmation letter evidence', () => {
  it('extracts a confirmation number after an underscore in the PDF filename', () => {
    expect(extractConfirmationNumberFromFilename('HRCEN_Confirmation_Letter_00000000-1.pdf')).toBe(
      '00000000-1',
    );
    expect(extractConfirmationNumberFromFilename('unrelated-document.pdf')).toBeNull();
  });

  it('links split-thread creates only when stay dates and party evidence agree', () => {
    const evidence = {
      requestText: 'Please book two rooms for the listed dates.',
      senderDomain: 'bookings.travelit.co.za',
      requestAt: '2026-09-15T09:00:00Z',
      staffAt: '2026-09-16T11:00:00Z',
      requestDates: [{ arrival: '2026-10-04', departure: '2026-10-06' }],
      outcomeDates: [{ arrival: '2026-10-04', departure: '2026-10-06' }],
      party: { company: null, agency: 'Travelit' },
    };

    expect(isCrossThreadBookingMatch(evidence)).toBe(true);
    expect(isCrossThreadBookingMatch({ ...evidence, senderDomain: 'bookings.example.test' })).toBe(
      false,
    );
    expect(
      isCrossThreadBookingMatch({
        ...evidence,
        outcomeDates: [{ arrival: '2026-10-05', departure: '2026-10-07' }],
      }),
    ).toBe(false);
    expect(isCrossThreadBookingMatch({ ...evidence, staffAt: '2026-09-14T11:00:00Z' })).toBe(
      false,
    );
    expect(isCrossThreadBookingMatch({ ...evidence, staffAt: '2026-11-01T11:00:00Z' })).toBe(
      false,
    );
  });
});

describe('golden set input validation', () => {
  it('rejects malformed answer keys and evidence pointers', () => {
    const row = {
      message_id: 'quote-valid',
      class: 'quote',
      answer: { room_count: 1 },
      evidence: {
        inbound_message_id: 'quote-valid',
        staff_message_ids: ['staff-1'],
        pdf_files: ['offer.pdf'],
      },
    };

    expect(parseGoldenRow(row)).toMatchObject({ message_id: 'quote-valid', class: 'quote' });
    expect(() => parseGoldenRow({ ...row, answer: [] })).toThrow(/row 1/u);
    expect(() =>
      parseGoldenRow({
        ...row,
        evidence: { inbound_message_id: 'quote-valid', staff_message_ids: [], pdf_files: [] },
      }),
    ).toThrow(/row 1/u);
    expect(() =>
      parseGoldenRow({
        message_id: 'create-bare',
        class: 'create',
        answer: { conf: '12345678-1', confirmation_numbers: ['12345678-1'], hms: null },
        evidence: {
          inbound_message_id: 'create-bare',
          staff_message_ids: ['staff-1'],
          pdf_files: ['confirmation.pdf'],
        },
      }),
    ).toThrow(/row 1/u);
  });

  it('fails closed on malformed HMS-needed metadata or a stale selection manifest', () => {
    const selection = (['quote', 'amend', 'cancel', 'create', 'skip'] as const).map((mailClass) => ({
      class: mailClass,
      target: 1,
      evidence_candidates: 1,
      after_domain_cap: 1,
      selected: mailClass === 'quote' ? 1 : 0,
    }));
    const row: GoldenRow = {
      message_id: 'quote-valid',
      class: 'quote',
      answer: { room_count: 1 },
      evidence: { inbound_message_id: 'quote-valid', staff_message_ids: ['staff-1'], pdf_files: ['offer.pdf'] },
    };
    const manifest = parseHmsNeededFile({
      conf_numbers: [],
      selection,
      golden_sha256: goldenRowsSha256([row]),
    });

    expect(() =>
      parseHmsNeededFile({ conf_numbers: 'not-an-array', selection, golden_sha256: '0'.repeat(64) }),
    ).toThrow(/manifest/u);
    expect(() =>
      parseHmsNeededFile({ conf_numbers: [], selection: [], golden_sha256: '0'.repeat(64) }),
    ).toThrow(/manifest/u);
    expect(() => assertHmsNeededMatchesGolden([row], manifest)).not.toThrow();
    expect(() =>
      assertHmsNeededMatchesGolden([row], {
        ...manifest,
        selection: manifest.selection.map((entry) =>
          entry.class === 'quote' ? { ...entry, selected: 0 } : entry,
        ),
      }),
    ).toThrow(/rerun select/u);
    expect(() =>
      assertHmsNeededMatchesGolden([row], { ...manifest, golden_sha256: '0'.repeat(64) }),
    ).toThrow(/rerun select/u);
  });
});

describe('private corpus path guards', () => {
  it('accepts bounded attachment ids and rejects path-like ids', () => {
    expect(isSafeAttachmentId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isSafeAttachmentId('../outside')).toBe(false);
    expect(isSafeAttachmentId('nested/file')).toBe(false);
    expect(isSafeAttachmentId('')).toBe(false);
    expect(isPathWithin('/private/data', '/private/data/testsets/golden.jsonl')).toBe(true);
    expect(isPathWithin('/private/data', '/private/data-old/golden.jsonl')).toBe(false);
  });

  it('rejects symlinked parents and output files while resolving private outputs', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'golden-set-'));
    const privateRoot = join(tempRoot, 'private');
    const repoRoot = join(tempRoot, 'repo');
    const outsideRoot = join(tempRoot, 'outside');
    try {
      await Promise.all([mkdir(privateRoot), mkdir(repoRoot), mkdir(outsideRoot)]);
      await symlink(outsideRoot, join(privateRoot, 'escaped-parent'));
      await expect(
        resolvePrivateOutputPath(
          join(privateRoot, 'escaped-parent', 'golden.jsonl'),
          privateRoot,
          repoRoot,
        ),
      ).rejects.toThrow(/outside the private data directory/u);

      await mkdir(join(privateRoot, 'reports'));
      await symlink(join(outsideRoot, 'report.md'), join(privateRoot, 'reports', 'report.md'));
      await expect(
        resolvePrivateOutputPath(join(privateRoot, 'reports', 'report.md'), privateRoot, repoRoot),
      ).rejects.toThrow(/outside the private data directory/u);

      await expect(
        resolvePrivateOutputPath(join(privateRoot, 'reports', 'nested', 'score.md'), privateRoot, repoRoot),
      ).resolves.toBe(join(privateRoot, 'reports', 'nested', 'score.md'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('snapshot extraction ordering', () => {
  it('ignores malformed timestamps rather than sorting them after valid extractions', () => {
    const latest = latestSucceededExtractions([
      { id: 'old', message_id: 'm1', status: 'succeeded', created_at: '2026-10-01T00:00:00Z' },
      { id: 'bad', message_id: 'm1', status: 'succeeded', created_at: 'zzzz' },
      { id: 'new', message_id: 'm1', status: 'succeeded', created_at: '2026-10-02T00:00:00Z' },
    ]);

    expect(latest.get('m1')?.id).toBe('new');
  });

  it('sums room counts across room types when the extraction has no stay total', () => {
    const answer = extractionRooms({
      payload: {
        stays: [
          {
            rows: [
              { rooms: 2, roomType: 'Standard Queen' },
              { rooms: 1, roomType: 'Twin' },
            ],
          },
        ],
      },
    });

    expect(answer).toEqual({
      rooms: [
        { count: 2, room_type: 'Standard Queen' },
        { count: 1, room_type: 'Twin' },
      ],
      roomCount: 3,
    });
  });
});

describe('cancellation evidence matching', () => {
  it('ties staff evidence to the requested confirmation and rejects ambiguous requests', () => {
    const first = '11111111-1';
    const second = '22222222-2';

    expect(
      resolveCancellationEvidence(`Please cancel ${first}`, [
        { message_id: 'staff-mismatch', confirmation_numbers: [second] },
      ]),
    ).toBeNull();
    expect(
      resolveCancellationEvidence(`Please cancel ${first}`, [
        { message_id: 'staff-numberless', confirmation_numbers: [] },
      ]),
    ).toEqual({ conf: first, staff_message_ids: ['staff-numberless'], confirmed: true });
    expect(
      resolveCancellationEvidence(`Please cancel ${first} and ${second}`, [
        { message_id: 'staff-ambiguous', confirmation_numbers: [] },
      ]),
    ).toBeNull();
    expect(
      resolveCancellationEvidence(`Please cancel ${first} and ${second}`, [
        { message_id: 'staff-specific', confirmation_numbers: [second] },
      ]),
    ).toEqual({ conf: second, staff_message_ids: ['staff-specific'], confirmed: true });
  });
});

describe('amendment change typing', () => {
  it('retains all supported change types and falls back to other', () => {
    expect(
      inferChangeTypes('Please move arrival by one night, change room type, and correct guest name.'),
    ).toEqual(['dates', 'rooms', 'names']);
    expect(inferChangeTypes('Please update the billing reference.')).toEqual(['other']);
  });
});

describe('golden-set scoring', () => {
  it('recognizes the stored action aliases in snapshot and fresh predictions', () => {
    const golden: GoldenRow[] = [
      {
        message_id: 'create-alias',
        class: 'create',
        answer: {},
        evidence: { inbound_message_id: 'create-alias', staff_message_ids: [], pdf_files: [] },
      },
      {
        message_id: 'quote-alias',
        class: 'quote',
        answer: {},
        evidence: { inbound_message_id: 'quote-alias', staff_message_ids: [], pdf_files: [] },
      },
    ];

    const score = scoreGoldenRows(golden, [
      { message_id: 'create-alias', action: 'unmapped', kind: 'new_booking' },
      { message_id: 'quote-alias', action: 'quote_availability' },
    ]);

    expect(score.overall.action).toEqual({ correct: 2, total: 2 });
  });

  it('scores actions and exact key fields, with skip precision and recall', () => {
    const golden: GoldenRow[] = [
      {
        message_id: 'create-1',
        class: 'create',
        answer: {
          dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
          conf: '12345678-1',
          room_count: 2,
          party: { company: 'Acme Holdings Ltd', agency: null },
        },
        evidence: { inbound_message_id: 'create-1', staff_message_ids: [], pdf_files: [] },
      },
      {
        message_id: 'skip-1',
        class: 'skip',
        answer: { skip: true },
        evidence: { inbound_message_id: 'skip-1', staff_message_ids: [], pdf_files: [] },
      },
      {
        message_id: 'quote-1',
        class: 'quote',
        answer: { dates: [{ arrival: '2026-11-01', departure: '2026-11-02' }] },
        evidence: { inbound_message_id: 'quote-1', staff_message_ids: [], pdf_files: [] },
      },
    ];
    const predictions = [
      {
        message_id: 'create-1',
        action: 'booking',
        dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
        confirmation_numbers: ['12345678-1'],
        room_count: 2,
        party: { company: 'Acme Holdings' },
      },
      { message_id: 'skip-1', action: 'no_action' },
      { message_id: 'quote-1', action: 'skip' },
    ];

    const score = scoreGoldenRows(golden, predictions);

    expect(score.byClass.create).toMatchObject({
      count: 1,
      action: { correct: 1, total: 1 },
      dates: { correct: 1, total: 1 },
      confirmation: { correct: 1, total: 1 },
      rooms: { correct: 1, total: 1 },
      party: { correct: 1, total: 1 },
    });
    expect(score.overall.action).toEqual({ correct: 2, total: 3 });
    expect(score.skip).toEqual({
      true_positive: 1,
      false_positive: 1,
      false_negative: 0,
      precision: { correct: 1, total: 2 },
      recall: { correct: 1, total: 1 },
    });
  });

  it('does not count a company match in the agency role or vice versa', () => {
    const golden: GoldenRow[] = [
      {
        message_id: 'create-party-role',
        class: 'create',
        answer: {
          party: { company: 'Acme Holdings Ltd', agency: 'Travelit Tours' },
        },
        evidence: {
          inbound_message_id: 'create-party-role',
          staff_message_ids: ['staff-1'],
          pdf_files: ['confirmation.pdf'],
        },
      },
    ];

    const score = scoreGoldenRows(golden, [
      {
        message_id: 'create-party-role',
        action: 'create',
        party: { company: 'Travelit Tours', agency: 'Acme Holdings' },
      },
    ]);

    expect(score.byClass.create.party).toEqual({ correct: 0, total: 1 });
  });
});
