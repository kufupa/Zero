import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  NOTES_TRACES_READ_PATH,
  NotesTracesParseError,
  createNotesTracesReadFacade,
  parseNotesTracesResponse,
  type NotesTracesParentBinding,
} from '../src/hms/notes-traces-read-facade.js';
import { observeNotesTraces } from '../../../../../apps/server-pilot/src/hms/live-notes-traces-read-driver.js';
import { HmsRuntimeError } from '../../../../../apps/server-pilot/src/hms/runtime.js';

const parent: NotesTracesParentBinding = {
  propertyCode: 'HRCEN',
  confirmationNumber: 'CONF-TRC',
  reservationStayId: 'STAY-TRC',
  resourceRef: 'reservation:synthetic',
};

const detailValues = {
  confirmationnumber: 'CONF-TRC',
  reservationstayid: 'STAY-TRC',
  propertycode: 'HRCEN',
  guestfullname: 'Synthetic Guest',
  account: 'SYNTH-ACCOUNT',
  guestid: 'SYNTH-GUEST',
  // OSRESV detail/follow-up forms use the captured MM/DD/YYYY wire format.
  hoteldate: '09/17/2026',
  lastname: 'Guest',
  firstname: 'Synthetic',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
};

function fixtureBody(options: {
  confirmationNumber?: string;
  reservationStayId?: string;
  propertyCode?: string;
  rows?: unknown[];
  records?: string;
  clientRows?: string;
  currentCursorPosition?: string;
  moreRecords?: string;
  dataspyId?: string;
  metadataDataspyId?: string;
  gridId?: string;
  gridName?: string;
  includeMetadata?: boolean;
} = {}): string {
  const confirmationNumber = options.confirmationNumber ?? parent.confirmationNumber;
  const reservationStayId = options.reservationStayId ?? parent.reservationStayId;
  const propertyCode = options.propertyCode ?? parent.propertyCode;
  const rows = options.rows ?? [];
  const records = options.records ?? String(rows.length);
  const metadata = options.includeMetadata === false
    ? ''
    : `METADATA: {
            REQUEST_TYPE_META: "LIST.HEAD_DATA.STORED",
            RECORDS: "${records}",
            CLIENTROWS: "${options.clientRows ?? '50'}",
            MORERECORDPRESENT: "${options.moreRecords ?? '-'}",
            CURRENTCURSORPOSITION: "${options.currentCursorPosition ?? String(rows.length)}",
            DATASPYID: "${options.metadataDataspyId ?? options.dataspyId ?? '1777'}",
            GRIDID: "${options.gridId ?? '1662'}",
            GRIDNAME: "${options.gridName ?? 'OSGSTR'}",
          },`;
  return `shell-prefix pageData: {
    values: {
      confirmationnumber: "${confirmationNumber}",
      reservationstayid: "${reservationStayId}",
      propertycode: "${propertyCode}",
      guestfullname: "Synthetic Guest",
    },
    grid: {
      GRIDRESULT: {
        type: "LIST.HEAD_DATA.STORED",
        DATASPY: { id: "${options.dataspyId ?? '1777'}", label: "All Records", },
        GRID: {
          ${metadata}
          FIELDS: { FIELD: [
            { name: "traceid", type: "VARCHAR", label: "In\\-House", },
            { name: "tracedetails", type: "VARCHAR", },
            { name: "tracestatus", type: "VARCHAR", },
            { name: "created", type: "DATETIME", },
            { name: "duedate", type: "DATE", },
          ], },
          DATA: ${JSON.stringify(rows)},
        },
      },
    },
    messages: null,
  } }`;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    traceid: 'TRACE-1',
    reservationstayid: parent.reservationStayId,
    tracedetails: 'Synthetic trace detail',
    topic: 'Synthetic topic',
    description: 'Synthetic description',
    created: '2026-09-17T09:00:00',
    duedate: '2026-09-18',
    updated: '2026-09-17T10:00:00',
    tracedeliverymethod: 'EMAIL',
    tracestatus: 'UNMAPPED_STATUS',
    tracestatus_display: 'Unmapped status',
    createdby: 'synthetic-user',
    completed: false,
    cancelled: false,
    ...overrides,
  };
}

const authorization = {
  toolId: 'hms_read_notes_traces' as const,
  discoveryOperationId: 'notes_traces_list' as const,
  requestBranchId: 'notes_traces_list',
  operationId: '00000000-0000-4000-8000-000000000099',
  releaseId: 'release-notes',
  manifest: {} as never,
  manifestSha256: 'a'.repeat(64),
  roleProofPath: '/tmp/role',
  roleProofSha256: 'b'.repeat(64),
  credentialVersionHmacSha256: 'c'.repeat(64),
  runtimeFingerprintSha256: 'd'.repeat(64),
  privateDigestKeyVersion: 'v1',
  sourceRevision: 'notes-test',
  expiresAt: '2099-01-01T00:10:00.000Z',
};

