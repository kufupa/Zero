export type GuardedContextInput = {
  _options?: { serviceWorkers?: string };
  serviceWorkers(): unknown[];
  pages(): unknown[];
  routeWebSocket(
    url: string,
    handler: (socket: { close(): Promise<void> | void }) => Promise<void> | void,
  ): Promise<void> | void;
};

/** Requires a new, dedicated, unexposed context before its first page. */
export function prepareGuardedContext(context: GuardedContextInput): Promise<void>;
/** Attests setup and observable health, not lock ownership or browser closure. */
export function isGuardedContext(context: unknown): boolean;
/** Checks attestation and exact sole-page identity. */
export function isGuardedPage(page: unknown): boolean;
