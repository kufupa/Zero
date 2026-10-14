import {
  staffQuoteInput,
  prepareStaffQuote,
  executeStaffQuote,
  attestStaffQuote,
  staffQuoteDinnerFallback,
  staffQuoteDinnerGroupIdsToRetryAsBb,
  buildStaffProposalFacts,
} from '../src/ai/staff-quote-workflow.js';
import { mapLlmDecision } from '../src/ai/quote-workflow-llm.js';
import { lunaAnalysisSchema } from '../src/ai/reservationist-decision.js';
import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { occupiedDates, type Board } from '../src/quote-proposal/quote-revision.js';
import { deriveAuthorizedExtraLines } from '../src/quote-proposal/quote-lines.js';
import { resolveLedgerProposal, resolvePreparedLedgerProposal } from '../src/trpc/routes/workstation.js';
import { describe, it, expect, vi, afterEach } from 'vitest';

const scope = {
  transportId: 'transport',
  userId: 'staff',
  threadId: 'thread',
  messageId: 'message',
  sourceHash: 'a'.repeat(64),
  propertyCode: 'HRCEN',
  messageAt: '2026-09-30T12:00:00Z',
  messageText: 'Original email with incomplete occupancy and a shuttle question',
};
const input = () =>
  staffQuoteInput.parse({
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: 3,
    inputRevision: 2,
    groups: [
      {
        id: 'single',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-15',
        quantity: 2,
        adults: 1,
        childrenAges: [],
        board: 'room_only',
        roomCodes: ['SKNG'],
      },
    ],
  });

function modelDinnerBoard(board: 'dbb' | 'half_board'): Board {
  const decision = mapLlmDecision(
    lunaAnalysisSchema.parse({
      workflow: 'quote',
      flags: [],
      groups: [{
        arrival: '2026-10-12',
        departure: '2026-10-15',
        rooms: 2,
        adultsPerRoom: 1,
        childAges: [],
        board,
        roomPreference: null,
        guestNames: [],
      }],
      party: { kind: 'private', name: null, reference: null },
      rateClaims: [],
      missing: [],
      evidence: [],
      tasks: [{ kind: 'quote', groupIndexes: [0], note: 'Quote the requested stay' }],
    }),
  );
  return decision.groups[0]!.board;
}

