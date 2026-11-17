import type { CloudCredentialLease } from './cloud-session.mjs';
export type CloudQuoteCapture = Record<string, unknown> & {
  schemaVersion: 2;
  outcome: string;
  propertyCode?: string;
  observedAt?: string;
  requested?: Record<string, unknown>;
  groups: unknown[];
  allocation: Record<string, unknown>;
  searchCompleteness: Record<string, unknown>;
  issues: unknown[];
  audit: { status: string; screenshots?: unknown[] };
  evidenceDirectory: string;
  toolVersion: string;
};
export declare function fetchQuote(input: {
  propertyCode: string; transportId?: string; requestPath?: string; request?: unknown;
  outputDir?: string; signal?: AbortSignal; credentialLease?: CloudCredentialLease;
  env?: NodeJS.ProcessEnv; video?: boolean; logEvents?: boolean;
  onCaptured?: (capture: CloudQuoteCapture) => void | Promise<void>;
}): Promise<CloudQuoteCapture>;
export declare function cloudQuoteDependencyDigest(): string;
export declare function quoteTraceAsyncEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function summarize(result: Record<string, unknown>): string;

export type NativeQuoteDetails = { status: string; nightly: Array<{ date: string; [field: string]: unknown }>; [field: string]: unknown };
export type NativeQuoteOption = {
  id: string; room: { code: string; label: string; [field: string]: unknown };
  rate: { code: string; label: string; [field: string]: unknown };
  rateScope: string; matchStatus: string; eligibility: string; availability: string;
  conditions: Array<{ field: string; kind: string; [field: string]: unknown }>;
  nightly: Array<{ date: string; price: { amount: string; currency: string }; [field: string]: unknown }>;
  details?: NativeQuoteDetails; [field: string]: unknown;
};
export declare function extractOptions(request: unknown, room: unknown, windows: unknown[], resolvedContext?: unknown): {
  options: NativeQuoteOption[]; issues: unknown[]; completeness: Record<string, unknown>;
};
export declare function groupOutcomeFromOptions<T extends {
  matchStatus?: string; eligibility?: string; availability?: string; details?: { status?: string };
}>(options: T[], input?: { details?: string; searchComplete?: boolean }): { outcome: string; eligible: T[]; requiredFacts: string };
export declare function detailReadBudgetMs(env?: NodeJS.ProcessEnv): number;
export declare function detailCandidates<T>(mode: string, options: T[]): T[];
export declare function detailReadOrder<T extends { id: string }>(options: T[], detailsMap: Map<string, { details?: Array<{ date: string }> }>, dates: string[]): T[];
export declare function stayDates(request: { arrivalDate: string; departureDate: string }): string[];
export declare function unreadDetails(): NativeQuoteDetails;
