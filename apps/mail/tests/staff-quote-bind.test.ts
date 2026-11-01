import { describe, expect, it, vi } from 'vitest';
import {
  bindExecuteStaffQuote,
  bindReadBackStaffQuote,
  bindStaffActions,
  bindStaffQuoteStrategy,
  bindStaffQuoteStrategies,
  resolveNativeRoomCodes,
  readStaffActions,
  staffQuoteGroupsFromStay,
  type ExecuteStaffQuoteInput,
  type StaffQuoteJobQuery,
} from '../lib/quote-workflow/staff-quote-bind';
import { mapStaffActions } from '../lib/quote-workflow/review-items';
import {
  HRCEN_PROPERTY_CODE,
  HRDAV_PROPERTY_CODE,
  HRDAV_RATE_PLANS,
  HRDAV_ROOM_NAMES,
  emptyStaffQuoteHeader,
  type QuoteSalesStrategy,
  hrdavBoardFromLabel,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

const stay = (overrides: Partial<StayGroupRequirement> = {}): StayGroupRequirement => ({
  id: 'g1',
  arrivalDate: '2026-11-16',
  departureDate: '2026-11-17',
  quantity: 1,
  adults: 1,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: {},
  ...overrides,
});

it('keeps a metadata-only unread attachment visible to staff without a file hash', () => {
  const action = { id:'source:large:metadata',kind:'business_document_failure',text:'Open the original',
    sourceRef:'large',sourceIdentity:'metadata_only',sourceKind:'attachment',messageId:'mail-1',
    filename:'rooming.xlsx',blockingQuote:false,status:'open' };
  const parsed = readStaffActions({ staffActions:[action,{...action,id:'bad',sourceKind:'message'},
    {...action,id:'bad-hash',sourceHash:'a'.repeat(64)}] });
  expect(parsed).toHaveLength(1);
  expect(mapStaffActions(parsed)).toMatchObject([{sourceRef:'large',messageId:'mail-1',filename:'rooming.xlsx'}]);
  expect(mapStaffActions(parsed)[0]?.sourceHash).toBeUndefined();
});

it('keeps a number-masked workbook warning visibly readable', () => {
  const reason='Card-like numbers were masked in this spreadsheet; check the original before relying on those cells.';
  const action={id:'source:sheet:hash',kind:'business_document_failure',text:`rooms.xlsx: ${reason}`,
    sourceRef:'sheet',sourceHash:'a'.repeat(64),sourceKind:'attachment',messageId:'mail-1',filename:'rooms.xlsx',
    reason,readable:true,blockingQuote:false,status:'open'} as const;
  expect(mapStaffActions(readStaffActions({staffActions:[action]}))).toMatchObject([{
    kind:'document_failure',text:'rooms.xlsx: some details need review',reason,readable:true,
  }]);
});

it('loads the current review for the selected message', async () => {
  const action = { id:'request:shuttle',kind:'unanswered_question',text:'Can we arrange a shuttle?',
    sourceRef:'message:mail-1',sourceHash:'a'.repeat(64),sourceKind:'message',messageId:'mail-1',
    blockingQuote:false,status:'open' };
  const query = vi.fn().mockResolvedValue({replyToMessageId:'mail-1',reviewSummary:{staffActions:[action]}});
  expect(await bindStaffActions({query,threadId:'thread-1',messageId:'mail-1'})).toEqual({kind:'ready',actions:[action]});
  expect(query).toHaveBeenCalledWith({threadId:'thread-1',messageId:'mail-1'});
});

it('does not use a review for another message', async () => {
  const query = vi.fn().mockResolvedValue({replyToMessageId:'mail-0',reviewSummary:{staffActions:[]}});
  expect((await bindStaffActions({query,threadId:'thread-1',messageId:'mail-1'})).kind).toBe('unavailable');
});

it('binds prepared tasks to the selected email review', async () => {
  const newest = {id:'cancel',kind:'cancel_request',label:'Review cancellation',state:'Pending staff action',details:['Fee is unknown.','No cancellation has been saved.']};
  const query = vi.fn().mockResolvedValue({replyToMessageId:'mail-1',reviewSummary:{staffActions:[],tasks:[newest]}});
  expect(await bindStaffActions({query,threadId:'thread',messageId:'mail-1'})).toEqual({kind:'ready',actions:[],tasks:[newest]});
  expect(query).toHaveBeenCalledWith({threadId:'thread',messageId:'mail-1'});
});

it('binds a booking suggestion to its selected email and rejects malformed room identities', async () => {
  const source = {sourceRef:'message:mail-1',sourceHash:'a'.repeat(64),page:1,start:0,end:12};
  const suggestion = {version:1,taskId:'book',status:'prefill',displayOnly:true,saved:false,staffSourceHash:'c'.repeat(64),source,groupId:'book_123',
    draft:{rooms:[{groupId:'book_123',roomIndex:1,request:{arrival:'2027-04-01'},schemaErrors:[]}],rateCheck:[],missing:[],flags:[]},
    options:{track:[],sourceOfBusiness:[],guaranteeType:[],roomType:[]},facts:{dates:[{source}],rooms:[],guests:[],boards:[],parties:[]},partyNames:[],missing:[]};
  const task = {id:'book',kind:'new_booking',label:'Prepare booking',state:'Needs review',details:[],handled:false,bookingSuggestion:suggestion};
  const envelope = {replyToMessageId:'mail-1',runId:'run',workItemId:'item',reviewSummary:{tasks:[task]}};
  const query = vi.fn().mockResolvedValue(envelope);
  const result = await bindStaffActions({query,threadId:'thread',messageId:'mail-1',workItemId:'item'});
  expect(result).toMatchObject({kind:'ready',tasks:[{bookingSuggestion:{...suggestion,selectedMessageId:'mail-1'}}]});
  query.mockResolvedValue({...envelope,reviewSummary:{tasks:[{...task,bookingSuggestion:{...suggestion,
    draft:{...suggestion.draft,rooms:[{...suggestion.draft.rooms[0],groupId:'other'}]}}}]}});
  const malformed = await bindStaffActions({query,threadId:'thread',messageId:'mail-1',workItemId:'item'});
  expect(malformed.kind === 'ready' && malformed.tasks?.[0]?.bookingSuggestion).toBeUndefined();
  query.mockResolvedValue({...envelope,reviewSummary:{tasks:[{...task,bookingSuggestion:{...suggestion,partyNames:undefined}}]}});
  const withoutPartyContext = await bindStaffActions({query,threadId:'thread',messageId:'mail-1',workItemId:'item'});
  expect(withoutPartyContext.kind === 'ready' && withoutPartyContext.tasks?.[0]?.bookingSuggestion).toBeUndefined();
});

it('keeps independent handled states attached to the selected work item and run', async () => {
  const query = vi.fn().mockResolvedValue({replyToMessageId:'mail-1',runId:'run-1',workItemId:'item-1',reviewSummary:{tasks:[
    {id:'one',kind:'question',label:'Answer question',state:'Needs review',details:['Request: Parking?'],handled:true},
    {id:'two',kind:'existing_document',label:'Provide document',state:'Needs review',details:['Request: Invoice?'],handled:false},
  ]}});
  const result = await bindStaffActions({query,threadId:'thread',messageId:'mail-1',workItemId:'item-1'});
  expect(result).toMatchObject({kind:'ready',tasks:[{id:'one',handled:true,runId:'run-1',workItemId:'item-1'},
    {id:'two',handled:false,runId:'run-1',workItemId:'item-1'}]});
  expect(query).toHaveBeenCalledWith({threadId:'thread',messageId:'mail-1',workItemId:'item-1'});
});

it('keeps an earlier unresolved task even if a rerun reused its task id', async () => {
  const task = {id:'same',kind:'question',label:'Review',state:'Needs review',details:['Check request'],handled:false};
  const query = vi.fn().mockResolvedValue({replyToMessageId:'mail-1',runId:'new',workItemId:'item',reviewSummary:{tasks:[
    task, {...task,runId:'old',label:'Earlier request'},
  ]}});
  const result = await bindStaffActions({query,threadId:'thread',messageId:'mail-1',workItemId:'item'});
  expect(result).toMatchObject({kind:'ready',tasks:[{id:'same',runId:'new'},{id:'same',runId:'old'}]});
});

it('keeps the final no-save notice when a long prepared booking is shortened', async () => {
  const details = [...Array.from({length: 410}, (_, index) => `Night ${index}`), 'No booking has been saved.'];
  const task = {id:'book',kind:'new_booking',label:'Prepare booking',state:'Pending staff action',details};
  const query = vi.fn().mockResolvedValue({replyToMessageId:'mail-1',reviewSummary:{tasks:[task]}});
  const result = await bindStaffActions({query,threadId:'thread',messageId:'mail-1'});
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.tasks?.[0]?.details).toContain('No booking has been saved.');
  expect(result.tasks?.[0]?.details).toContain('Some prepared details are not shown. Check the request and HMS.');
});

