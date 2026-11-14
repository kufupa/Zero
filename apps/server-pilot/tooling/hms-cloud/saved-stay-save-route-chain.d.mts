import type { Frame, Page } from 'playwright';
import type { PropertyCode } from './property-registry.mjs';

export function createSavedStayRateReadCapability(page: Page, options: {
  frame: Frame;
  propertyCode: PropertyCode;
  nativeStayId: string;
  bookingSessionId: string;
  mode?: 'saved' | 'saved_direct' | 'staged' | 'selected';
  timeoutMs?: number;
}): Readonly<object>;
export function closeSavedStayRateReadCapability(capability: unknown): void;
export function consumeSavedStayRateReadCapability(capability: unknown, request: unknown, page: Page): boolean;
export function installSavedStayRateReadRouteChain(page: Page, options: {
  frame: Frame;
  fence: { isQuarantined(): boolean };
  scope: { allow(request: unknown): boolean };
  capability: unknown;
}): Promise<Readonly<{ close(): Promise<void> }>>;

export function consumeNeverDispatchedCreateProof(proof: unknown, request: unknown): boolean;
export function installLabtestSaveRouteChain(page: unknown, options: unknown): Promise<any>;
