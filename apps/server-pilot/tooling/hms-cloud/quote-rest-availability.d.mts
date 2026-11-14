export type RestAvailabilityCriteria = {
  propertyCode: string; arrivalDate: string; departureDate: string; adults: number; childAges: number[];
  roomTypeCodes: string[]; ratePlanCodes: string[]; organizationID?: string; travelAgencyID?: string;
};
export type RestAvailabilityEvidence = {
  evidenceKind: 'rest_availability_read'; domCalendarVerified: false; screenshotsVerified: false;
  displayedRounding: 'unverified_no_dom'; payableTotal: 'unverified';
};
export type RestAvailabilityObservation = {
  room: { code: string; label: string | null };
  rate: { code: string; label: string | null; promotionCode: string | null };
  nightly: Array<{ date: string; availableCount: number | null; rate: string | null; currency: string | null;
    restrictions: { isclosed: boolean | null; isclosetoarrival: boolean | null; isclosetedeparture: boolean | null;
      closedOrRestricted: boolean; unknownRestrictionFlags: string[] } }>;
};
export type RestAvailabilityGroup = RestAvailabilityEvidence & {
  outcome: 'rest_observed' | 'partial'; observedAt: string; criteriaEchoVerified: true;
  appliedCriteria: Record<string, unknown>; observations: RestAvailabilityObservation[];
};
export type RestAvailabilityResult = (RestAvailabilityEvidence & {
  outcome: 'rest_observed' | 'partial'; groups: RestAvailabilityGroup[];
}) | (RestAvailabilityEvidence & { outcome: 'execution_failure' | 'unsupported_context'; issue: string });
export declare function quoteRestSessionCacheKey(identity: {
  tenantId: string; landingPropertyCode: string; selectedPropertyCode: string; origin: string;
  credentialVersionHmacSha256: string | null; capabilityScope: string;
}): string | null;
export declare function validateDirectAvailabilityInquiryRequest(request: {
  method: string; url: string; redirect: string; signal: AbortSignal; headers: HeadersInit; body: string;
}, propertyCode: string): boolean;
export declare function normalizeQuoteRestAvailability(response: unknown, body: unknown): RestAvailabilityGroup | null;
export declare function readQuoteRestAvailability(input: {
  propertyCode: string; transportId?: string; criteria: RestAvailabilityCriteria[]; signal?: AbortSignal;
  env?: NodeJS.Dict<string>;
}): Promise<RestAvailabilityResult>;
