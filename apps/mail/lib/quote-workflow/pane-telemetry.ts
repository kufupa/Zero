/**
 * Pane action telemetry (v5 B1). Actions queue per work item and go out as one batched workItems.recordActions call: on
 * an interval, at pagehide, or as a full batch. A send that fails is dropped and nothing waits on it, so telemetry never
 * blocks the pane or shows in it. Only an action's type, enum and number are sent, never mail text. The pane sets its
 * current work item with setPaneTelemetryScope, so action sites deep in the tree need no props. With no work item,
 * nothing is recorded. The server keeps the allowlist and the batch cap.
 */

export const PANE_ACTION_TYPES = [
  'pane.opened',
  'copy.hms_line',
  'copy.confirmation',
  'reply.inserted',
  'reply.saved',
  'pdf.created',
  'excel.downloaded',
  'hms.lookup.started',
  'hms.lookup.finished',
  'item.dismissed',
] as const;
export type PaneActionType = (typeof PANE_ACTION_TYPES)[number];
export const PANE_ACTION_KINDS = ['selected', 'all', 'saved', 'option', 'combined', 'comment', 'booking'] as const;
export type PaneActionKind = (typeof PANE_ACTION_KINDS)[number];
export type PaneSurface = 'outlook' | 'web';

export type PaneAction = { type: PaneActionType; ms?: number; kind?: PaneActionKind };
export type PaneActionEvent = PaneAction & { surface?: PaneSurface };
export type PaneActionBatch = { workItemId: string; events: PaneActionEvent[] };

export const PANE_ACTION_BATCH_MAX = 50;
export const PANE_ACTION_FLUSH_MS = 5_000;

/** Queues actions per work item and sends them in batches of at most PANE_ACTION_BATCH_MAX. Never throws. */
export function createPaneTelemetry(send: (batch: PaneActionBatch) => Promise<unknown>, flushMs = PANE_ACTION_FLUSH_MS) {
  const queue = new Map<string, PaneActionEvent[]>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    for (const [workItemId, events] of queue) {
      queue.delete(workItemId);
      for (let at = 0; at < events.length; at += PANE_ACTION_BATCH_MAX) {
        const chunk = events.slice(at, at + PANE_ACTION_BATCH_MAX);
        // ponytail: a failed send is dropped, not retried. Telemetry is best effort and must never reach the person.
        try {
          void Promise.resolve(send({ workItemId, events: chunk })).catch(() => undefined);
        } catch {
          // A send that throws is dropped the same way.
        }
      }
    }
  }

  return {
    track(workItemId: string, event: PaneActionEvent): void {
      const events = queue.get(workItemId) ?? [];
      events.push(event);
      queue.set(workItemId, events);
      timer ??= setInterval(flush, flushMs);
    },
    flush,
  };
}

type ActionRoute = { mutate: (input: PaneActionBatch) => Promise<unknown> };
type PaneScope = { workItemId: string; surface: PaneSurface };

let sink: ReturnType<typeof createPaneTelemetry> | null = null;
let scope: PaneScope | null = null;

function onPageHide() {
  sink?.flush();
}

/** The workItems.recordActions route on a tRPC client, or null when the build has none. */
export function paneActionRouteFrom(trpc: unknown): ActionRoute | null {
  const route = (trpc as { workItems?: { recordActions?: Partial<ActionRoute> } } | null)?.workItems?.recordActions;
  return route && typeof route.mutate === 'function' ? (route as ActionRoute) : null;
}

/** Wires the batcher to the server route. Call once with the tRPC client. Until then, actions are dropped. */
export function bindPaneTelemetry(trpc: unknown): void {
  const route = paneActionRouteFrom(trpc);
  if (!route) return;
  sink = createPaneTelemetry((batch) => route.mutate(batch));
  if (typeof window !== 'undefined') {
    window.removeEventListener('pagehide', onPageHide);
    window.addEventListener('pagehide', onPageHide);
  }
}

/** The pane's current work item and surface. Null when the pane shows no stored work item. */
export function setPaneTelemetryScope(next: PaneScope | null): void {
  scope = next;
}

/**
 * Records one action on the pane's current work item, or on `workItemId` when the caller names one (the needs-you list
 * dismisses items other than the open mail). With no work item, nothing is recorded.
 */
export function trackPaneAction(action: PaneAction, workItemId?: string): void {
  const id = workItemId ?? scope?.workItemId;
  if (!id || !sink) return;
  sink.track(id, { ...action, surface: scope?.surface });
}