async function fixture(confirmed = input()) {
  const prepared = prepareStaffQuote(
    confirmed,
    scope,
    { signerName: 'Staff', signerEmail: 'staff@example.test' },
    new AbortController().signal,
  );
  const calls: any[] = [];
  const options = {
    authorizationId: prepared.authorizationId,
    authorizeContext: async () => true,
    signer: { signerName: 'Staff', signerEmail: 'staff@example.test' },
    readQuote: async (request: any) => {
      calls.push(structuredClone(request));
      const normalize = await import('../tooling/playwright-quote/quote-contract.mjs' as string),
        normalized = normalize.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
      return {
        ref: 'source:' + calls.length,
        sha256: 'b'.repeat(64),
        toolVersion: 'fixture',
        observedAt: new Date().toISOString(),
        request: normalized,
        result: {
          outcome: 'quote',
          propertyCode: 'HRCEN',
          groups: normalized.rooms.map((r: any) => ({
            id: r.id,
            request: r,
            completeness: { search: 'complete', requiredFacts: 'complete' },
            options: [
              {
                id: 'option',
                room: { code: 'SKNG', label: 'Standard King', buildingCode: 'MAIN' },
                rate: { code: 'BARRO', label: 'Room Only' },
                board:
                  r.required?.boardBases?.[0] === 'breakfast'
                    ? 'Bed & Breakfast R'
                    : r.required?.boardBases?.[0] === 'dinner_bed_breakfast'
                      ? 'Dinner Bed & Breakfast R'
                      : 'Room Only R',
                appliedContext: Object.fromEntries(
                  Object.entries(normalized.rateContext ?? {}).map(([kind, party]: [string, any]) => [
                    kind,
                    { id: party.nativeId, name: party.name },
                  ]),
                ),
                rateScope: normalized.rateContext ? 'contextual' : 'public',
                eligibility: 'verified',
                availability: 'available',
                matchStatus: 'match',
                held: false,
                totals: { taxInclusive: true },
                nightly: occupiedDates(normalized.arrivalDate, normalized.departureDate).map(
                  (date, i) => ({
                    date,
                    inventory: 8,
                    price: {
                      amount: ['100.01', '500.00', '500.00'][i] ?? '500.00',
                      currency: 'ZAR',
                    },
                  }),
                ),
              },
            ],
          })),
        },
      };
    },
    resolvePolicy: async (_propertyCode: string, _rateCode: string, board: Board) => ({
      ref: 'policy',
      propertyCode: 'HRCEN',
      sourceHashes: ['c'.repeat(64)],
      authoredDates: ['2026-09-08'],
      families: [{ rateCode: 'BARRO', board }],
      vat: 'included' as const,
      levy: 'included' as const,
    }),
  };
  return { confirmed, prepared, calls, options };
}
afterEach(() => vi.useRealTimers());
describe('staff-approved quotation beneath native guards', () => {
  it('retries dinner boards as B&B without changing any other quote input', () => {
    const source = input();
    source.groups[0]!.board = 'dinner_bb';
    source.groups[0]!.rateCode = 'AGENCY';
    source.salesStrategy = 'Government';
    source.parties = {
      company: { kind: 'company', nativeId: 'co-17', name: 'Example Company' },
      agency: { kind: 'agency', nativeId: 'ag-29', name: 'Example Travel' },
    };
    source.rowPrices = [{ groupId: 'single', source: 'one_off', oneOffRate: 42_000 }];
    const { rateCode: _dinnerRateCode, ...fallbackGroup } = source.groups[0]!;

    const retry = staffQuoteDinnerFallback(source);

    expect(retry).toEqual({
      input: {
        ...source,
        groups: [{ ...fallbackGroup, board: 'bb' }],
      },
      groupIds: ['single'],
    });
    expect(retry?.input.groups[0]).not.toHaveProperty('rateCode');
    expect(source.groups[0]?.board).toBe('dinner_bb');
    expect(staffQuoteDinnerFallback(input())).toBeNull();
  });

  it('retries only dinner groups without a selected verified party contract rate', () => {
    const publicDinner = input();
    publicDinner.groups[0]!.board = 'dinner_bb';
    expect(
      staffQuoteDinnerGroupIdsToRetryAsBb(publicDinner, [
        { groupId: 'single', selected: true, contract: false, rateCode: 'BAR' },
      ]),
    ).toEqual(['single']);

    const contractedDinner = {
      ...publicDinner,
      parties: { company: { kind: 'company' as const, nativeId: 'co-17', name: 'Example Company' } },
    };
    // A government/public code is not a party contract just because it is not BAR.
    expect(
      staffQuoteDinnerGroupIdsToRetryAsBb(contractedDinner, [
        { groupId: 'single', selected: true, contract: false, rateCode: 'NGOVDB' },
      ]),
    ).toEqual(['single']);
    expect(
      staffQuoteDinnerGroupIdsToRetryAsBb(contractedDinner, [
        { groupId: 'single', selected: true, contract: true, rateCode: 'ACME1' },
      ]),
    ).toEqual([]);

    const mixed = {
      ...contractedDinner,
      groups: [
        ...contractedDinner.groups,
        { ...contractedDinner.groups[0]!, id: 'contract', rateCode: undefined },
      ],
    };
    expect(
      staffQuoteDinnerGroupIdsToRetryAsBb(mixed, [
        { groupId: 'single', selected: true, contract: false, rateCode: 'NGOVDB' },
        { groupId: 'contract', selected: true, contract: true, rateCode: 'ACME1' },
      ]),
    ).toEqual(['single']);
    expect(staffQuoteDinnerGroupIdsToRetryAsBb(input(), [])).toEqual([]);
  });

  it('can apply the B&B retry to only the uncontracted dinner groups', () => {
    const source = input();
    source.groups[0]!.board = 'dinner_bb';
    source.groups[0]!.rateCode = 'NGOVDB';
    source.groups.push({ ...source.groups[0]!, id: 'contract', rateCode: 'ACME1' });

    const retry = staffQuoteDinnerFallback(source, ['single']);

    expect(retry?.groupIds).toEqual(['single']);
    expect(retry?.input.groups[0]).toMatchObject({ id: 'single', board: 'bb' });
    expect(retry?.input.groups[0]).not.toHaveProperty('rateCode');
    expect(retry?.input.groups[1]).toEqual(source.groups[1]);
    expect(retry?.input.dinnerAllowanceGroupIds).toBeUndefined();
  });

  it.each([
    ['omitted', false],
    ['explicit whole-stay', true],
  ])(
    'prices a manual dinner add-on across mixed B&B groups after retry (%s scope)',
    async (_scope, explicit) => {
      const source = input();
      const group = source.groups[0]!;
      source.groups = [
        { ...group, id: 'bb', quantity: 1, adults: 2, board: 'bb' },
        { ...group, id: 'dinner', quantity: 1, adults: 1, board: 'dinner_bb' },
      ];
      source.dinnerAllowanceMinor = 12_500;
      source.dinnerAllowanceUnit = 'per_person_per_night';
      if (explicit) source.dinnerAllowanceGroupIds = ['bb', 'dinner'];

      const retry = staffQuoteDinnerFallback(source)!;
      expect(retry.groupIds).toEqual(['dinner']);
      const f = await fixture(retry.input);
      const revision = await executeStaffQuote(
        f.prepared,
        createReservationistBusinessServices(f.options, f.prepared.approval),
        async () => true,
      );
      const proposal = buildStaffProposalFacts(retry.input, scope, f.prepared, revision, {
        dinnerFallbackGroupIds: retry.groupIds,
      });

      expect(proposal.facts?.extras[0]).toMatchObject({
        units: 9,
        groupIds: ['bb', 'dinner'],
      });
      expect(deriveAuthorizedExtraLines(revision, proposal.facts!)).toEqual([
        expect.objectContaining({ quantity: 3, nights: 3, units: 9, totalMinor: 112_500 }),
      ]);
    },
  );

  it('a dinner row added after the charge scope was saved joins the priced dinner charge', async () => {
    const source = input();
    const group = source.groups[0]!;
    source.groups = [
      { ...group, id: 'first', quantity: 1, adults: 1, board: 'dinner_bb' },
      { ...group, id: 'added', quantity: 1, adults: 1, board: 'dinner_bb' },
    ];
    source.dinnerAllowanceMinor = 12_500;
    source.dinnerAllowanceUnit = 'per_person_per_night';
    source.dinnerAllowanceGroupIds = ['first'];

    const retry = staffQuoteDinnerFallback(source)!;
    expect(retry.groupIds).toEqual(['first', 'added']);
    const f = await fixture(retry.input);
    const revision = await executeStaffQuote(
      f.prepared,
      createReservationistBusinessServices(f.options, f.prepared.approval),
      async () => true,
    );
    const proposal = buildStaffProposalFacts(retry.input, scope, f.prepared, revision, {
      dinnerFallbackGroupIds: retry.groupIds,
    });

    expect(proposal.dinnerAddOnRequired).toBe(false);
    expect(proposal.facts?.extras[0]).toMatchObject({ groupIds: ['first', 'added'] });
  });

  it('prices configured dinner only for mixed-stay groups retried from dinner board', async () => {
    const source = input();
    const group = source.groups[0]!;
    source.groups = [
      { ...group, id: 'bb', quantity: 1, adults: 2, board: 'bb' },
      { ...group, id: 'dinner', quantity: 1, adults: 1, board: 'dinner_bb' },
    ];

    const retry = staffQuoteDinnerFallback(source)!;
    expect(retry.groupIds).toEqual(['dinner']);
    const f = await fixture(retry.input);
    const revision = await executeStaffQuote(
      f.prepared,
      createReservationistBusinessServices(f.options, f.prepared.approval),
      async () => true,
    );
    const proposal = buildStaffProposalFacts(retry.input, scope, f.prepared, revision, {
      dinnerFallbackGroupIds: retry.groupIds,
      dinnerAddOn: {
        amountMinor: 12_500,
        unit: 'per_person_per_night',
        label: 'Set menu',
      },
    });

    expect(proposal.dinnerAddOnRequired).toBe(false);
    expect(proposal.facts?.extras[0]).toMatchObject({
      units: 3,
      groupIds: ['dinner'],
      unitMinor: 12_500,
    });
    expect(deriveAuthorizedExtraLines(revision, proposal.facts!)).toEqual([
      expect.objectContaining({ quantity: 1, nights: 3, units: 3, totalMinor: 37_500 }),
    ]);
  });

  it.each(['dbb', 'half_board'] as const)(
    'requires a dinner price after retry when model board is %s',
    async (modelBoard) => {
      const source = input();
      source.groups[0]!.board = modelDinnerBoard(modelBoard);
      expect(source.groups[0]!.board).toBe('dinner_bb');

      const retry = staffQuoteDinnerFallback(source)!;
      const retryInput = { ...retry.input };
      delete retryInput.dinnerAllowanceGroupIds;
      const f = await fixture(retryInput);
      const revision = await executeStaffQuote(
        f.prepared,
        createReservationistBusinessServices(f.options, f.prepared.approval),
        async () => true,
      );
      const proposalOptions = {
        dinnerGroupIds: undefined,
        dinnerFallbackGroupIds: retry.groupIds,
      };
      const proposal = buildStaffProposalFacts(
        retryInput,
        scope,
        f.prepared,
        revision,
        proposalOptions,
      );

      expect(retry.input.groups[0]).toMatchObject({ id: 'single', board: 'bb' });
      expect(proposal.facts).toBeNull();
      expect(proposal.dinnerAddOnRequired).toBe(true);
      expect(proposal.extrasReviewItems).toContain('Dinner price — enter amount');
    },
  );

  it('keeps a dinner add-on unpriced until a staff amount and unit, or installed hotel config, supply them', async () => {
    const f = await fixture();
    const revision = await executeStaffQuote(
      f.prepared,
      createReservationistBusinessServices(f.options, f.prepared.approval),
      async () => true,
    );
    const fallbackInput = staffQuoteInput.parse({
      ...f.confirmed,
      dinnerAllowanceGroupIds: ['single'],
    });

    const unpriced = buildStaffProposalFacts(
      fallbackInput,
      scope,
      f.prepared,
      revision,
      { dinnerGroupIds: ['single'] },
    );
    expect(unpriced.facts).toBeNull();
    expect(unpriced.extrasReviewItems).toContain('Dinner price — enter amount');

    const configured = buildStaffProposalFacts(
      fallbackInput,
      scope,
      f.prepared,
      revision,
      {
        dinnerGroupIds: ['single'],
        dinnerAddOn: {
          amountMinor: 35_000,
          unit: 'per_person_per_night',
          label: 'Set menu',
        },
      },
    );
    expect(configured.facts?.extras[0]).toMatchObject({
      label: 'Dinner add-on (Set menu)',
      unitMinor: 35_000,
      service: 'dinner_add_on',
    });
    expect(deriveAuthorizedExtraLines(revision, configured.facts!)).toMatchObject([
      { description: 'Dinner add-on (Set menu)', quantity: 2, nights: 3, totalMinor: 210_000 },
    ]);

    const staffPriced = buildStaffProposalFacts(
      staffQuoteInput.parse({
        ...fallbackInput,
        dinnerAllowanceMinor: 25_000,
        dinnerAllowanceUnit: 'per_person',
        dinnerAllowanceLabel: 'Voucher allowance',
      }),
      scope,
      f.prepared,
      revision,
      {
        dinnerGroupIds: ['single'],
        dinnerAddOn: {
          amountMinor: 35_000,
          unit: 'per_person_per_night',
          label: 'Set menu',
        },
      },
    );
    expect(deriveAuthorizedExtraLines(revision, staffPriced.facts!)).toMatchObject([
      {
        description: 'Dinner add-on (Voucher allowance)',
        quantity: 2,
        nights: 1,
        totalMinor: 50_000,
      },
    ]);
  });

  it('uses exact corrections without manufacturing extracted facts; varies nightly prices and multiplies quantity once', async () => {
    const f = await fixture(),
      services = createReservationistBusinessServices(f.options, f.prepared.approval),
      revision = await executeStaffQuote(f.prepared, services, async () => true);
    expect(f.prepared.context.facts).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-15',
      rooms: [{ quantity: 2, adults: 1 }],
    });
    expect(revision.totalMinor).toBe(220002);
    const attestation = attestStaffQuote(f.confirmed, scope, f.prepared, revision),
      run = {
        transportId: scope.transportId,
        triggerMessageId: scope.messageId,
        state: 'succeeded',
        metrics: {
          staffQuoteAttestation: attestation,
          reservationistResult: {
            readiness: 'needs_clarification',
            tasks: [{ id: 'shuttle', status: 'blocked' }],
            quoteRevisionIds: [revision.id],
            quoteRevisions: [revision],
          },
        },
      };
    const selected = {
      transportId: scope.transportId,
      messageId: scope.messageId,
      revisionRef: revision.id,
      factRefs: [],
    };
    expect(resolveLedgerProposal(run, selected).revision.id).toBe(revision.id);

    const preparedRun = {
      transportId: scope.transportId,
      threadId: scope.threadId,
      triggerMessageId: scope.messageId,
      runKind: 'read_tool',
      promptVersion: 'hms-job/1',
      executorLane: 'hms',
      priority: 0,
      generationId: null,
      state: 'succeeded',
      metrics: { quotePrepared: true, userId: null },
      readRequest: { kind: 'staff_quote', input: f.confirmed },
      readResultExpiresAt: new Date(Date.now() + 60_000),
      readResult: {
        kind: 'staff_quote',
        status: 'ready',
        asOf: new Date().toISOString(),
        workflowRunId: 'prepared-run-1',
        messageId: scope.messageId,
        threadId: scope.threadId,
        revisionRef: revision.id,
        factRefs: [],
        inputDigest: f.prepared.inputDigest,
        freshUntil: revision.sourceFreshness?.expiresAt,
        preparedProposal: {
          version: 1,
          inputDigest: f.prepared.inputDigest,
          authorizationId: f.prepared.authorizationId,
          sourceHash: scope.sourceHash,
          revision,
          rowPrices: [],
        },
      },
    };
    expect(
      resolvePreparedLedgerProposal(preparedRun, {
        transportId: scope.transportId,
        messageId: scope.messageId,
        revisionRef: revision.id,
        factRefs: [],
        sourceHash: scope.sourceHash,
        party: { company: '', agency: '' },
      }).revision.id,
    ).toBe(revision.id);
    expect(() =>
      resolvePreparedLedgerProposal(preparedRun, {
        transportId: scope.transportId,
        messageId: scope.messageId,
        revisionRef: revision.id,
        factRefs: [],
        sourceHash: 'e'.repeat(64),
        party: { company: '', agency: '' },
      }),
    ).toThrow(/proposal_not_ready/);

    const contractInput = staffQuoteInput.parse({
        ...f.confirmed,
        company: 'Example Company',
        parties: { company: { kind: 'company', nativeId: 'co-17', name: 'Example Company' } },
      }),
      contractPrepared = prepareStaffQuote(
        contractInput,
        scope,
        { signerName: 'Staff', signerEmail: 'staff@example.test' },
        new AbortController().signal,
      ),
      contractOptions = { ...f.options, authorizationId: contractPrepared.authorizationId },
      contractRun = structuredClone(preparedRun);
    const contractRevision = await executeStaffQuote(
      contractPrepared,
      createReservationistBusinessServices(contractOptions, contractPrepared.approval),
      async () => true,
    );
    contractRun.readRequest = { kind: 'staff_quote', input: contractInput };
    contractRun.readResult = {
      ...contractRun.readResult!,
      revisionRef: contractRevision.id,
      inputDigest: contractPrepared.inputDigest,
      freshUntil: contractRevision.sourceFreshness?.expiresAt,
      preparedProposal: {
        ...contractRun.readResult!.preparedProposal as object,
        inputDigest: contractPrepared.inputDigest,
        authorizationId: contractPrepared.authorizationId,
        revision: contractRevision,
      },
    };
    expect(
      resolvePreparedLedgerProposal(contractRun, {
        transportId: scope.transportId,
        messageId: scope.messageId,
        revisionRef: contractRevision.id,
        factRefs: [],
        sourceHash: scope.sourceHash,
        party: { company: 'Example Company', agency: '' },
      }).revision.id,
    ).toBe(contractRevision.id);
    expect(resolvePreparedLedgerProposal(contractRun, {
      transportId: scope.transportId,
      messageId: scope.messageId,
      revisionRef: contractRevision.id,
      factRefs: [],
      sourceHash: scope.sourceHash,
      party: { company: 'Example Company', agency: 'Quote' },
    }).revision.id).toBe(contractRevision.id);
    expect(() => resolvePreparedLedgerProposal(contractRun, {
      transportId: scope.transportId,
      messageId: scope.messageId,
      revisionRef: contractRevision.id,
      factRefs: [],
      sourceHash: scope.sourceHash,
      party: { company: 'Different Company', agency: '' },
    })).toThrow(/proposal_not_ready/);
    expect(() => resolvePreparedLedgerProposal({
      ...preparedRun,
      readResult: { ...preparedRun.readResult!, dinnerAddOnRequired: true },
    }, {
      transportId: scope.transportId,
      messageId: scope.messageId,
      revisionRef: revision.id,
      factRefs: [],
      sourceHash: scope.sourceHash,
      party: { company: '', agency: '' },
    })).toThrow(/proposal_not_ready/);

    expect(() =>
      resolveLedgerProposal(
        {
          ...run,
          metrics: {
            ...run.metrics,
            staffQuoteAttestation: { ...attestation, authorizationId: 'wrong' },
          },
        },
        selected,
      ),
    ).toThrow('proposal_not_ready');
  });
  it('rejects client prices, mismatched source, duplicate groups and unsupported combined stays', () => {
    expect(() => staffQuoteInput.parse({ ...input(), rate: 1700 })).toThrow();
    expect(() =>
      prepareStaffQuote(
        input(),
        { ...scope, transportId: '' },
        { signerName: '', signerEmail: '' },
        new AbortController().signal,
      ),
    ).toThrow('source_changed');
    const v = input();
    v.groups.push({ ...v.groups[0] });
    expect(() =>
      prepareStaffQuote(
        v,
        scope,
        { signerName: '', signerEmail: '' },
        new AbortController().signal,
      ),
    ).toThrow('duplicate_group');
    v.groups[1].id = 'another';
    v.groups[1].arrivalDate = '2026-10-13';
    expect(() =>
      prepareStaffQuote(
        v,
        scope,
        { signerName: '', signerEmail: '' },
        new AbortController().signal,
      ),
    ).toThrow('separate_stay');
  });
  it('rechecks source and refuses a changed approval or missing party service', async () => {
    const f = await fixture();
    await expect(
      executeStaffQuote(
        f.prepared,
        createReservationistBusinessServices(f.options, f.prepared.approval),
        async () => false,
      ),
    ).rejects.toThrow('source_changed');
    expect(f.calls).toHaveLength(0);
    const services = createReservationistBusinessServices(f.options, f.prepared.approval);
    f.prepared.request.rooms[0].adults = 2;
    await expect(executeStaffQuote(f.prepared, services, async () => true)).rejects.toThrow(
      'approval_changed',
    );
    // A company the staff typed and did not pick is text only: no party service is needed, nothing is looked up, and the
    // quote goes out at public rates with no rate context.
    const other = await fixture();
    other.prepared.header.company = 'Company';
    await executeStaffQuote(
      other.prepared,
      createReservationistBusinessServices(other.options, other.prepared.approval),
      async () => true,
    );
    expect(other.calls.at(-1)?.rateContext).toBeUndefined();
  });
  it('zero-priced native rooms cannot become a qualified quote', async () => {
    const f = await fixture(),
      original = f.options.readQuote;
    f.options.readQuote = async (r) => {
      const source = await original(r);
      source.result.groups[0].options[0].nightly[0].price.amount = '0.00';
      return source;
    };
    await expect(
      executeStaffQuote(
        f.prepared,
        createReservationistBusinessServices(f.options, f.prepared.approval),
        async () => true,
      ),
    ).rejects.toThrow('selected_price');
  });
});
