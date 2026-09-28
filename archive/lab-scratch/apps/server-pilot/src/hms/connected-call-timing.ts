export type ConnectedCallTiming = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export function connectedCallTiming(
  startedAtMs: number,
  finishedAtMs: number,
): ConnectedCallTiming {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs)) {
    throw new Error('connected call timestamps must be finite');
  }
  const startedAt = Math.trunc(startedAtMs);
  const finishedAt = Math.trunc(finishedAtMs);
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
  };
}
