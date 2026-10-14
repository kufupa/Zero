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
  snapshotPrediction,
  type GoldenCandidate,
  type GoldenRow,
} from '../scripts/golden-set.js';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {
  withGoldenSetPairLock,
  writePrivateFileAtomically,
} from '../scripts/golden-set-storage.js';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    const answer = parseOfferPdfAnswer(
      [
        'Quotation',
        'Arrival Date: 12-Sep-2026',
        'Departure Date: 14-Sep-2026',
        '2 x Standard Queen',
        'Board: Bed & Breakfast',
        'Company: Acme Travel Group',
        'Rate Plan: BARBB',
        'Grand Total: ZAR 5,600.00',
      ].join('\n'),
    );

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

  it('collects every fully labelled stay from an offer PDF', () => {
    const answer = parseOfferPdfAnswer(
      [
        'Stay 1',
        'Arrival Date: 12-Sep-2026',
        'Departure Date: 14-Sep-2026',
        'Stay 2',
        'Arrival Date: 20-Oct-2026',
        'Departure Date: 22-Oct-2026',
      ].join('\n'),
    );

    expect(answer.dates).toEqual([
      { arrival: '2026-09-12', departure: '2026-09-14' },
      { arrival: '2026-10-20', departure: '2026-10-22' },
    ]);
  });

  it('combines dated answers across offer PDFs but leaves conflicting fields unknown', async () => {
    const module = await import('../scripts/golden-set.js');
    const bestPdfAnswer = Reflect.get(module, 'bestPdfAnswer');
    expect(bestPdfAnswer).toBeTypeOf('function');
    if (typeof bestPdfAnswer !== 'function') return;

    const answer = bestPdfAnswer(
      [
        {
          attachment_id: 'offer-first',
          message_id: 'quote-reply',
          file_name: 'offer-first.pdf',
          kind: 'offer',
          text: [
            'Arrival Date: 12-Sep-2026',
            'Departure Date: 14-Sep-2026',
            '2 x Standard Queen',
            'Board: Bed & Breakfast',
            'Rate Plan: BARBB',
            'Grand Total: ZAR 5,600.00',
          ].join('\n'),
          conf: null,
        },
        {
          attachment_id: 'offer-second',
          message_id: 'quote-reply',
          file_name: 'offer-second.pdf',
          kind: 'offer',
          text: [
            'Arrival Date: 20-Oct-2026',
            'Departure Date: 22-Oct-2026',
            '1 x Deluxe Twin',
            'Board: Bed & Breakfast',
            'Rate Plan: BARBB',
            'Grand Total: ZAR 7,200.00',
          ].join('\n'),
          conf: null,
        },
      ],
      '2026-08-01T00:00:00Z',
    );

    expect(answer).toMatchObject({
      dates: [
        { arrival: '2026-09-12', departure: '2026-09-14' },
        { arrival: '2026-10-20', departure: '2026-10-22' },
      ],
      room_count: null,
      room_type: null,
      board: 'Bed & Breakfast',
      rate_plan: 'BARBB',
      total: null,
    });
  });

  it('leaves dates unscored when only some labelled stays can be parsed', () => {
    const answer = parseOfferPdfAnswer(
      [
        'Stay 1',
        'Arrival Date: 12-Sep-2026',
        'Departure Date: 14-Sep-2026',
        'Stay 2',
        'Arrival Date: to be confirmed',
        'Departure Date: 22-Oct-2026',
      ].join('\n'),
    );

    expect(answer.dates).toEqual([]);
  });

  it('leaves an unlabelled rate amount unknown instead of guessing the total', () => {
    const answer = parseOfferPdfAnswer(
      [
        'Arrival Date: 12-Sep-2026',
        'Departure Date: 14-Sep-2026',
        'Rate per night: R2,800.00',
      ].join('\n'),
    );

    expect(answer.total).toBeNull();
  });

  it('keeps dinner in an unlabelled dinner-inclusive meal plan', () => {
    const answer = parseOfferPdfAnswer('Dinner, Bed & Breakfast');

    expect(answer.board).toBe('Dinner, Bed & Breakfast');
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
    expect(isCrossThreadBookingMatch({ ...evidence, staffAt: '2026-09-14T11:00:00Z' })).toBe(false);
    expect(isCrossThreadBookingMatch({ ...evidence, staffAt: '2026-11-01T11:00:00Z' })).toBe(false);
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

  it('allows supported create and amend rows without historical fact keys', () => {
    for (const mailClass of ['create', 'amend'] as const) {
      const messageId = `${mailClass}-without-answer-key`;
      const row = {
        message_id: messageId,
        class: mailClass,
        answer: {
          conf: '12345678-1',
          confirmation_numbers: ['12345678-1'],
          extracted_confirmation_numbers: [],
          ...(mailClass === 'amend' ? { change_types: ['dates'] } : {}),
          hms: null,
          hmsCurrent: {
            commercial: {
              arrival: '2026-10-15',
              departure: '2026-10-18',
              company: { name: 'Current Company' },
            },
          },
        },
        evidence: {
          inbound_message_id: messageId,
          staff_message_ids: ['staff-1'],
          pdf_files: [],
        },
      };

      expect(parseGoldenRow(row)).toMatchObject({ message_id: messageId, class: mailClass });
    }
  });

  it('fails closed on malformed HMS-needed metadata or a stale selection manifest', () => {
    const selection = (['quote', 'amend', 'cancel', 'create', 'skip'] as const).map(
      (mailClass) => ({
        class: mailClass,
        target: 1,
        evidence_candidates: 1,
        after_domain_cap: 1,
        selected: mailClass === 'quote' ? 1 : 0,
      }),
    );
    const row: GoldenRow = {
      message_id: 'quote-valid',
      class: 'quote',
      answer: { room_count: 1 },
      evidence: {
        inbound_message_id: 'quote-valid',
        staff_message_ids: ['staff-1'],
        pdf_files: ['offer.pdf'],
      },
    };
    const manifest = parseHmsNeededFile({
      conf_numbers: [],
      selection,
      golden_sha256: goldenRowsSha256([row]),
    });

    expect(() =>
      parseHmsNeededFile({
        conf_numbers: 'not-an-array',
        selection,
        golden_sha256: '0'.repeat(64),
      }),
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

  it('keeps previously merged HMS truth resolved when validating a later batch', async () => {
    const rows: GoldenRow[] = [
      {
        message_id: 'create-a',
        class: 'create',
        answer: {
          conf: '12345678-1',
          confirmation_numbers: ['12345678-1'],
          hms: null,
          hmsCurrent: {
            status: 'found',
            outcome: 'found',
            commercial: { arrival: '2026-10-01', departure: '2026-10-03' },
          },
        },
        evidence: { inbound_message_id: 'create-a', staff_message_ids: [], pdf_files: [] },
      },
      {
        message_id: 'create-b',
        class: 'create',
        answer: { conf: '22222222-2', confirmation_numbers: ['22222222-2'], hms: null },
        evidence: { inbound_message_id: 'create-b', staff_message_ids: [], pdf_files: [] },
      },
    ];
    const selection = (['quote', 'amend', 'cancel', 'create', 'skip'] as const).map(
      (mailClass) => ({
        class: mailClass,
        target: 2,
        evidence_candidates: 2,
        after_domain_cap: 2,
        selected: mailClass === 'create' ? 2 : 0,
      }),
    );
    const manifest = parseHmsNeededFile({
      conf_numbers: ['22222222-2'],
      selection,
      golden_sha256: goldenRowsSha256(rows),
    });

    const module = await import('../scripts/golden-set.js');
    const missingHmsConfirmations = Reflect.get(module, 'missingHmsConfirmations');
    expect(missingHmsConfirmations).toBeTypeOf('function');
    if (typeof missingHmsConfirmations === 'function') {
      expect(missingHmsConfirmations(rows)).toEqual(['22222222-2']);
    }
    expect(() => assertHmsNeededMatchesGolden(rows, manifest)).not.toThrow();
  });

  it('recovers a paired golden/HMS-needed update after one target install fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'golden-pair-'));
    const goldenPath = join(tempRoot, 'golden.jsonl');
    const hmsNeededPath = join(tempRoot, 'hms-needed.json');
    try {
      await writeFile(goldenPath, 'old golden\n');
      await mkdir(hmsNeededPath);

      await expect(
        withGoldenSetPairLock(goldenPath, hmsNeededPath, ({ write }) =>
          write('new golden\n', 'new manifest\n'),
        ),
      ).rejects.toThrow();

      await rm(hmsNeededPath, { recursive: true });
      await withGoldenSetPairLock(goldenPath, hmsNeededPath, ({ recover }) => recover());

      expect(await readFile(goldenPath, 'utf8')).toBe('new golden\n');
      expect(await readFile(hmsNeededPath, 'utf8')).toBe('new manifest\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('syncs staged directory entries before publishing the recovery journal', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'golden-pair-stage-sync-'));
    const goldenPath = join(tempRoot, 'golden.jsonl');
    const hmsNeededPath = join(tempRoot, 'hms-needed.json');
    const journalPath = join(tempRoot, '.golden-v1-pair-update.json');

    try {
      await writeFile(goldenPath, 'old golden\n');
      await writeFile(hmsNeededPath, 'old manifest\n');
      const handle = await open(tempRoot, 'r');
      const syncPrototype = Object.getPrototypeOf(handle);
      const originalSync = syncPrototype.sync as (this: typeof handle) => Promise<void>;
      await handle.close();
      const syncSpy = vi.spyOn(syncPrototype, 'sync').mockImplementation(async function (
        this: typeof handle,
      ) {
        if ((await this.stat()).isDirectory()) throw new Error('simulated directory sync failure');
        await originalSync.call(this);
      });

      try {
        await expect(
          withGoldenSetPairLock(goldenPath, hmsNeededPath, ({ write }) =>
            write('new golden\n', 'new manifest\n'),
          ),
        ).rejects.toThrow();
      } finally {
        syncSpy.mockRestore();
      }

      expect(await readFile(goldenPath, 'utf8')).toBe('old golden\n');
      expect(await readFile(hmsNeededPath, 'utf8')).toBe('old manifest\n');
      const journalState = await readFile(journalPath).then(
        () => 'present',
        (error: unknown) =>
          error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unreadable',
      );
      expect(journalState).toBe('ENOENT');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('serializes concurrent paired updates so their journals cannot interleave', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'golden-pair-lock-'));
    const goldenPath = join(tempRoot, 'golden.jsonl');
    const hmsNeededPath = join(tempRoot, 'hms-needed.json');
    const entered: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let signalFirstEntered = () => {};
    let releaseFirst = () => {};
    const pendingUpdates: Promise<void>[] = [];
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const update = (label: string, hold = false) =>
      withGoldenSetPairLock(goldenPath, hmsNeededPath, async ({ write }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        entered.push(label);
        if (hold) {
          signalFirstEntered();
          await firstGate;
        }
        await write(`${label} golden\n`, `${label} manifest\n`);
        active -= 1;
      });

    try {
      const first = update('first', true);
      pendingUpdates.push(first);
      await firstEntered;
      const second = update('second');
      pendingUpdates.push(second);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(entered).toEqual(['first']);

      releaseFirst();
      await Promise.all([first, second]);

      expect(entered).toEqual(['first', 'second']);
      expect(maximumActive).toBe(1);
      const [golden, hmsNeeded] = await Promise.all([
        readFile(goldenPath, 'utf8'),
        readFile(hmsNeededPath, 'utf8'),
      ]);
      expect([
        ['first golden\n', 'first manifest\n'],
        ['second golden\n', 'second manifest\n'],
      ]).toContainEqual([golden, hmsNeeded]);
    } finally {
      releaseFirst();
      await Promise.allSettled(pendingUpdates);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves an existing report when staging the replacement fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'golden-report-atomic-'));
    const reportPath = join(tempRoot, 'score.md');

    try {
      await writeFile(reportPath, 'previous report\n');
      const handle = await open(tempRoot, 'r');
      const writePrototype = Object.getPrototypeOf(handle);
      await handle.close();
      const writeSpy = vi.spyOn(writePrototype, 'writeFile').mockImplementation(async function (
        this: FileHandle,
      ) {
        throw new Error('simulated staged report write failure');
      });

      try {
        await expect(writePrivateFileAtomically(reportPath, 'new report\n')).rejects.toThrow();
      } finally {
        writeSpy.mockRestore();
      }

      expect(await readFile(reportPath, 'utf8')).toBe('previous report\n');
      expect(await readdir(tempRoot)).toEqual(['score.md']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
      await mkdir(join(privateRoot, 'testsets'));
      await symlink(join(outsideRoot, 'report.md'), join(privateRoot, 'reports', 'report.md'));
      await expect(
        resolvePrivateOutputPath(join(privateRoot, 'reports', 'report.md'), privateRoot, repoRoot),
      ).rejects.toThrow(/outside the private data directory/u);

      await expect(
        resolvePrivateOutputPath(
          join(privateRoot, 'reports', 'nested', 'score.md'),
          privateRoot,
          repoRoot,
        ),
      ).resolves.toBe(join(privateRoot, 'reports', 'nested', 'score.md'));

      const reportsRoot = join(privateRoot, 'reports');
      await expect(
        resolvePrivateOutputPath(
          join(privateRoot, 'testsets', 'golden-v1.jsonl'),
          privateRoot,
          repoRoot,
          { allowedRoot: reportsRoot },
        ),
      ).rejects.toThrow(/reports directory/u);

      const predictionsPath = join(reportsRoot, 'predictions.jsonl');
      await writeFile(predictionsPath, '{}\n');
      await expect(
        resolvePrivateOutputPath(predictionsPath, privateRoot, repoRoot, {
          allowedRoot: reportsRoot,
          inputPaths: [predictionsPath],
        }),
      ).rejects.toThrow(/overwrite.*input/u);

      const mergeOutputPath = join(privateRoot, 'testsets', 'golden-v1.jsonl');
      const mergeAliasPath = join(outsideRoot, 'golden-alias.jsonl');
      await writeFile(mergeOutputPath, '{}\n');
      await symlink(mergeOutputPath, mergeAliasPath);
      await expect(
        resolvePrivateOutputPath(mergeOutputPath, privateRoot, repoRoot, {
          inputPaths: [mergeOutputPath],
        }),
      ).rejects.toThrow(/overwrite.*input/u);
      await expect(
        resolvePrivateOutputPath(mergeOutputPath, privateRoot, repoRoot, {
          inputPaths: [mergeAliasPath],
        }),
      ).rejects.toThrow(/overwrite.*input/u);
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

  it('preserves rows without counts and keeps an incomplete stay total unknown', () => {
    const answer = extractionRooms({
      payload: {
        stays: [
          { rows: [{ rooms: 2, roomType: 'Standard Queen' }] },
          { rows: [{ roomType: 'Deluxe Twin' }] },
        ],
      },
    });

    expect(answer).toEqual({
      rooms: [
        { count: 2, room_type: 'Standard Queen' },
        { count: null, room_type: 'Deluxe Twin' },
      ],
      roomCount: null,
    });
  });

  it('does not infer a stay total from only the counted rows', () => {
    const answer = extractionRooms({
      payload: {
        stays: [
          {
            rows: [{ rooms: 2, roomType: 'Standard Queen' }, { roomType: 'Deluxe Twin' }],
          },
        ],
      },
    });

    expect(answer).toEqual({
      rooms: [
        { count: 2, room_type: 'Standard Queen' },
        { count: null, room_type: 'Deluxe Twin' },
      ],
      roomCount: null,
    });
  });
});

describe('snapshot source routing', () => {
  it('uses the production source door and keeps a direct cancellation extraction', async () => {
    const module = await import('../scripts/golden-set.js');
    const snapshotPrediction = Reflect.get(module, 'snapshotPrediction');
    expect(snapshotPrediction).toBeTypeOf('function');
    if (typeof snapshotPrediction !== 'function') return;

    const directPrediction = snapshotPrediction(
      'direct-cancellation',
      {
        id: 'direct-cancellation',
        thread_id: 'thread-1',
        direction: 'inbound',
        from_address: 'guest@example.test',
        subject: 'Cancellation notice',
        body: 'The reservation has been cancelled.',
        body_is_html: false,
      },
      {
        kind: 'cancellation',
        payload: {
          stays: [
            {
              requested: { arrival: '2026-10-01', departure: '2026-10-03' },
              totalRooms: 2,
              rows: [{ rooms: 2, roomType: 'Queen' }],
            },
          ],
          endClient: 'Acme Holdings',
          agency: 'Travelit',
          confirmationNumbers: ['12345678-1'],
        },
      },
    );
    const channelPrediction = snapshotPrediction(
      'channel-booking',
      {
        id: 'channel-booking',
        thread_id: 'thread-2',
        direction: 'inbound',
        from_address: 'reservation@booking.com',
        subject: 'Booking confirmed',
        body: '',
        body_is_html: false,
      },
      { kind: 'booking', payload: {} },
    );

    expect(directPrediction).toMatchObject({
      action: 'cancellation',
      dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
      rooms: [{ count: 2, room_type: 'Queen' }],
      room_count: 2,
      party: { company: 'Acme Holdings', agency: 'Travelit' },
      confirmation_numbers: ['12345678-1'],
    });
    expect(channelPrediction).toMatchObject({ action: 'skip' });
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

  it('recognizes a completed cancellation without reading quoted request text as staff text', async () => {
    const module = await import('../scripts/golden-set.js');
    const cancellationReplyEvidence = Reflect.get(module, 'cancellationReplyEvidence');
    expect(cancellationReplyEvidence).toBeTypeOf('function');
    if (typeof cancellationReplyEvidence !== 'function') return;

    const conf = '12345678-1';
    const request = {
      id: 'cancel-request',
      thread_id: 'cancel-thread',
      direction: 'inbound',
      subject: 'Cancellation request',
      body: `Please cancel ${conf}.`,
      body_is_html: false,
    };
    const reply = {
      id: 'cancel-reply',
      thread_id: 'cancel-thread',
      direction: 'outbound',
      from_address: 'reservations@legacyhotels.co.za',
      subject: `Re: Please cancel ${conf}`,
      body: `Reservation cancelled.\n\nFrom: guest@example.test\nSubject: Please cancel ${conf}\n\nPlease cancel ${conf}.`,
      body_is_html: false,
    };
    const replyEvidence = cancellationReplyEvidence(reply);
    const htmlReplyEvidence = cancellationReplyEvidence({
      ...reply,
      id: 'cancel-html-reply',
      body: `<p>Reservation cancelled.</p><blockquote><p>Please cancel ${conf}.</p></blockquote>`,
      body_is_html: true,
    });
    const authoredConf = '87654321-2';
    const numberedReplyEvidence = cancellationReplyEvidence({
      ...reply,
      id: 'cancel-numbered-reply',
      body: [
        `Reservation cancelled (${authoredConf}).`,
        '',
        'From: guest@example.test',
        `Subject: Please cancel ${conf}`,
      ].join('\n'),
    });

    expect(replyEvidence).toEqual({ message_id: reply.id, confirmation_numbers: [] });
    expect(htmlReplyEvidence).toEqual({ message_id: 'cancel-html-reply', confirmation_numbers: [] });
    expect(numberedReplyEvidence).toEqual({
      message_id: 'cancel-numbered-reply',
      confirmation_numbers: [authoredConf],
    });
    expect(
      resolveCancellationEvidence(request.body, [replyEvidence]),
    ).toEqual({ conf, staff_message_ids: [reply.id], confirmed: true });
  });
});

describe('amendment change typing', () => {
  it('retains all supported change types and falls back to other', () => {
    expect(
      inferChangeTypes(
        'Please move arrival by one night, change room type, and correct guest name.',
      ),
    ).toEqual(['dates', 'rooms', 'names']);
    expect(inferChangeTypes('Please update the billing reference.')).toEqual(['other']);
  });

  function amendmentMessage(
    id: string,
    threadId: string,
    direction: 'inbound' | 'outbound',
    body: string,
    receivedAt: string,
  ) {
    return {
      id,
      thread_id: threadId,
      direction,
      from_address:
        direction === 'inbound' ? 'guest@example.test' : 'reservations@legacyhotels.co.za',
      subject: direction === 'inbound' ? 'Change reservation' : 'Re: Change reservation',
      body,
      body_is_html: false,
      received_at: receivedAt,
    };
  }

  it('assigns each same-thread confirmation letter only to the preceding request', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    if (typeof matchingAmendmentUpdate !== 'function') return;

    const firstRequest = {
      id: 'request-1',
      thread_id: 'thread-1',
      direction: 'inbound',
      from_address: 'guest@example.test',
      subject: 'Change reservation 12345678-1',
      body: 'Please change reservation 12345678-1 to the first requested stay.',
      body_is_html: false,
      received_at: '2026-10-01T10:00:00Z',
    };
    const firstReply = {
      id: 'reply-1',
      thread_id: 'thread-1',
      direction: 'outbound',
      from_address: 'reservations@legacyhotels.co.za',
      subject: 'Updated 12345678-1',
      body: 'Updated reservation 12345678-1.',
      body_is_html: false,
      received_at: '2026-10-01T11:00:00Z',
    };
    const secondRequest = {
      ...firstRequest,
      id: 'request-2',
      body: 'Please change reservation 12345678-1 to the second requested stay.',
      received_at: '2026-10-01T12:00:00Z',
    };
    const secondReply = {
      ...firstReply,
      id: 'reply-2',
      received_at: '2026-10-01T13:00:00Z',
    };
    const thread = [firstRequest, firstReply, secondRequest, secondReply];
    const messageById = new Map(thread.map((message) => [message.id, message]));
    const documents = [
      {
        attachment_id: 'letter-1',
        message_id: 'reply-1',
        file_name: 'letter-1.pdf',
        kind: 'confirmation' as const,
        text: '',
        conf: '12345678-1',
      },
      {
        attachment_id: 'letter-2',
        message_id: 'reply-2',
        file_name: 'letter-2.pdf',
        kind: 'confirmation' as const,
        text: '',
        conf: '12345678-1',
      },
    ];

    const firstUpdate = matchingAmendmentUpdate(
      firstRequest,
      thread,
      '12345678-1',
      documents,
      messageById,
    );
    const secondUpdate = matchingAmendmentUpdate(
      secondRequest,
      thread,
      '12345678-1',
      documents,
      messageById,
    );

    expect(firstUpdate?.attachment_id).toBe('letter-1');
    expect(secondUpdate?.attachment_id).toBe('letter-2');
  });

  it('does not match a later cross-thread reply to an earlier amendment', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    const matchingAmendmentReplies = Reflect.get(module, 'matchingAmendmentReplies');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    expect(matchingAmendmentReplies).toBeTypeOf('function');
    if (
      typeof matchingAmendmentUpdate !== 'function' ||
      typeof matchingAmendmentReplies !== 'function'
    ) {
      return;
    }

    const firstRequest = {
      id: 'request-before-cross-thread-reply',
      thread_id: 'thread-amendments',
      direction: 'inbound',
      from_address: 'guest@example.test',
      subject: 'Change reservation 12345678-1',
      body: 'Please change reservation 12345678-1 to the first requested stay.',
      body_is_html: false,
      received_at: '2026-10-01T10:00:00Z',
    };
    const secondRequest = {
      ...firstRequest,
      id: 'next-amendment-request',
      body: 'Please change reservation 12345678-1 to the second requested stay.',
      received_at: '2026-10-01T12:00:00Z',
    };
    const laterReply = {
      id: 'reply-on-another-thread',
      thread_id: 'thread-staff-followup',
      direction: 'outbound',
      from_address: 'reservations@legacyhotels.co.za',
      subject: 'Updated reservation',
      body: 'Updated reservation 12345678-1.',
      body_is_html: false,
      received_at: '2026-10-01T13:00:00Z',
    };
    const thread = [firstRequest, secondRequest];
    const messages = [...thread, laterReply];
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const document = {
      attachment_id: 'later-cross-thread-letter',
      message_id: laterReply.id,
      file_name: 'later-cross-thread-letter.pdf',
      kind: 'confirmation' as const,
      text: '',
      conf: '12345678-1',
    };

    expect(
      matchingAmendmentUpdate(firstRequest, thread, '12345678-1', [document], messageById),
    ).toBeUndefined();
    expect(matchingAmendmentReplies(firstRequest, thread, messages, '12345678-1')).toEqual([]);
    expect(
      matchingAmendmentUpdate(secondRequest, thread, '12345678-1', [document], messageById)
        ?.attachment_id,
    ).toBe('later-cross-thread-letter');
    expect(matchingAmendmentReplies(secondRequest, thread, messages, '12345678-1')).toEqual([
      laterReply,
    ]);
  });

  it('bounds cross-thread evidence at the next request for the same confirmation', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    const matchingAmendmentReplies = Reflect.get(module, 'matchingAmendmentReplies');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    expect(matchingAmendmentReplies).toBeTypeOf('function');
    if (
      typeof matchingAmendmentUpdate !== 'function' ||
      typeof matchingAmendmentReplies !== 'function'
    ) {
      return;
    }

    const conf = '12345678-1';
    const firstRequest = amendmentMessage(
      'first-cross-thread-request',
      'first-request-thread',
      'inbound',
      `Please change reservation ${conf} to the first stay.`,
      '2026-10-01T10:00:00Z',
    );
    const nextRequest = amendmentMessage(
      'next-cross-thread-request',
      'next-request-thread',
      'inbound',
      `Please change reservation ${conf} to the next stay.`,
      '2026-10-01T12:00:00Z',
    );
    const laterReply = amendmentMessage(
      'reply-after-next-request',
      'staff-followup-thread',
      'outbound',
      `Updated reservation ${conf}.`,
      '2026-10-01T13:00:00Z',
    );
    const messages = [firstRequest, nextRequest, laterReply];
    const firstThread = [firstRequest];
    const nextThread = [nextRequest];
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const document = {
      attachment_id: 'later-amendment-letter',
      message_id: laterReply.id,
      file_name: 'later-amendment-letter.pdf',
      kind: 'confirmation' as const,
      text: '',
      conf,
    };

    expect(
      matchingAmendmentUpdate(firstRequest, firstThread, conf, [document], messageById),
    ).toBeUndefined();
    expect(matchingAmendmentReplies(firstRequest, firstThread, messages, conf)).toEqual([]);
    expect(
      matchingAmendmentUpdate(nextRequest, nextThread, conf, [document], messageById)?.attachment_id,
    ).toBe('later-amendment-letter');
    expect(matchingAmendmentReplies(nextRequest, nextThread, messages, conf)).toEqual([laterReply]);
  });

  it('rejects ambiguous cross-thread evidence after an unnumbered amendment request', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    const matchingAmendmentReplies = Reflect.get(module, 'matchingAmendmentReplies');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    expect(matchingAmendmentReplies).toBeTypeOf('function');
    if (
      typeof matchingAmendmentUpdate !== 'function' ||
      typeof matchingAmendmentReplies !== 'function'
    ) {
      return;
    }

    const conf = '12345678-1';
    const request = amendmentMessage(
      'numbered-request',
      'numbered-request-thread',
      'inbound',
      `Please change reservation ${conf} to the first stay.`,
      '2026-10-01T10:00:00Z',
    );
    const unnumberedRequest = amendmentMessage(
      'unnumbered-next-request',
      'unnumbered-request-thread',
      'inbound',
      'Please change the reservation dates for the next stay.',
      '2026-10-01T12:00:00Z',
    );
    const laterReply = amendmentMessage(
      'reply-after-unnumbered-request',
      'staff-followup-thread',
      'outbound',
      `Updated reservation ${conf}.`,
      '2026-10-01T13:00:00Z',
    );
    const messages = [request, unnumberedRequest, laterReply];
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const document = {
      attachment_id: 'ambiguous-amendment-letter',
      message_id: laterReply.id,
      file_name: 'ambiguous-amendment-letter.pdf',
      kind: 'confirmation' as const,
      text: '',
      conf,
    };

    expect(
      matchingAmendmentUpdate(request, [request], conf, [document], messageById),
    ).toBeUndefined();
    expect(matchingAmendmentReplies(request, [request], messages, conf)).toEqual([]);
  });

  it('requires an explicit confirmation link to accept an amendment reply', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    if (typeof matchingAmendmentUpdate !== 'function') return;

    const request = {
      id: 'request-unlinked',
      thread_id: 'thread-2',
      direction: 'inbound',
      from_address: 'guest@example.test',
      subject: 'Change reservation',
      body: 'Please change the reservation dates.',
      body_is_html: false,
      received_at: '2026-10-01T10:00:00Z',
    };
    const reply = {
      id: 'reply-unlinked',
      thread_id: 'thread-2',
      direction: 'outbound',
      from_address: 'reservations@legacyhotels.co.za',
      subject: 'Updated',
      body: 'Updated reservation.',
      body_is_html: false,
      received_at: '2026-10-01T11:00:00Z',
    };
    const document = {
      attachment_id: 'unlinked-letter',
      message_id: 'reply-unlinked',
      file_name: 'unlinked-letter.pdf',
      kind: 'confirmation' as const,
      text: '',
      conf: '12345678-1',
    };
    const thread = [request, reply];
    const messageById = new Map(thread.map((message) => [message.id, message]));

    expect(
      matchingAmendmentUpdate(request, thread, '12345678-1', [document], messageById),
    ).toBeUndefined();
    expect(
      matchingAmendmentUpdate(
        request,
        thread,
        '12345678-1',
        [document],
        new Map([
          [request.id, request],
          [reply.id, { ...reply, body: 'Updated reservation 12345678-1.' }],
        ]),
      )?.attachment_id,
    ).toBe('unlinked-letter');
  });

  it('rejects refused replies and attachments as amendment evidence', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentReplies = Reflect.get(module, 'matchingAmendmentReplies');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    expect(matchingAmendmentReplies).toBeTypeOf('function');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    if (
      typeof matchingAmendmentReplies !== 'function' ||
      typeof matchingAmendmentUpdate !== 'function'
    ) {
      return;
    }

    const conf = '12345678-1';
    const request = amendmentMessage(
      'refused-amendment-request',
      'refused-amendment-thread',
      'inbound',
      `Please change reservation ${conf}.`,
      '2026-10-01T10:00:00Z',
    );
    const refusals = [
      amendmentMessage(
        'quoted-refusal',
        request.thread_id,
        'outbound',
        [
          'We cannot change this reservation.',
          '',
          '-----Original Message-----',
          `Updated reservation ${conf}.`,
        ].join('\n'),
        '2026-10-01T11:00:00Z',
      ),
      amendmentMessage(
        'denied-update',
        request.thread_id,
        'outbound',
        `The reservation ${conf} has not been changed.`,
        '2026-10-01T12:00:00Z',
      ),
      amendmentMessage(
        'no-changes-made',
        request.thread_id,
        'outbound',
        'No changes have been made to this reservation.',
        '2026-10-01T13:00:00Z',
      ),
    ];
    const thread = [request, ...refusals];
    const documents = refusals.map((reply) => ({
      attachment_id: `${reply.id}-letter`,
      message_id: reply.id,
      file_name: `${reply.id}-letter.pdf`,
      kind: 'confirmation' as const,
      text: '',
      conf,
    }));
    const messageById = new Map(thread.map((message) => [message.id, message]));

    expect({
      replyIds: matchingAmendmentReplies(request, thread, thread, conf).map(({ id }) => id),
      updateIds: documents.map(
        (document) =>
          matchingAmendmentUpdate(request, thread, conf, [document], messageById)?.attachment_id,
      ),
    }).toEqual({ replyIds: [], updateIds: [undefined, undefined, undefined] });
  });

  it('does not use quoted confirmation numbers to link staff amendment evidence', async () => {
    const module = await import('../scripts/golden-set.js');
    const matchingAmendmentUpdate = Reflect.get(module, 'matchingAmendmentUpdate');
    const matchingAmendmentReplies = Reflect.get(module, 'matchingAmendmentReplies');
    expect(matchingAmendmentUpdate).toBeTypeOf('function');
    expect(matchingAmendmentReplies).toBeTypeOf('function');
    if (
      typeof matchingAmendmentUpdate !== 'function' ||
      typeof matchingAmendmentReplies !== 'function'
    ) {
      return;
    }

    const conf = '12345678-1';
    const request = amendmentMessage(
      'quoted-conf-request',
      'quoted-conf-request-thread',
      'inbound',
      'Please change the reservation dates.',
      '2026-10-01T10:00:00Z',
    );
    const quotedConfirmation = [
      'Updated reservation.',
      '',
      '-----Original Message-----',
      `Confirmation ${conf}.`,
    ].join('\n');
    const sameThreadReply = amendmentMessage(
      'quoted-conf-same-thread-reply',
      request.thread_id,
      'outbound',
      quotedConfirmation,
      '2026-10-01T11:00:00Z',
    );
    const crossThreadReply = amendmentMessage(
      'quoted-conf-cross-thread-reply',
      'quoted-conf-staff-thread',
      'outbound',
      quotedConfirmation,
      '2026-10-01T11:00:00Z',
    );
    const thread = [request, sameThreadReply];
    const messages = [...thread, crossThreadReply];
    const document = {
      attachment_id: 'quoted-conf-update',
      message_id: crossThreadReply.id,
      file_name: 'quoted-conf-update.pdf',
      kind: 'confirmation' as const,
      text: '',
      conf,
    };
    const messageById = new Map(messages.map((message) => [message.id, message]));

    expect({
      replyIds: matchingAmendmentReplies(request, thread, messages, conf).map(({ id }) => id),
      updateId: matchingAmendmentUpdate(request, [request], conf, [document], messageById)
        ?.attachment_id,
    }).toEqual({ replyIds: [], updateId: undefined });
  });
});

describe('HMS truth enrichment', () => {
  it('ignores failed or commercially empty reads without replacing prior success', async () => {
    const module = await import('../scripts/golden-set.js');
    const indexedTruth = Reflect.get(module, 'indexedTruth');
    expect(indexedTruth).toBeTypeOf('function');
    if (typeof indexedTruth !== 'function') return;

    const previousSuccess = {
      conf: '12345678-1',
      status: 'found',
      outcome: 'found',
      commercial: { arrival: '2026-10-01', departure: '2026-10-03' },
    };
    const reads = [
      previousSuccess,
      {
        conf: '12345678-1',
        status: 'execution_failure',
        outcome: 'execution_failure',
        commercial: { arrival: '2026-10-15', departure: '2026-10-18' },
      },
      { conf: '22222222-2', status: 'not_found', outcome: 'not_found', commercial: {} },
      {
        conf: '33333333-3',
        status: 'ambiguous',
        outcome: 'ambiguous',
        commercial: { ratePlan: 'AMB' },
      },
      { conf: '44444444-4', status: 'found', outcome: 'found', commercial: {} },
    ];
    const truthByConf = indexedTruth(reads);

    expect([...truthByConf.keys()]).toEqual(['12345678-1']);
    expect(truthByConf.get('12345678-1')).toBe(previousSuccess);
  });

  it('keeps saved current truth ahead of older base truth after a failed batch read', async () => {
    const module = await import('../scripts/golden-set.js');
    const indexedTruth = Reflect.get(module, 'indexedTruth');
    const preferredMergeTruth = Reflect.get(module, 'preferredMergeTruth');
    const answerWithTruth = Reflect.get(module, 'answerWithTruth');
    const missingHmsConfirmations = Reflect.get(module, 'missingHmsConfirmations');
    expect(indexedTruth).toBeTypeOf('function');
    expect(preferredMergeTruth).toBeTypeOf('function');
    expect(answerWithTruth).toBeTypeOf('function');
    expect(missingHmsConfirmations).toBeTypeOf('function');
    if (
      typeof indexedTruth !== 'function' ||
      typeof preferredMergeTruth !== 'function' ||
      typeof answerWithTruth !== 'function' ||
      typeof missingHmsConfirmations !== 'function'
    ) {
      return;
    }

    const savedCurrent = {
      conf: '12345678-1',
      status: 'found',
      outcome: 'found',
      commercial: {
        arrival: '2026-10-01',
        departure: '2026-10-03',
        roomType: 'Saved Current Room',
      },
    };
    const olderBase = {
      conf: '12345678-1',
      status: 'found',
      outcome: 'found',
      commercial: {
        arrival: '2026-09-01',
        departure: '2026-09-03',
        roomType: 'Older Base Room',
      },
    };
    const failedBatch = {
      conf: '12345678-1',
      status: 'execution_failure',
      outcome: 'execution_failure',
      commercial: {
        arrival: '2026-10-15',
        departure: '2026-10-18',
        roomType: 'Unusable Batch Room',
      },
    };
    const answer = {
      conf: '12345678-1',
      confirmation_numbers: ['12345678-1'],
      hms: null,
      hmsCurrent: savedCurrent,
    };
    const supplied = indexedTruth([failedBatch]).get('12345678-1');
    const base = indexedTruth([olderBase]).get('12345678-1');
    const selected = preferredMergeTruth(answer, '12345678-1', supplied, base);

    expect(selected).toEqual({ truth: savedCurrent, source: 'saved' });
    const mergedRow: GoldenRow = {
      message_id: 'create-with-saved-current',
      class: 'create',
      answer: answerWithTruth(answer, '12345678-1', selected?.truth),
      evidence: {
        inbound_message_id: 'create-with-saved-current',
        staff_message_ids: [],
        pdf_files: [],
      },
    };
    expect(mergedRow.answer.hmsCurrent).toEqual(savedCurrent);
    expect(missingHmsConfirmations([mergedRow])).toEqual([]);
  });

  it('preserves request evidence without borrowing current HMS fields', async () => {
    const module = await import('../scripts/golden-set.js');
    const answerWithTruth = Reflect.get(module, 'answerWithTruth');
    expect(answerWithTruth).toBeTypeOf('function');
    if (typeof answerWithTruth !== 'function') return;

    const currentRead = {
      conf: '12345678-1',
      outcome: 'found',
      commercial: {
        arrival: '2026-10-15',
        departure: '2026-10-18',
        roomType: 'Current Twin',
        ratePlan: 'CURR1',
        mealPlan: 'Dinner, Bed & Breakfast',
        company: { name: 'Later Company' },
        agency: { name: 'Later Agency' },
      },
    };
    const answer = answerWithTruth(
      {
        dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
        room_type: 'Requested Queen',
        party: { company: 'Request Company', agency: null },
        hms: null,
      },
      '12345678-1',
      currentRead,
    );

    expect(answer).toMatchObject({
      dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
      room_type: 'Requested Queen',
      party: { company: 'Request Company', agency: null },
      hms: null,
      hmsCurrent: currentRead,
    });
    expect(answer.rate_plan).toBeUndefined();
    expect(answer.board).toBeUndefined();
  });

  it('leaves historical fields unscored when only current HMS truth exists', async () => {
    const module = await import('../scripts/golden-set.js');
    const answerWithTruth = Reflect.get(module, 'answerWithTruth');
    expect(answerWithTruth).toBeTypeOf('function');
    if (typeof answerWithTruth !== 'function') return;

    const conf = '12345678-1';
    const currentRead = {
      conf,
      outcome: 'found',
      commercial: {
        arrival: '2026-10-15',
        departure: '2026-10-18',
        company: { name: 'Later Company' },
        agency: { name: 'Later Agency' },
      },
    };
    const row: GoldenRow = {
      message_id: 'amend-without-historical-document',
      class: 'amend',
      answer: answerWithTruth(
        { conf, confirmation_numbers: [conf], hms: null },
        conf,
        currentRead,
      ),
      evidence: {
        inbound_message_id: 'amend-without-historical-document',
        staff_message_ids: ['staff-amend-confirmation'],
        pdf_files: [],
      },
    };
    const score = scoreGoldenRows([row], [
      {
        message_id: row.message_id,
        action: 'amend',
        dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
        party: { company: 'Earlier Company', agency: 'Earlier Agency' },
      },
    ]);
    const legacyHmsScore = scoreGoldenRows(
      [
        {
          ...row,
          answer: { conf, confirmation_numbers: [conf], hms: currentRead },
        },
      ],
      [
        {
          message_id: row.message_id,
          action: 'amend',
          dates: [{ arrival: '2026-10-01', departure: '2026-10-03' }],
          party: { company: 'Earlier Company', agency: 'Earlier Agency' },
        },
      ],
    );

    expect(row.answer.hmsCurrent).toEqual(currentRead);
    expect(score.byClass.amend.dates).toEqual({ correct: 0, total: 0 });
    expect(score.byClass.amend.party).toEqual({ correct: 0, total: 0 });
    expect(legacyHmsScore.byClass.amend.dates).toEqual({ correct: 0, total: 0 });
    expect(legacyHmsScore.byClass.amend.party).toEqual({ correct: 0, total: 0 });
  });
});

describe('golden-set score report', () => {
  it('counts missing source-bound fields as no answer key', async () => {
    const module = await import('../scripts/golden-set.js');
    const buildScoreReport = Reflect.get(module, 'buildScoreReport');
    expect(buildScoreReport).toBeTypeOf('function');
    if (typeof buildScoreReport !== 'function') return;

    const row: GoldenRow = {
      message_id: 'amend-with-no-answer-key',
      class: 'amend',
      answer: {
        conf: '12345678-1',
        confirmation_numbers: ['12345678-1'],
        hmsCurrent: {
          commercial: {
            arrival: '2026-10-15',
            departure: '2026-10-18',
            company: { name: 'Later Company' },
            agency: { name: 'Later Agency' },
          },
        },
      },
      evidence: {
        inbound_message_id: 'amend-with-no-answer-key',
        staff_message_ids: [],
        pdf_files: [],
      },
    };
    const score = scoreGoldenRows([row], []);
    const report = buildScoreReport({
      rows: [row],
      score,
      mode: 'snapshot',
      selection: [],
      hmsNeededCount: 0,
    });

    expect(report).toContain('## No answer key');
    expect(report).toContain('| amend | 1 | 0 | 1 | 1 |');
  });
});

describe('golden-set scoring', () => {
  it('does not award empty extraction credit without a confirmation result', () => {
    const golden: GoldenRow[] = [
      {
        message_id: 'missing-confirmation-output',
        class: 'create',
        answer: { extracted_confirmation_numbers: [] },
        evidence: {
          inbound_message_id: 'missing-confirmation-output',
          staff_message_ids: [],
          pdf_files: [],
        },
      },
    ];
    const missingPrediction = scoreGoldenRows(golden, []);
    const missingSnapshotExtraction = scoreGoldenRows(golden, [
      snapshotPrediction('missing-confirmation-output', undefined, undefined),
    ]);
    const missingSnapshotConfirmationResult = scoreGoldenRows(golden, [
      snapshotPrediction('missing-confirmation-output', undefined, {
        kind: 'create',
        payload: {},
      }),
    ]);
    const emptySnapshotConfirmationResult = scoreGoldenRows(golden, [
      snapshotPrediction('missing-confirmation-output', undefined, {
        kind: 'create',
        payload: { confirmationNumbers: [] },
      }),
    ]);
    const explicitEmptyResult = scoreGoldenRows(golden, [
      { message_id: 'missing-confirmation-output', confirmation_numbers: [] },
    ]);

    expect(missingPrediction.byClass.create.confirmation).toEqual({ correct: 0, total: 1 });
    expect(missingSnapshotExtraction.byClass.create.confirmation).toEqual({ correct: 0, total: 1 });
    expect(missingSnapshotConfirmationResult.byClass.create.confirmation).toEqual({
      correct: 0,
      total: 1,
    });
    expect(emptySnapshotConfirmationResult.byClass.create.confirmation).toEqual({
      correct: 1,
      total: 1,
    });
    expect(explicitEmptyResult.byClass.create.confirmation).toEqual({ correct: 1, total: 1 });
  });

  it('scores extracted references separately from staff-issued confirmation numbers', () => {
    const golden: GoldenRow[] = [
      {
        message_id: 'cross-thread-create',
        class: 'create',
        answer: {
          conf: '12345678-1',
          confirmation_numbers: ['12345678-1'],
          extracted_confirmation_numbers: [],
        },
        evidence: {
          inbound_message_id: 'cross-thread-create',
          staff_message_ids: ['staff-1'],
          pdf_files: ['confirmation.pdf'],
        },
      },
    ];

    const correctEmptyExtraction = scoreGoldenRows(golden, [
      { message_id: 'cross-thread-create', action: 'create', confirmation_numbers: [] },
    ]);
    const leakedOutcomeNumber = scoreGoldenRows(golden, [
      {
        message_id: 'cross-thread-create',
        action: 'create',
        confirmation_numbers: ['12345678-1'],
      },
    ]);

    expect(correctEmptyExtraction.byClass.create.confirmation).toEqual({ correct: 1, total: 1 });
    expect(leakedOutcomeNumber.byClass.create.confirmation).toEqual({ correct: 0, total: 1 });
  });

  it('stores and scores a non-empty inbound reference independently from the outcome number', async () => {
    const module = await import('../scripts/golden-set.js');
    const makeCandidate = Reflect.get(module, 'makeCandidate');
    expect(makeCandidate).toBeTypeOf('function');
    if (typeof makeCandidate !== 'function') return;

    const row = makeCandidate({
      message: {
        id: 'amend-with-reference',
        thread_id: 'thread-with-reference',
        direction: 'inbound',
        from_address: 'guest@example.test',
        subject: 'Change reservation',
        body: 'Please amend reservation 11111111-1.',
        body_is_html: false,
        received_at: '2026-10-01T10:00:00Z',
      },
      mailClass: 'amend',
      answer: {
        conf: '22222222-2',
        confirmation_numbers: ['22222222-2'],
      },
    }) as GoldenRow;
    const prediction = (confirmation_numbers: string[]) =>
      scoreGoldenRows(
        [row],
        [{ message_id: 'amend-with-reference', action: 'amend', confirmation_numbers }],
      );

    expect(row.answer.extracted_confirmation_numbers).toEqual(['11111111-1']);
    expect(prediction(['11111111-1']).byClass.amend.confirmation).toEqual({
      correct: 1,
      total: 1,
    });
    expect(prediction(['22222222-2']).byClass.amend.confirmation).toEqual({
      correct: 0,
      total: 1,
    });
  });

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

  it('does not award room-count credit by filling an unknown total from partial rooms', () => {
    const row: GoldenRow = {
      message_id: 'partial-room-count',
      class: 'quote',
      answer: { room_count: 2 },
      evidence: {
        inbound_message_id: 'partial-room-count',
        staff_message_ids: [],
        pdf_files: [],
      },
    };
    const score = scoreGoldenRows([row], [
      {
        message_id: 'partial-room-count',
        action: 'quote',
        room_count: null,
        rooms: [{ count: 2, room_type: 'Standard Queen' }],
      },
    ]);

    expect(score.byClass.quote.rooms).toEqual({ correct: 0, total: 1 });
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
