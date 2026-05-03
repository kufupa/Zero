import type { MailApiMode } from '../runtime/mail-mode';

export class UnsupportedFeatureError extends Error {
  readonly code = 'UNSUPPORTED_FEATURE' as const;
  constructor(
    readonly feature: string,
    readonly mode: MailApiMode,
  ) {
    super(`${feature} is not supported in ${mode} mode`);
  }
}

export class BackendUnavailableError extends Error {
  readonly code = 'BACKEND_UNAVAILABLE' as const;
  constructor(readonly mode: MailApiMode) {
    super(`Backend unavailable in ${mode} mode`);
  }
}
