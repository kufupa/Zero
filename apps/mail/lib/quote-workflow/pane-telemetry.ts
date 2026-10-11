/**
 * Pane action telemetry (v5 B1). Actions queue per work item and go out as one batched workItems.recordActions call: on
 * an interval, at pagehide, or as a full batch. A send that fails is dropped and nothing waits on it, so telemetry never
 * blocks the pane or shows in it. Only an action's type, enum and number are sent, never mail text. The pane sets its
 * current work item, and the mailbox that owns it, with setPaneTelemetryScope, so action sites deep in the tree need no
 * props. A batch goes out under the mailbox its work item lives in, even when the person has switched mailbox since. An
 * action that a request finishes later takes its owner from currentPaneOwner when it starts. With no work item, nothing
 * is recorded. The server keeps the allowlist and the batch cap.
 */
import { inMailbox } from '@/lib/mail/mail-cache-scope';

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
/** A work item and the mailbox it lives in. A null transport means the mailbox active when the batch is sent. */
export type PaneOwner = { workItemId: string; transportId: string | null };
type OwnedBatch = PaneActionBatch & { transportId: string | null };

export const PANE_ACTION_BATCH_MAX = 50;
export const PANE_ACTION_FLUSH_MS = 5_000;

/** Queues actions per work item and mailbox, and sends them in batches of at most PANE_ACTION_BATCH_MAX. Never throws. */
export function createPaneTelemetry(send: (batch: OwnedBatch) => Promise<unknown>, flushMs = PANE_ACTION_FLUSH_MS) {
  const queue = new Map<string, OwnedBatch>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    for (const [key, batch] of queue) {
      queue.delete(key);
      for (let at = 0; at < batch.events.length; at += PANE_ACTION_BATCH_MAX) {
        const chunk = batch.events.slice(at, at + PANE_ACTION_BATCH_MAX);
        // ponytail: a failed send is dropped, not retried. Telemetry is best effort and must never reach the person.
        try {
          void Promise.resolve(send({ ...batch, events: chunk })).catch(() => undefined);
        } catch {
          // A send that throws is dropped the same way.
        }
      }
    }
  }

  return {
    track(owner: PaneOwner, event: PaneActionEvent): void {
      // One queue per work item and mailbox, so a batch never mixes mailboxes.
      const key = JSON.stringify([owner.transportId, owner.workItemId]);
      const batch = queue.get(key) ?? { workItemId: owner.workItemId, transportId: owner.transportId, events: [] };
      batch.events.push(event);
      queue.set(key, batch);
      timer ??= setInterval(flush, flushMs);
    },
    flush,
  };
}

type ActionRoute = { mutate: (input: PaneActionBatch, options?: ReturnType<typeof inMailbox>) => Promise<unknown> };
type PaneScope = PaneOwner & { surface: PaneSurface };

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
  sink = createPaneTelemetry(({ transportId, ...batch }) => {
    const pinned = inMailbox(transportId);
    return pinned ? route.mutate(batch, pinned) : route.mutate(batch);
  });
  if (typeof window !== 'undefined') {
    window.removeEventListener('pagehide', onPageHide);
    window.addEventListener('pagehide', onPageHide);
  }
}

/** The pane's current work item, its surface and the mailbox it lives in. Null when the pane shows no stored work item. */
export function setPaneTelemetryScope(next: PaneScope | null): void {
  scope = next;
}

/** The pane's current work item and its mailbox. Read when an action starts, so the event lands on that item later. */
export function currentPaneOwner(): PaneOwner | null {
  return scope ? { workItemId: scope.workItemId, transportId: scope.transportId } : null;
}

/**
 * Records one action on `owner`, which defaults to the pane's current work item. The needs-you list dismisses items
 * other than the open mail, and a lookup or PDF passes the owner it started on. A null owner records nothing.
 */
export function trackPaneAction(action: PaneAction, owner: PaneOwner | null = currentPaneOwner()): void {
  if (!owner || !sink) return;
  sink.track(owner, { ...action, surface: scope?.surface });
}
