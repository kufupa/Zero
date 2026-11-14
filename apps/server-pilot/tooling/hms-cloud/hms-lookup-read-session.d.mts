import type { Page } from 'playwright';

export type CloudLookupReadContext = {
  page: Page;
  runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
export declare function createCloudLookupReadTools(page: Page, propertyCode: string, signal?: AbortSignal): CloudLookupReadContext['runTool'];
export declare function withCloudLookupReadSession<T>(
  operation: (context: CloudLookupReadContext) => T | Promise<T>,
  options: { propertyCode: string; signal?: AbortSignal; transportId?: string },
): Promise<T>;
