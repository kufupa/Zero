import type { Request } from 'playwright';
export type QuoteDetailsScope = Readonly<{ arrivalDate: string; departureDate: string; roomCodes: readonly string[] | null }>;
export declare function availabilityDetailsScope(request: unknown, propertyCode: string): QuoteDetailsScope | null;
export declare function availabilityScreenRules(origin: string, propertyCode: string): unknown[];
export declare function isReviewedAvailabilityDetailsInquiry(request: Request, options: {
  origin: string; propertyCode: string; detailsScope: QuoteDetailsScope | null;
  rejectDuplicateJsonBodyKeys: (raw: string) => void;
}): boolean;
export declare function isReviewedRoomInformationRequest(request: Request, options: {
  origin: string; propertyCode: string; detailsScope: QuoteDetailsScope | null;
}): boolean;
export declare function isReviewedRoomInformationAsset(request: Request, options: {
  origin: string; propertyCode: string; detailsScope: QuoteDetailsScope | null;
}): boolean;
export declare function isReviewedRoomInformationRead(request: Request, options: {
  origin: string; propertyCode: string; detailsScope: QuoteDetailsScope | null;
}): boolean;
export declare function isReviewedAvailabilityInquiry(request: Request, options: {
  origin: string; propertyCode: string; rejectDuplicateJsonBodyKeys: (raw: string) => void;
}): boolean;
