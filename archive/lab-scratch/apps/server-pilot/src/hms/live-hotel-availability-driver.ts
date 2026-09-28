/**
 * Live Hotel Availability read driver.
 *
 * This is deliberately separate from live-quote-stay-driver.ts.  The latter
 * is an OSRRAV diagnostic adapter and must never be used as a fallback for the
 * child-aware Hotel Availability tool.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../../../../../../apps/server-pilot/src/ai/draft-evidence.js';
import type { HmsBrowserAuditSpec } from '../../../../../../apps/server-pilot/src/hms/browser-artifacts.js';
import type { HmsSessionAuthorization } from '../../../../../../apps/server-pilot/src/hms/release-kernel.js';
import {
  buildHotelAvailabilityReadData,
  classifyHotelAvailabilityResult,
  hotelAvailabilityManifestDigest,
  hotelAvailabilitySurfaceManifestSchema,
  parseHotelAvailabilityResponse,
  type HotelAvailabilityParseResult,
  type HotelAvailabilitySurfaceManifest,
} from './hotel-availability-contract.js';
import { createHotelAvailabilityFacade } from './hotel-availability-facade.js';
import { quoteRequestSchema, type QuoteRequest } from '../../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import { quoteStayReadDataSchema, type QuoteStayReadData } from '../../../../../../apps/server-pilot/src/hms/quote-stay-contract.js';
import { HmsRuntimeError, type HmsRuntime } from '../../../../../../apps/server-pilot/src/hms/runtime.js';

const TOOL_VERSION = '3.0.0-hotel-availability';

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('Hotel Availability quote aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function expectedNights(request: QuoteRequest): string[] {
  const start = Date.parse(`${request.arrival}T00:00:00.000Z`);
  const end = Date.parse(`${request.departure}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const dates: string[] = [];
  for (let cursor = start; cursor < end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function scopeRows(request: QuoteRequest, rows: QuoteStayReadData['nightlyObservations']): {
  rows: QuoteStayReadData['nightlyObservations'];
  unresolved: string[];
} {
  const unresolved: string[] = [];
  const scoped = rows.filter((row) => {
    if (request.rooms.length === 1) {
      const room = request.rooms[0]!;
      const roomMatch = !room.roomTypeRef || row.roomType.toUpperCase() === room.roomTypeRef.toUpperCase();
      const rateMatch = !room.ratePlanRef || row.ratePlan.toUpperCase() === room.ratePlanRef.toUpperCase();
      if (!roomMatch || !rateMatch) return false;
      return true;
    }
    if (row.roomGroupIndex === undefined) return false;
    const room = request.rooms[row.roomGroupIndex];
    if (!room) {
      unresolved.push(`room_group:${row.roomGroupIndex}`);
      return false;
    }
    if (room.roomTypeRef && room.roomTypeRef.toUpperCase() !== row.roomType.toUpperCase()) {
      unresolved.push(`room_group:${row.roomGroupIndex}.room_type`);
    }
    if (room.ratePlanRef && room.ratePlanRef.toUpperCase() !== row.ratePlan.toUpperCase()) {
      unresolved.push(`room_group:${row.roomGroupIndex}.rate_plan`);
    }
    return true;
  });
  if (scoped.length === 0 && rows.length > 0) unresolved.push('room_rate_scope_mismatch');

  const nights = expectedNights(request);
  for (const night of nights) {
    const onNight = scoped.filter((row) => row.date === night);
    if (onNight.length === 0) unresolved.push(`nightly.${night}`);
    if (request.rooms.length === 1 && onNight.length > 1) unresolved.push(`nightly.${night}.ambiguous`);
    if (request.rooms.length > 1) {
      const seen = new Set<number>();
      for (const row of onNight) {
        if (row.roomGroupIndex === undefined) unresolved.push(`nightly.${night}.room_group`);
        else if (seen.has(row.roomGroupIndex)) unresolved.push(`nightly.${night}.room_group.ambiguous`);
        else seen.add(row.roomGroupIndex);
      }
      for (let index = 0; index < request.rooms.length; index += 1) {
        if (!seen.has(index)) unresolved.push(`nightly.${night}.room_group:${index}`);
      }
    }
  }
  if (scoped.some((row) => !nights.includes(row.date))) unresolved.push('nightly.out_of_window');
  return { rows: scoped, unresolved: [...new Set(unresolved)] };
}

function resultFor(input: {
  status: ToolResult<QuoteStayReadData>['status'];
  data: QuoteStayReadData;
  unresolvedFields: readonly string[];
  request: QuoteRequest;
  observedAt: Date;
  manifest: HotelAvailabilitySurfaceManifest;
  auditSpec?: HmsBrowserAuditSpec;
  artifactRef?: string;
}): ToolResult<QuoteStayReadData> {
  const unresolvedFields = [...new Set(input.unresolvedFields)];
  const evidence = {
    kind: 'hms' as const,
    id: randomUUID(),
    toolId: 'hms_quote_stay',
    toolVersion: TOOL_VERSION,
    propertyCode: input.request.propertyCode,
    observedAt: input.observedAt.toISOString(),
    expiresAt: new Date(input.observedAt.getTime() + 15 * 60_000).toISOString(),
    claimKeys: input.data.nightlyObservations.flatMap((_, index) => [
      `nightlyObservations.${index}.date`,
      `nightlyObservations.${index}.roomType`,
      `nightlyObservations.${index}.ratePlan`,
      `nightlyObservations.${index}.availableCount`,
      `nightlyObservations.${index}.displayedAmount`,
      `nightlyObservations.${index}.currency`,
      `nightlyObservations.${index}.restrictions`,
    ]),
    sourceHash: sha256({
      request: input.request,
      data: input.data,
      manifest: hotelAvailabilityManifestDigest(input.manifest),
    }),
    ...(input.artifactRef ? { artifactRef: input.artifactRef, scopeVerified: true } : {}),
    ...(input.auditSpec
      ? { manifestSha256: hotelAvailabilityManifestDigest(input.manifest) }
      : {}),
  };
  return {
    status: input.status,
    draftReady: input.status === 'ok' && unresolvedFields.length === 0,
    data: quoteStayReadDataSchema.parse(input.data),
    unresolvedFields,
    evidence,
  };
}

export type LiveHotelAvailabilityQuoteDriver = {
  observeQuote(
    authorization: HmsSessionAuthorization,
    request: QuoteRequest,
    signal: AbortSignal,
  ): Promise<ToolResult<QuoteStayReadData>>;
};

export function createLiveHotelAvailabilityQuoteDriver(input: {
  runtime: HmsRuntime;
  transportId: string;
  manifest: HotelAvailabilitySurfaceManifest;
  auditSpecFor?: (input: { request: QuoteRequest }) => HmsBrowserAuditSpec | undefined;
}): LiveHotelAvailabilityQuoteDriver {
  const manifest = hotelAvailabilitySurfaceManifestSchema.parse(input.manifest);
  return {
    async observeQuote(authorization, requestInput, signal) {
      abortIfNeeded(signal);
      const request = quoteRequestSchema.parse(requestInput);
      if (authorization.toolId !== 'hms_quote_stay') {
        throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization toolId must be hms_quote_stay');
      }
      if (authorization.discoveryOperationId !== 'quote_availability_search' || authorization.requestBranchId !== 'quote_availability_search') {
        throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization is not bound to Hotel Availability quote branch');
      }
      if (Date.parse(authorization.expiresAt) <= Date.now()) {
        throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
      }
      const observedAt = new Date();
      const auditSpec = input.auditSpecFor?.({ request });
      const nights = expectedNights(request);
      if (nights.length === 0) {
        const parsed: HotelAvailabilityParseResult = {
          envelopeRecognized: false,
          rows: [],
          unresolvedFields: ['quote_input'],
          currency: null,
          occupancyPriced: false,
          stayTotal: null,
        };
        return resultFor({
          status: 'manual_required',
          data: buildHotelAvailabilityReadData({ request, parsed }),
          unresolvedFields: parsed.unresolvedFields,
          request,
          observedAt,
          manifest,
          auditSpec,
        });
      }

      const session = await input.runtime.openReadSession({
        transportId: input.transportId,
        signal,
        allowUnstarted: true,
        auditSpec,
        sessionAuthorization: authorization,
      });
      let result: ToolResult<QuoteStayReadData>;
      try {
        const facade = createHotelAvailabilityFacade(session, manifest);
        await facade.navigate();
        const text = await facade.search(request);
        abortIfNeeded(signal);
        if (session.terminal() || session.violation()) {
          const parsed = parseHotelAvailabilityResponse('{}', request, manifest, observedAt);
          result = resultFor({
            status: 'manual_required',
            data: buildHotelAvailabilityReadData({ request, parsed }),
            unresolvedFields: ['request_policy'],
            request,
            observedAt,
            manifest,
            auditSpec,
          });
        } else {
          const parsed = parseHotelAvailabilityResponse(text, request, manifest, observedAt);
          const scoped = scopeRows(request, parsed.rows);
          const merged = {
            ...parsed,
            rows: scoped.rows,
            unresolvedFields: [...new Set([...parsed.unresolvedFields, ...scoped.unresolved])],
          };
          const data = buildHotelAvailabilityReadData({ request, parsed: merged });
          const allUnresolved = [...new Set([...merged.unresolvedFields, ...(data.unresolvedInputs ?? [])])];
          const status = classifyHotelAvailabilityResult({ parsed: merged, data });
          result = resultFor({
            status,
            data,
            unresolvedFields: allUnresolved,
            request,
            observedAt,
            manifest,
            auditSpec,
          });
        }
      } finally {
        await session.close();
      }
      const receipt = typeof session.lastReceipt === 'function' ? session.lastReceipt() : null;
      if (auditSpec && (!receipt || receipt.artifactState !== 'complete' || !receipt.artifactId)) {
        return {
          ...result,
          status: 'manual_required',
          draftReady: false,
          unresolvedFields: [...new Set([...result.unresolvedFields, 'audit_capture_receipt'])],
        };
      }
      return {
        ...result,
        ...(receipt?.artifactId
          ? { evidence: { ...result.evidence, artifactRef: receipt.artifactId, scopeVerified: true } }
          : {}),
      };
    },
  };
}