describe('bounded OSRESV.TRC parser/facade', () => {
  it('accepts the observed JSON-ish empty grid and proves parent from pageData.values', () => {
    const result = parseNotesTracesResponse(fixtureBody(), { parentBinding: parent });

    expect(result.parentBinding).toEqual(parent);
    expect(result.sourceCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.page).toEqual({ returnedCount: 0, hasMore: false, nextCursor: null });
    expect(result.completeness).toBe('complete');
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes full parsed source, including metadata outside projected rows', () => {
    const first = parseNotesTracesResponse(fixtureBody({ records: '0' }), {
      parentBinding: parent,
    });
    const second = parseNotesTracesResponse(fixtureBody({ records: '1' }), {
      parentBinding: parent,
    });

    expect(first.sourceHash).not.toBe(second.sourceHash);
  });

  it('keeps declared and parsed counts distinct and refuses complete-empty on a nonzero declaration', () => {
    const result = parseNotesTracesResponse(fixtureBody({ records: '1', rows: [] }), {
      parentBinding: parent,
    });

    expect(result.sourceCount).toBe(0);
    expect(result.declaredSourceCount).toBe(1);
    expect(result.sourceCompleteness).toBe('partial');
    expect(result.completeness).toBe('partial');
    expect(result.page).toEqual({ returnedCount: 0, hasMore: null, nextCursor: null });
    expect(result.sourceIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'METADATA_INCONSISTENT' })]),
    );
  });

  it('keeps a proven row window partial when the source advertises an unproven continuation', () => {
    const result = parseNotesTracesResponse(
      fixtureBody({ rows: [row()], records: '2', moreRecords: '+' }),
      { parentBinding: parent },
    );

    expect(result.sourceCount).toBe(1);
    expect(result.declaredSourceCount).toBe(2);
    expect(result.sourceCompleteness).toBe('partial');
    expect(result.page.hasMore).toBeNull();
    expect(result.page.nextCursor).toBeNull();
  });

  it.each([
    { dataspyId: 'other', label: 'wrong DATASPY id' },
    { gridId: 'other', label: 'wrong GRIDID' },
    { gridName: 'other', label: 'wrong GRIDNAME' },
    { includeMetadata: false, label: 'missing metadata' },
  ])('rejects $label instead of accepting an unverified empty source', (options) => {
    expect(() => parseNotesTracesResponse(fixtureBody(options), { parentBinding: parent }))
      .toThrowError(/INVALID_RESPONSE/);
  });

  it('keeps observed trace row fields and leaves unmapped state unknown', () => {
    const result = parseNotesTracesResponse(fixtureBody({ rows: [row()] }), {
      parentBinding: parent,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      traceId: 'TRACE-1',
      reservationStayId: parent.reservationStayId,
      traceDetails: 'Synthetic trace detail',
      created: '2026-09-17T09:00:00',
      dueDate: '2026-09-18',
      deliveryMethod: 'EMAIL',
      status: null,
    });
  });

  it('binds the observed row shape to pageData.values when rows omit reservationstayid', () => {
    const observedRow = row();
    delete observedRow.reservationstayid;

    const result = parseNotesTracesResponse(fixtureBody({ rows: [observedRow] }), {
      parentBinding: parent,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.reservationStayId).toBe(parent.reservationStayId);
    expect(() =>
      parseNotesTracesResponse(fixtureBody({ rows: [row({ reservationstayid: 'OTHER-STAY' })] }), {
        parentBinding: parent,
      }),
    ).toThrowError(/PARENT_MISMATCH/);
    expect(() =>
      parseNotesTracesResponse(fixtureBody({ rows: [row({ reservationstayid: null })] }), {
        parentBinding: parent,
      }),
    ).toThrowError(/PARENT_MISMATCH/);
  });

  it('rejects missing or mismatched response parent instead of merging records', () => {
    expect(() =>
      parseNotesTracesResponse(fixtureBody({ reservationStayId: 'OTHER-STAY' }), {
        parentBinding: parent,
      }),
    ).toThrowError(/PARENT_MISMATCH/);
    expect(() =>
      parseNotesTracesResponse(fixtureBody({ propertyCode: 'OTHER' }), {
        parentBinding: parent,
      }),
    ).toThrowError(/PARENT_MISMATCH/);
    expect(() =>
      parseNotesTracesResponse('pageData: { values: {} }', { parentBinding: parent }),
    ).toThrowError(/PARENT_MISMATCH/);
  });

  it('rejects malformed envelope and duplicate trace ids', () => {
    expect(() =>
      parseNotesTracesResponse('not a pageData response', { parentBinding: parent }),
    ).toThrowError(/MALFORMED_RESPONSE/);
    expect(() =>
      parseNotesTracesResponse(fixtureBody({ rows: [row(), row()] }), {
        parentBinding: parent,
      }),
    ).toThrowError(NotesTracesParseError);
  });

  it('posts only exact detail-bound TRC fields and preserves parent proof', async () => {
    const postForm = vi.fn(async (url: string, fields: Record<string, string>) => {
      expect(url).toBe(`https://hms.example${NOTES_TRACES_READ_PATH}`);
      expect(Object.keys(fields).sort()).toEqual([
        'CURRENT_TAB_NAME',
        'SYSTEM_FUNCTION_NAME',
        'USER_FUNCTION_NAME',
        'account',
        'bookingdotcomid',
        'confirmationnumber',
        'facebookid',
        'firstname',
        'guestfullname',
        'guestid',
        'hoteldate',
        'lastname',
        'propertycode',
        'reservationstayid',
        'room',
        'tripadvisorid',
        'twitterid',
      ]);
      expect(fields.CURRENT_TAB_NAME).toBe('TRC');
      expect(fields.confirmationnumber).toBe(parent.confirmationNumber);
      expect(fields.reservationstayid).toBe(parent.reservationStayId);
      return fixtureBody();
    });
    const session = { origin: 'https://hms.example', page: { postForm } } as never;

    const result = await createNotesTracesReadFacade(session).read({
      parentBinding: parent,
      detailValues,
    });

    expect(postForm).toHaveBeenCalledTimes(1);
    expect(postForm).toHaveBeenCalledWith(
      `https://hms.example${NOTES_TRACES_READ_PATH}`,
      expect.any(Object),
      { maxBytes: 32 * 1024, timeoutMs: 5_000 },
    );
    expect(result.parentBinding).toEqual(parent);
  });

  it('rejects incomplete detail binding before POST', async () => {
    const postForm = vi.fn();
    const session = { origin: 'https://hms.example', page: { postForm } } as never;

    await expect(
      createNotesTracesReadFacade(session).read({
        parentBinding: parent,
        detailValues: { confirmationnumber: parent.confirmationNumber },
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe('TRC provider driver branch', () => {
  it('exposes staff traces while customer remains withheld without printability proof', async () => {
    const providerResult = parseNotesTracesResponse(fixtureBody({ rows: [row()] }), {
      parentBinding: parent,
    });
    const result = await observeNotesTraces(
      authorization,
      {
        resourceRef: parent.resourceRef!,
        states: ['open'],
        limit: 20,
        audience: 'staff',
      },
      new AbortController().signal,
      { notesTracesFor: async () => providerResult, expectedParentBinding: parent as Required<typeof parent> },
    );

    expect(result.status).toBe('partial');
    expect(result.unavailableSections).toEqual([
      { section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' },
    ]);
    expect(result.data?.traces).toMatchObject({ state: 'available' });
    const traces = result.data?.traces;
    if (!traces || !('data' in traces) || !traces.data) throw new Error('trace data missing');
    expect(traces.data.items).toHaveLength(1);
    expect(traces.data.items[0]).toMatchObject({
      permittedText: { value: 'Synthetic trace detail' },
      customerPrintable: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
      audience: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
      status: { state: 'known', value: 'open' },
      createdAt: { value: '2026-09-17T09:00:00' },
      dueAt: { value: '2026-09-18' },
      method: { value: 'EMAIL' },
    });
    expect(JSON.stringify(result)).not.toContain('customer_disclosable');

    const customerResult = await observeNotesTraces(
      authorization,
      {
        resourceRef: parent.resourceRef!,
        states: ['open'],
        limit: 20,
        audience: 'customer',
      },
      new AbortController().signal,
      { notesTracesFor: async () => providerResult, expectedParentBinding: parent as Required<typeof parent> },
    );
    expect(customerResult.data?.traces).toMatchObject({
      state: 'available',
      completeness: 'complete',
      data: {
        items: [],
        page: { returnedCount: 0, hasMore: false, nextCursor: null },
      },
    });
    expect(JSON.stringify(customerResult)).not.toContain('Synthetic trace detail');
  });

  it('does not treat the observed users recipient field as the trace author', async () => {
    const providerResult = parseNotesTracesResponse(
      fixtureBody({
        rows: [row({
          createdby: null,
          users: 'synthetic-recipient',
          tracestatus_display: 'Delivered',
          completed: false,
          cancelled: false,
        })],
      }),
      { parentBinding: parent },
    );
    const result = await observeNotesTraces(
      authorization,
      {
        resourceRef: parent.resourceRef!,
        states: ['open'],
        limit: 20,
        audience: 'staff',
      },
      new AbortController().signal,
      {
        notesTracesFor: async () => providerResult,
        expectedParentBinding: parent as Required<typeof parent>,
      },
    );

    const traces = result.data?.traces;
    if (!traces || !('data' in traces) || !traces.data) throw new Error('trace data missing');
    expect(traces.data.items).toHaveLength(1);
    expect(traces.data.items[0]?.authorLabel).toMatchObject({
      state: 'unknown',
      reasonCode: 'NOT_APPLICABLE',
    });
    expect(traces.data.items[0]?.status).toMatchObject({
      state: 'known',
      value: 'open',
    });
  });

  it('projects verified boolean task state separately from Delivered display text', async () => {
    const providerResult = parseNotesTracesResponse(
      fixtureBody({
        rows: [
          row({
            traceid: 'TRACE-OPEN',
            tracestatus_display: 'Delivered',
            completed: false,
            cancelled: false,
          }),
          row({
            traceid: 'TRACE-COMPLETED',
            tracestatus_display: 'Delivered',
            completed: true,
            cancelled: false,
          }),
        ],
      }),
      { parentBinding: parent },
    );
    const result = await observeNotesTraces(
      authorization,
      {
        resourceRef: parent.resourceRef!,
        states: ['open', 'completed'],
        limit: 20,
        audience: 'staff',
      },
      new AbortController().signal,
      {
        notesTracesFor: async () => providerResult,
        expectedParentBinding: parent as Required<typeof parent>,
      },
    );

    const traces = result.data?.traces;
    if (!traces || !('data' in traces) || !traces.data) throw new Error('trace data missing');
    expect(traces.data.items.map((item) => item.status)).toEqual([
      expect.objectContaining({ state: 'known', value: 'open' }),
      expect.objectContaining({ state: 'known', value: 'completed' }),
    ]);
    expect(traces.data.items.every((item) => item.deliveredAt.state === 'unknown')).toBe(true);
  });

  it('filters observed completed flags separately from Delivered display text', async () => {
    const providerResult = parseNotesTracesResponse(
      fixtureBody({
        rows: [row({
          tracestatus_display: 'Delivered',
          completed: false,
          cancelled: false,
        })],
      }),
      { parentBinding: parent },
    );
    const run = (states: ['open'] | ['completed']) => observeNotesTraces(
      authorization,
      {
        resourceRef: parent.resourceRef!,
        states,
        limit: 20,
        audience: 'staff',
      },
      new AbortController().signal,
      {
        notesTracesFor: async () => providerResult,
        expectedParentBinding: parent as Required<typeof parent>,
      },
    );

    const openResult = await run(['open']);
    const completedResult = await run(['completed']);
    const openTraces = openResult.data?.traces;
    const completedTraces = completedResult.data?.traces;
    if (!openTraces || !('data' in openTraces) || !openTraces.data) {
      throw new Error('open trace data missing');
    }
    if (!completedTraces || !('data' in completedTraces) || !completedTraces.data) {
      throw new Error('completed trace data missing');
    }
    expect(openTraces.data.items).toHaveLength(1);
    expect(completedTraces.data.items).toHaveLength(0);
  });

  it('keeps source hash from actual TRC response in trace evidence', async () => {
    const providerResult = parseNotesTracesResponse(fixtureBody({ rows: [row()] }), {
      parentBinding: parent,
    });
    const result = await observeNotesTraces(
      authorization,
      {
        resourceRef: parent.resourceRef!,
        states: ['open'],
        limit: 20,
        audience: 'staff',
      },
      new AbortController().signal,
      { notesTracesFor: async () => providerResult, expectedParentBinding: parent as Required<typeof parent> },
    );

    expect(result.evidence[0]?.sourceHash).toBe(providerResult.sourceHash);
    expect(result.evidence[0]?.sourceHash).not.toBe(
      createHash('sha256').update(JSON.stringify(result.data)).digest('hex'),
    );
  });

  it.each(['PARENT_MISMATCH', 'SCOPE_DENIED'] as const)(
    'keeps TRC provider %s denied without detail fallback',
    async (code) => {
      const detailDumpFor = vi.fn(async () => null);
      const result = await observeNotesTraces(
        authorization,
        {
          resourceRef: parent.resourceRef!,
          states: ['open'],
          limit: 20,
          audience: 'staff',
        },
        new AbortController().signal,
        {
          expectedParentBinding: parent as Required<typeof parent>,
          notesTracesFor: async () => {
            throw new HmsRuntimeError(code, 'synthetic TRC scope failure');
          },
          detailDumpFor,
        },
      );

      expect(detailDumpFor).not.toHaveBeenCalled();
      expect(result.status).toBe('manual_required');
      expect(result.completeness).toBe('unknown');
      expect(result.unavailableSections).toEqual([
        { section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' },
        { section: 'traces', reasonCode: 'SCOPE_DENIED' },
      ]);
      expect(result.evidence[0]?.scopeVerified).toBe(false);
    },
  );
});
