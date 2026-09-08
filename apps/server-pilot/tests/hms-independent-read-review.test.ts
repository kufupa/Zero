import { describe, expect, it } from 'vitest';
import {
  reservationContextReadResultSchema,
  type ReservationContextReadResult,
} from '../src/hms/reservation-context-contract.js';
import { readResultSchema } from '../src/hms/read-service-contracts.js';
import { requireHmsReadRuntimeConfig } from '../src/env.js';
import { mapProductionReservationRead } from '../src/ai/worker.js';
import { executeRead, type ReadExecutionContext } from '../src/hms/read-service.js';
import { createReservationContextFacade } from '../src/hms/reservation-context-facade.js';
import { readInputDigest } from '../src/hms/read-service-contracts.js';

const observedAt = '2026-09-07T12:00:00.000Z';
const expiresAt = '2026-09-07T12:05:00.000Z';

const admittedClosedRequest = {
  toolId: 'hms_find_reservation' as const,
  candidateId: 'candidate-red',
};

function admittedReadContext(
  _admission: Record<string, unknown>,
): ReadExecutionContext {
  return {
    transportId: 'transport-red',
    mailboxId: 'mailbox-red',
    threadId: 'thread-red',
    triggerMessageId: 'message-red',
    propertyCode: 'HRCEN',
    parentRef: 'run-red',
    branchId: 'guest_stay_search',
    releaseId: 'release-red',
    requester: {
      authorizationId: 'auth-red',
      transportId: 'transport-red',
      threadId: 'thread-red',
      triggerMessageId: 'message-red',
      allowedClaimKinds: ['reservation_summary'],
      expiresAt: '2099-09-07T12:05:00.000Z',
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    requireAdmissionBinding: true,
    propertyReadLock: {
      key: '1',
      withLock: async (callback) => callback({
        query: async () => [],
        close: async () => undefined,
      }),
    },
    handlers: {
      findReservation: async () => ({
        status: 'not_found' as const,
        data: null,
        evidenceRef: 'evidence-red-admission',
        observedAt,
        expiresAt,
      }),
    },
  };
}

function admittedRequest(overrides: Record<string, unknown> = {}) {
  return {
    ...admittedClosedRequest,
    admission: {
      releaseId: 'release-red',
      requestBranchId: 'guest_stay_search',
      requesterAuthorizationId: 'auth-red',
      inputDigest: readInputDigest(admittedClosedRequest),
      captureRequired: false,
      captureBindingRef: null,
      ...overrides,
    },
  };
}

function known(value: unknown) {
  return {
    state: 'known' as const,
    value,
    evidenceRef: 'evidence-red',
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

function unavailable() {
  return {
    state: 'unavailable' as const,
    data: null,
    reasonCode: 'NOT_APPLICABLE' as const,
    issues: [],
  };
}

function contextResult(): ReservationContextReadResult {
  return {
    toolId: 'hms_read_reservation' as const,
    schemaVersion: 'reservation-context/1',
    status: 'partial',
    data: {
      core: {
        state: 'available',
        data: {
          confirmation: known('CONF-RED'),
          externalReference: known(null),
          status: known('Confirmed'),
          guestRefs: known([]),
          organizationRef: known(null),
          agencyRef: known(null),
          groupRef: known(null),
        },
        completeness: 'complete',
        issues: [],
      },
      stay: unavailable(),
      rates: unavailable(),
      policies: unavailable(),
      operations: unavailable(),
    },
    completeness: 'partial',
    unavailableSections: [
      { section: 'stay', reasonCode: 'NOT_APPLICABLE' },
      { section: 'rates', reasonCode: 'NOT_APPLICABLE' },
      { section: 'policies', reasonCode: 'NOT_APPLICABLE' },
      { section: 'operations', reasonCode: 'NOT_APPLICABLE' },
    ],
    scopeRef: 'resref-red',
    evidence: [
      {
        evidenceRef: 'evidence-red',
        sourceSystem: 'hms',
        sourceSurface: 'guest-stay',
        requestBranchId: 'guest_stay_search',
        observedAt,
        sourceUpdatedAt: null,
        expiresAt,
        scopeVerified: true,
        artifactRef: null,
      },
    ],
    page: null,
    issues: [],
  };
}

describe('U8 independent review RED contracts', () => {
  it('rejects a malformed concrete reservation section at runtime', () => {
    const malformed = contextResult();
    malformed.data!.core = {
      state: 'available',
      data: { confirmation: 'not-a-read-fact' },
      completeness: 'complete',
      issues: [],
    } as never;

    expect(() => reservationContextReadResultSchema.parse(malformed)).toThrow();
  });

  it('accepts a typed result with its tool discriminator', () => {
    const result = contextResult() as unknown as Record<string, unknown>;

    expect(() => readResultSchema.parse(result)).not.toThrow();
  });

  it('preserves ambiguous and unverified production outcomes without selecting a first row', () => {
    const evidence = {
      kind: 'hms' as const,
      id: 'evidence-red-map',
      observedAt,
      expiresAt,
    };
    const ambiguous = mapProductionReservationRead({
      status: 'ambiguous',
      data: {
        matches: [
          {
            confirmationNumber: 'CONF-RED-1',
            externalReference: null,
            guestName: 'redacted',
            reservationStatus: 'Confirmed',
            arrivalDate: '2026-09-10',
            departureDate: '2026-09-12',
            roomType: 'STD',
            ratePlan: null,
          },
          {
            confirmationNumber: 'CONF-RED-2',
            externalReference: null,
            guestName: 'redacted',
            reservationStatus: 'Confirmed',
            arrivalDate: '2026-09-10',
            departureDate: '2026-09-12',
            roomType: 'STD',
            ratePlan: null,
          },
        ],
      },
      evidence,
    });
    expect(ambiguous).toMatchObject({ status: 'ambiguous' });
    expect('rows' in ambiguous && ambiguous.rows).toHaveLength(2);
    expect('row' in ambiguous).toBe(false);

    const unverified = mapProductionReservationRead({
      status: 'not_found',
      data: { matches: [] },
      evidence,
    });
    expect(unverified).toMatchObject({ status: 'unverified_negative' });
  });

  it('admits a model-free read runtime while drafting remains off', () => {
    expect(
      requireHmsReadRuntimeConfig({
        HMS_DRAFT_ENRICHMENT_MODE: 'off',
        HMS_HEALTH_STATUS_PATH: '/tmp/u8-read-health.json',
        HMS_EXPECTED_PROPERTY_CODE: 'HRCEN',
        HMS_READ_SECRET_ARN: 'arn:aws:secretsmanager:synthetic:u8-read',
        HMS_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
        HMS_READ_ROLE_PROOF_PATH: '/private/u8-role-proof.json',
        HMS_EXPECTED_TENANT: 'synthetic-tenant',
        HMS_EXPECTED_TRANSPORT_ID: 'synthetic-transport',
        HMS_EVIDENCE_HMAC_SECRET_ARN: 'arn:aws:secretsmanager:synthetic:u8-evidence',
        HMS_EVIDENCE_HMAC_KEY_VERSION: 'synthetic-v1',
      }).expectedPropertyCode,
    ).toBe('HRCEN');
  });

  it('resolves an entitled reservation reference before executing a normal context read', async () => {
    const facade = createReservationContextFacade({
      now: () => new Date(observedAt),
      lookup: async () => ({
        status: 'matched' as const,
        row: {
          confirmationNumber: 'CONF-RED',
          externalReference: null,
          guestName: null,
          arrivalDate: '2026-09-10',
          departureDate: '2026-09-12',
          reservationStatus: 'Confirmed',
          roomType: 'STD',
          ratePlan: null,
        },
        evidenceRef: 'evidence-context-red',
        observedAt,
        expiresAt,
      }),
      readContext: async () => ({}),
    });
    const lookup = {
      transportId: 'transport-red',
      mailboxId: 'mailbox-red',
      threadId: 'thread-red',
      triggerMessageId: 'message-red',
      parentRef: 'parent-red',
      branchId: 'guest_stay_search',
      propertyCode: 'HRCEN',
      candidateId: 'candidate-red',
      referenceKind: 'confirmation' as const,
      value: 'CONF-RED',
      observedAt,
      expiresAt,
    };
    const found = await facade.findReservation(lookup);
    const reservationRef = found.data?.matches[0]?.reservationRef;
    expect(reservationRef).toEqual(expect.any(String));
    const result = await executeRead(
      {
        transportId: lookup.transportId,
        mailboxId: lookup.mailboxId,
        threadId: lookup.threadId,
        triggerMessageId: lookup.triggerMessageId,
        propertyCode: lookup.propertyCode,
        parentRef: lookup.parentRef,
        branchId: lookup.branchId,
        releaseId: 'release-red',
        requester: {
          authorizationId: 'auth-red',
          transportId: lookup.transportId,
          threadId: lookup.threadId,
          triggerMessageId: lookup.triggerMessageId,
          allowedClaimKinds: ['reservation_summary'],
          expiresAt: '2026-09-07T12:05:00.000Z',
        },
        signal: new AbortController().signal,
        budget: { total: 0, limit: 3 },
        now: () => new Date(observedAt),
        reservationFacade: facade,
      },
      {
        toolId: 'hms_read_reservation',
        reservationRef: reservationRef!,
        sections: ['core'],
        detail: 'summary',
      },
    );
    expect(result.toolId).toBe('hms_read_reservation');
    expect(result.status).toBe('ok');
    expect(result.data?.core.state).toBe('available');
  });

  it('rejects a read admission whose release binding is stale', async () => {
    await expect(
      executeRead(
        admittedReadContext({ ...admittedRequest().admission, releaseId: 'release-stale' }),
        admittedRequest({ releaseId: 'release-stale' }),
      ),
    ).rejects.toMatchObject({ code: 'READ_RELEASE_BINDING_MISMATCH' });
  });

  it('rejects a read admission whose input digest does not match the closed request', async () => {
    await expect(
      executeRead(
        admittedReadContext(admittedRequest().admission),
        admittedRequest({ inputDigest: 'f'.repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: 'READ_INPUT_BINDING_MISMATCH' });
  });

  it('rejects a read admission whose request branch is not the admitted branch', async () => {
    await expect(
      executeRead(
        admittedReadContext(admittedRequest().admission),
        admittedRequest({ requestBranchId: 'guest_stay_other_branch' }),
      ),
    ).rejects.toMatchObject({ code: 'READ_BRANCH_BINDING_MISMATCH' });
  });

  it('rejects a read admission whose requester authorization is stale', async () => {
    await expect(
      executeRead(
        admittedReadContext(admittedRequest().admission),
        admittedRequest({ requesterAuthorizationId: 'auth-stale' }),
      ),
    ).rejects.toMatchObject({ code: 'READ_REQUESTER_BINDING_MISMATCH' });
  });

  it('rejects a read admission whose capture binding is not the run fence', async () => {
    await expect(
      executeRead(
        admittedReadContext(admittedRequest().admission),
        admittedRequest({ captureRequired: true, captureBindingRef: 'run-stale' }),
      ),
    ).rejects.toMatchObject({ code: 'READ_CAPTURE_BINDING_MISMATCH' });
  });
});