describe('HRDAV native room and board maps', () => {
  it('resolves Da Vinci room names on HRDAV and leaves Centurion-only types unknown', () => {
    expect(resolveNativeRoomCodes({ roomPreference: 'Junior Suite', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['JNRSUI'],
    });
    expect(resolveNativeRoomCodes({ roomCodes: ['EXKNGB'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['EXKNGB'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'SUITE', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'unresolved',
      label: 'SUITE',
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Queen', propertyCode: HRCEN_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STQN'],
    });
  });

  it('normalizes each HRDAV room label as staff spellings and keeps HRCEN normalization', () => {
    for (const [code, label] of Object.entries(HRDAV_ROOM_NAMES)) {
      expect(
        resolveNativeRoomCodes({
          roomPreference: `  ${label.toUpperCase().replace(/ /g, '   ')} ROOMS `,
          propertyCode: HRDAV_PROPERTY_CODE,
        }),
      ).toEqual({ status: 'codes', codes: [code] });
    }
    expect(
      resolveNativeRoomCodes({ roomPreference: 'STANDARD TWIN ROOM', propertyCode: HRDAV_PROPERTY_CODE }),
    ).toEqual({ status: 'codes', codes: ['STWN'] });
    expect(resolveNativeRoomCodes({ roomCodes: ['DLX-KNG'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['DLXKNG'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'DLX KNG', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['DLXKNG'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'STD TWN', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Deluxe Patio', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['DLXPAT'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'STD SGL', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'unresolved',
      label: 'STD SGL',
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard King', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STKNG'],
    });
    expect(
      resolveNativeRoomCodes({ roomPreference: 'Standard & Queen Rooms', propertyCode: HRCEN_PROPERTY_CODE }),
    ).toEqual({ status: 'codes', codes: ['STQN'] });
    expect(
      resolveNativeRoomCodes({ roomPreference: '2 rooms Deluxe Twin', propertyCode: HRCEN_PROPERTY_CODE }),
    ).toEqual({ status: 'codes', codes: ['DLXTWN'] });
    expect(
      resolveNativeRoomCodes({ roomPreference: 'Standard RoomQueen Bed', propertyCode: HRCEN_PROPERTY_CODE }),
    ).toEqual({ status: 'codes', codes: ['STQN'] });
  });

  it('does not use a hotel room list or twin fallback for an unknown property', () => {
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Queen', propertyCode: 'UNKNOWN' })).toEqual({
      status: 'unresolved',
      label: 'Standard Queen',
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Twin', propertyCode: 'UNKNOWN' })).toEqual({
      status: 'unresolved',
      label: 'Twin',
    });
    expect(staffQuoteGroupsFromStay([stay()], 'UNKNOWN')).toEqual({
      error: expect.stringMatching(/Could not identify the hotel/i),
    });
  });

  it('keeps shared DLXKNG and STWN codes on HRDAV without using the Centurion room list as a fallback', () => {
    expect(resolveNativeRoomCodes({ roomCodes: ['DLXKNG'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['DLXKNG'],
    });
    expect(resolveNativeRoomCodes({ roomCodes: ['STWN'], propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
    expect(HRDAV_ROOM_NAMES.DLXKNG).toBe('Deluxe King');
    expect(HRDAV_ROOM_NAMES.STWN).toBe('Standard Twin');
    expect(HRDAV_ROOM_NAMES).not.toHaveProperty('STQN');
    expect(HRDAV_ROOM_NAMES).not.toHaveProperty('SUITE');
    const unknown = staffQuoteGroupsFromStay([stay({ roomPreference: 'PENTHOUSE', fields: {} })], HRDAV_PROPERTY_CODE);
    expect(unknown).toEqual({
      error: expect.stringMatching(/JNRSUI/),
    });
    if ('error' in unknown) {
      expect(unknown.error).not.toMatch(/STQN|SUITE|DLXTWN/);
    }
  });

  it('maps observed HRDAV board labels and leaves dinner and invented codes unknown', () => {
    expect(hrdavBoardFromLabel('Bed & Breakfast R')).toBe('bb');
    expect(hrdavBoardFromLabel(null)).toBe('unknown');
    expect(hrdavBoardFromLabel('')).toBe('unknown');
    expect(hrdavBoardFromLabel('DBB')).toBe('unknown');
    expect(hrdavBoardFromLabel('BB')).toBe('unknown');
    expect(HRDAV_RATE_PLANS.BAR.board).toBe('bb');
    expect(HRDAV_RATE_PLANS.BARRO.board).toBe('room_only');
    expect(HRDAV_RATE_PLANS.BLRB.board).toBe('unknown');
    expect(HRDAV_RATE_PLANS.BARDIS.board).toBe('unknown');
    expect(HRDAV_RATE_PLANS.DEF.board).toBe('unknown');
    expect(
      staffQuoteGroupsFromStay([stay({ board: 'dinner_bb', roomPreference: 'STKNG' })], HRDAV_PROPERTY_CODE),
    ).toEqual({
      error: expect.stringMatching(/meal plan/i),
    });
  });

  it('leaves Bed & Breakfast NR unknown instead of rewriting it to R', () => {
    expect(hrdavBoardFromLabel('Bed & Breakfast NR')).toBe('unknown');
    expect(hrdavBoardFromLabel('bed & breakfast nr')).toBe('unknown');
  });

  it('leaves a blank BARRO board unknown instead of rewriting it to room only', () => {
    expect(hrdavBoardFromLabel(null)).toBe('unknown');
    expect(hrdavBoardFromLabel('')).toBe('unknown');
  });

  it('leaves an unqualified twin unknown instead of mapping it to STWN', () => {
    expect(resolveNativeRoomCodes({ roomPreference: 'twin', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'unresolved',
      label: 'twin',
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Twin', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
    expect(resolveNativeRoomCodes({ roomPreference: 'Std. Twin', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'codes',
      codes: ['STWN'],
    });
    expect(
      resolveNativeRoomCodes({
        roomPreference: 'Standard Twin Rooms - double occupancy',
        propertyCode: HRDAV_PROPERTY_CODE,
      }),
    ).toEqual({ status: 'codes', codes: ['STWN'] });
    expect(resolveNativeRoomCodes({ roomPreference: 'Deluxe Twin', propertyCode: HRDAV_PROPERTY_CODE })).toEqual({
      status: 'unresolved',
      label: 'Deluxe Twin',
    });
    const allRooms = staffQuoteGroupsFromStay(
      [stay({ roomPreference: 'Twin', fields: { roomPreference: 'defaulted' } })],
      HRDAV_PROPERTY_CODE,
    );
    expect(allRooms).toMatchObject({ ok: [{ id: 'g1' }] });
    if ('ok' in allRooms) expect(allRooms.ok[0]).not.toHaveProperty('roomCodes');
  });

  it('does not inherit a Centurion-only room alias on HRDAV', () => {
    expect(
      resolveNativeRoomCodes({
        roomPreference: 'standard queen room',
        propertyCode: HRDAV_PROPERTY_CODE,
      }),
    ).toEqual({
      status: 'unresolved',
      label: 'standard queen room',
    });
  });

  it('refuses a staff quote with no mailbox property instead of treating it as Centurion', async () => {
    const reason = /hotel.*mailbox|mailbox.*hotel/i;
    expect(staffQuoteGroupsFromStay([stay({ roomPreference: 'Standard Queen' })])).toMatchObject({
      ok: [{ roomCodes: ['STQN'] }],
    });

    const mutate = vi.fn();
    const result = await bindExecuteStaffQuote({
      source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) },
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay()],
      header: {} as never,
      mutate,
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(reason) });
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('staff quote strategy comparisons', () => {
  const strategies: QuoteSalesStrategy[] = [
    { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
    { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
    { code: 'PRESET', label: 'Preset', requestValue: 'PRESET' },
    { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
    { code: 'NC', label: 'Negoticated Contracted', requestValue: 'NC' },
    { code: 'GOV', label: 'Government', requestValue: 'Government' },
  ];

  const args = {
    source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) },
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [stay({ roomPreference: 'Standard King' })],
    header: emptyStaffQuoteHeader(),
    propertyCode: HRDAV_PROPERTY_CODE,
    registryStrategies: strategies,
  };

  function queuedQuote(strategy: string, group: StayGroupRequirement) {
    return {
      status: 'ready',
      workflowRunId: `workflow-${strategy}`,
      revisionRef: `revision-${strategy}`,
      messageId: 'mail-1',
      threadId: 'thread-1',
      factRefs: [],
      selectionEpoch: 1,
      inputRevision: 1,
      inputDigest: `digest-${strategy}`,
      totalMinor: 100_00,
      currency: 'ZAR',
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      description: 'Standard King · Bed & Breakfast',
      rateOptions: [
        {
          id: `option-${strategy}`,
          groupId: group.id,
          board: 'bb',
          boardLabel: 'Bed & Breakfast',
          rateCode: 'BAR',
          rateLabel: 'Best available',
          roomCode: 'STKNG',
          roomLabel: 'Standard King',
          contract: false,
          onlyContract: false,
          matchesRequest: true,
          perNightMinor: 100_00,
          totalMinor: 100_00,
          currency: 'ZAR',
          priced: 'full',
          selected: true,
        },
      ],
    };
  }

  it('binds every configured strategy independently and keeps no-room results partial', async () => {
    const staffQuoteJob = vi.fn<StaffQuoteJobQuery>(async (lookup) => {
      if (!('input' in lookup)) return null;
      const request = lookup.input as unknown as Record<string, unknown>;
      const salesStrategy = String(request.salesStrategy);
      const runId = `run-${salesStrategy}`;
      return salesStrategy === 'WS'
        ? {
            runId,
            status: 'done' as const,
            prefetch: true,
            asOf: new Date().toISOString(),
            failureClass: null,
            request: { kind: 'staff_quote' as const, input: request as never },
            result: {
              ok: false,
              code: 'NATIVE_NO_MATCHING_RATE',
              message: 'HMS has no rate for this meal plan under Wholesale.',
            },
          }
        : {
            runId,
            status: 'done' as const,
            prefetch: true,
            asOf: new Date().toISOString(),
            failureClass: null,
            request: { kind: 'staff_quote' as const, input: request as never },
            result: queuedQuote(salesStrategy, args.groups[0]!),
          };
    });

    const results = await bindStaffQuoteStrategies({ ...args, staffQuoteJob });

    expect(results).toHaveLength(6);
    expect(results.map((item) => item.strategyCode).sort()).toEqual(
      strategies.map((item) => item.code).sort(),
    );
    expect(results.filter((item) => item.row.status === 'ready')).toHaveLength(5);
    expect(results.find((item) => item.strategyCode === 'WS')?.row).toMatchObject({
      status: 'not_offered',
      message: expect.stringMatching(/no rate/i),
    });
    expect(staffQuoteJob).toHaveBeenCalledTimes(6);
    expect(staffQuoteJob.mock.calls.map(([lookup]) => ('input' in lookup ? lookup.input.salesStrategy : '')).sort()).toEqual(
      ['BAR', 'Government', 'NC', 'PRESET', 'PROMO', 'WS'].sort(),
    );
    expect(results.find((item) => item.strategyCode === 'BAR')).toMatchObject({
      row: {
        status: 'ready',
        roomLabels: ['Standard King'],
        boardLabels: ['Bed & Breakfast'],
        nightlyMinor: [10_000],
        totalMinor: 10_000,
      },
      result: { staffQuote: { preparedByNava: true } },
    });
  });

  it('does not shop a strategy absent from the active property registry', async () => {
    const staffQuoteJob = vi.fn(async () => null);
    const outcome = await bindStaffQuoteStrategy({
      ...args,
      registryStrategies: strategies.filter((item) => item.code === 'BAR' || item.code === 'GOV'),
      strategyCode: 'WS',
      staffQuoteJob,
    });

    expect(outcome.row).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/not configured.*no search was run/i),
    });
    expect(staffQuoteJob).not.toHaveBeenCalled();
  });

  it('refuses queue-disabled comparisons clearly and does not fall through to inline mutation', async () => {
    const mutate = vi.fn();
    const outcome = await bindStaffQuoteStrategy({
      ...args,
      strategyCode: 'BAR',
      mutate,
    } as never);

    expect(outcome.row).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/queue.*disabled.*no search was run/i),
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('classes a thrown comparison error as needs staff unless the message is an HMS outage', async () => {
    const genericHeader = emptyStaffQuoteHeader();
    Object.defineProperty(genericHeader, 'fieldErrors', {
      get() {
        throw new Error('The stay could not be qualified. Review the stay inputs.');
      },
    });
    const generic = await bindStaffQuoteStrategy({
      ...args,
      strategyCode: 'BAR',
      header: genericHeader,
      staffQuoteJob: async () => null,
    });
    expect(generic.row).toMatchObject({
      status: 'failed',
      causeClass: 'needs_staff',
    });

    const outageHeader = emptyStaffQuoteHeader();
    Object.defineProperty(outageHeader, 'fieldErrors', {
      get() {
        throw new Error("HMS didn't answer.");
      },
    });
    const outage = await bindStaffQuoteStrategy({
      ...args,
      strategyCode: 'BAR',
      header: outageHeader,
      staffQuoteJob: async () => null,
    });
    expect(outage.row).toMatchObject({
      status: 'failed',
      causeClass: 'hms_down',
    });
  });

  it('keeps the HRCEN BAR and Government request values unchanged', async () => {
    const hrcenStrategies: QuoteSalesStrategy[] = [
      { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
      { code: 'GOV', label: 'Government', requestValue: 'Government' },
    ];
    const staffQuoteJob = vi.fn<StaffQuoteJobQuery>(async (lookup) => {
      if (!('input' in lookup)) return null;
      const request = lookup.input as unknown as Record<string, unknown>;
      const runId = `run-${request.salesStrategy}`;
      return {
        runId,
        status: 'done' as const,
        prefetch: true,
        asOf: new Date().toISOString(),
        failureClass: null,
        request: { kind: 'staff_quote' as const, input: request as never },
        result: queuedQuote(String(request.salesStrategy), stay()),
      };
    });

    await bindStaffQuoteStrategies({
      ...args,
      propertyCode: HRCEN_PROPERTY_CODE,
      registryStrategies: hrcenStrategies,
      staffQuoteJob,
    });

    expect(staffQuoteJob.mock.calls.map(([lookup]) => ('input' in lookup ? lookup.input.salesStrategy : '')).sort()).toEqual(['BAR', 'Government']);
  });

  it('binds a U6a all-room job when the pane adds its option-count counter', async () => {
    const group = stay();
    const staffQuoteJob = vi.fn<StaffQuoteJobQuery>(async (lookup) => {
      if (!('input' in lookup)) return null;
      const preparedInput = { ...lookup.input };
      delete preparedInput.maxOptionsPerGroup;
      return {
        runId: 'run-BAR',
        status: 'done',
        prefetch: true,
        asOf: new Date().toISOString(),
        failureClass: null,
        request: { kind: 'staff_quote', input: preparedInput },
        result: queuedQuote('BAR', group),
      };
    });

    const outcome = await bindStaffQuoteStrategy({
      ...args,
      groups: [group],
      strategyCode: 'BAR',
      staffQuoteJob,
    });

    expect(staffQuoteJob.mock.calls[0]?.[0]).toMatchObject({ input: { maxOptionsPerGroup: 200 } });
    expect(outcome.row.status).toBe('ready');
  });

  it('hydrates a prepared contract run only for the same bound party and price shape', async () => {
    const agency = { kind: 'agency' as const, nativeId: 'agency-17', name: 'Acme Travel' };
    const header = { ...emptyStaffQuoteHeader(), parties: { agency } };
    const run = async (changes: Partial<ExecuteStaffQuoteInput> = {}, prefetch = true) => {
      const query = vi.fn<StaffQuoteJobQuery>(async (lookup) => {
        if (!('input' in lookup)) return null;
        return {
          runId: 'run-WS', status: 'done', prefetch, asOf: new Date().toISOString(), failureClass: null,
          request: { kind: 'staff_quote', input: { ...lookup.input, salesStrategy: 'WS', ...changes } },
          result: queuedQuote('WS', args.groups[0]!),
        };
      });
      return bindReadBackStaffQuote({ ...args, header, query });
    };
    expect(await run()).toMatchObject({ status: 'ok', staffQuote: { preparedByNava: true } });
    expect(await run({ parties: { agency: { ...agency, nativeId: 'other' } } })).toBeNull();
    expect(await run({ parties: undefined })).toBeNull();
    expect(await run({}, false)).toBeNull();
    expect(await run({ sourceHash: 'b'.repeat(64) })).toBeNull();
  });

  it('never hydrates an unbound prepared run under a different strategy', async () => {
    const query = vi.fn<StaffQuoteJobQuery>(async (lookup) => {
      if (!('input' in lookup)) return null;
      return {
        runId: 'run-WS', status: 'done', prefetch: true, asOf: new Date().toISOString(), failureClass: null,
        request: { kind: 'staff_quote', input: { ...lookup.input, salesStrategy: 'WS' } },
        result: queuedQuote('WS', args.groups[0]!),
      };
    });
    expect(await bindReadBackStaffQuote({ ...args, query })).toBeNull();
  });

  it('still requires the same source and strategy when matching prepared inputs', async () => {
    const group = stay();
    const mismatches: Array<Partial<ExecuteStaffQuoteInput>> = [
      { messageId: 'another-message' },
      { sourceHash: 'b'.repeat(64) },
      { salesStrategy: 'Government' },
    ];
    for (const mismatch of mismatches) {
      const staffQuoteJob = vi.fn<StaffQuoteJobQuery>(async (lookup) => {
        if (!('input' in lookup)) return null;
        const preparedInput = { ...lookup.input };
        delete preparedInput.maxOptionsPerGroup;
        Object.assign(preparedInput, mismatch);
        return {
          runId: 'run-BAR',
          status: 'done',
          prefetch: true,
          asOf: new Date().toISOString(),
          failureClass: null,
          request: { kind: 'staff_quote', input: preparedInput },
          result: queuedQuote('BAR', group),
        };
      });

      const outcome = await bindStaffQuoteStrategy({ ...args, groups: [group], strategyCode: 'BAR', staffQuoteJob });

      expect(outcome.row.status).toBe('failed');
    }
  });
});
