/** Resolve foreground thread list polling interval from env (ms). Min 15s. */
export function resolveThreadPollingMs(value?: string): number | null {
  if (!value) return 15_000;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 15_000) return null;
  return ms;
}

/** Open-thread detail must poll too — list bumps to top but replies stay invisible otherwise. */
export function openThreadQueryPollingOptions(value?: string): {
  refetchInterval: number | false;
  refetchIntervalInBackground: boolean;
  refetchOnWindowFocus: boolean;
} {
  const ms = resolveThreadPollingMs(value);
  return {
    refetchInterval: ms ?? false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  };
}
