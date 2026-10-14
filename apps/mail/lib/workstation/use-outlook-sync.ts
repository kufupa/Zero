import type { SyncControlOperation } from '@/components/workstation/outlook-sync-progress';
import type { SyncStatusV1 } from '@zero/server/outlook-sync-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpcClient } from '@/providers/query-provider';

type Root = {
  storeId: string;
  rootEntryId: string;
  policyVersion: number;
  policyGeneration: number;
};
type Activation = {
  version: 1;
  sourceId: string;
  storeId: string;
  rootEntryId: string;
  activationTicket: string;
  idempotencyKey: string;
};
export type OutlookSyncClientInput = {
  userId: string | null;
  sessionId: string | null;
  transportId: string | null;
  mailbox: string;
  deviceId: string | null;
  capabilityVersion: number | undefined;
  readRoots: Root[];
  authorized: boolean;
  /** Webmail can inspect the active mailbox's server status, but cannot activate or control native Outlook sync. */
  readOnlyStatus?: boolean;
  activateNative: (payload: Activation) => Promise<unknown>;
};
type ActiveMailboxSyncStatusClient = {
  workstation: {
    outlookSync: {
      statusForActiveMailbox: { query: (input: Record<string, never>) => Promise<SyncStatusV1 | null> };
    };
  };
};
type Entry = {
  idempotencyKey: string;
  sourceId: string | null;
  createdAt: number;
  flight: Promise<string> | null;
};
// This bounded cache holds IDs/request keys only. Native response handles never enter JS or storage.
const activations = new Map<string, Entry>();
export function useOutlookSync(input: OutlookSyncClientInput) {
  const root = input.readRoots.find((r) => r.policyVersion === 1),
    eligible = Boolean(
      input.authorized &&
        input.userId &&
        input.sessionId &&
        input.transportId &&
        input.deviceId &&
        input.capabilityVersion === 1 &&
        root,
    );
  const key = eligible
    ? JSON.stringify([
        input.userId,
        input.sessionId,
        input.transportId,
        input.deviceId,
        root!.storeId,
        root!.rootEntryId,
        root!.policyGeneration,
      ])
    : null;
  const readOnlyKey = input.readOnlyStatus && input.authorized && input.userId && input.sessionId && input.transportId
    ? JSON.stringify(['mailbox-status', input.userId, input.sessionId, input.transportId])
    : null;
  const statusKey = key ?? readOnlyKey;
  const current = useRef(input);
  current.current = input;
  const owner = useRef(key);
  const readOnlyOwner = useRef(readOnlyKey);
  readOnlyOwner.current = readOnlyKey;
  const scopeRevision = useRef(0);
  const statusRevision = useRef(0);
  const controlFlight = useRef<{ key: string; revision: number } | null>(null);
  if (owner.current !== key) {
    scopeRevision.current++;
    statusRevision.current++;
    controlFlight.current = null;
  }
  owner.current = key;
  const [pendingControl, setPendingControl] = useState<{
    key: string;
    revision: number;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    status: SyncStatusV1 | null;
    error: string | null;
  }>({ key: null, status: null, error: null });
  const readStatus = useCallback(async (k: string, id: string) => {
    const revision = ++statusRevision.current;
    const result = await trpcClient.workstation.outlookSync.status.query({ sourceId: id });
    if (owner.current === k && statusRevision.current === revision)
      setSnapshot({ key: k, status: result, error: null });
    return result;
  }, []);
  useEffect(() => {
    if (!key) return;
    const k = key;
    let mounted = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    let entry = activations.get(k);
    if (!entry) {
      if (activations.size >= 32) activations.delete(activations.keys().next().value!);
      entry = {
        idempotencyKey: crypto.randomUUID(),
        sourceId: null,
        createdAt: Date.now(),
        flight: null,
      };
      activations.set(k, entry);
    }
    const local = entry;
    async function tick() {
      if (!mounted || owner.current !== k) return;
      let requestRevision: number | null = null;
      try {
        if (!local.sourceId) {
          if (!local.flight) {
            local.flight = (async () => {
              const now = current.current,
                r = now.readRoots.find((x) => x.policyVersion === 1)!;
              if (Date.now() - local.createdAt >= 60_000) {
                local.idempotencyKey = crypto.randomUUID();
                local.createdAt = Date.now();
              }
              const a = await trpcClient.workstation.outlookSync.activate.mutate({
                deviceId: now.deviceId!,
                storeId: r.storeId,
                rootEntryId: r.rootEntryId,
                capabilityVersion: 1,
                idempotencyKey: local.idempotencyKey,
              });
              if (owner.current !== k) throw new Error('Outlook account changed');
              await now.activateNative({
                version: 1,
                sourceId: a.sourceId,
                storeId: r.storeId,
                rootEntryId: r.rootEntryId,
                activationTicket: a.activationTicket,
                idempotencyKey: local.idempotencyKey,
              });
              local.sourceId = a.sourceId;
              return a.sourceId;
            })().finally(() => {
              local.flight = null;
            });
          }
          await local.flight;
        }
        if (!mounted || owner.current !== k) return;
        if (controlFlight.current) {
          timer = setTimeout(tick, 5000);
          return;
        }
        requestRevision = statusRevision.current + 1;
        const status = await readStatus(k, local.sourceId!);
        if (!mounted || owner.current !== k) return;
        if (statusRevision.current !== requestRevision) {
          timer = setTimeout(tick, 5000);
          return;
        }
        const busy = status.discovered > status.committed && !status.userPaused;
        timer = setTimeout(tick, busy ? 5000 : 30000);
      } catch (error) {
        if (!mounted || owner.current !== k) return;
        if (requestRevision !== null && statusRevision.current !== requestRevision) {
          timer = setTimeout(tick, 5000);
          return;
        }
        const code = (error as { data?: { code?: string } })?.data?.code;
        setSnapshot((previous) => ({
          key: k,
          status: previous.key === k ? previous.status : null,
          error: code === 'FORBIDDEN' ? 'access-removed' : 'offline',
        }));
        if (code !== 'FORBIDDEN') timer = setTimeout(tick, 5000);
      }
    }
    void tick();
    return () => {
      mounted = false;
      scopeRevision.current++;
      statusRevision.current++;
      controlFlight.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [key, readStatus]);
  useEffect(() => {
    if (key || !readOnlyKey) return;
    const ownerKey = readOnlyKey;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      if (!mounted || readOnlyOwner.current !== ownerKey) return;
      try {
        const status = await (trpcClient as unknown as ActiveMailboxSyncStatusClient)
          .workstation.outlookSync.statusForActiveMailbox.query({});
        if (!mounted || readOnlyOwner.current !== ownerKey) return;
        setSnapshot({ key: ownerKey, status, error: null });
        const pending = status !== null && status.discovered > status.committed && !status.userPaused;
        timer = setTimeout(tick, pending ? 5000 : 30000);
      } catch (error) {
        if (!mounted || readOnlyOwner.current !== ownerKey) return;
        const code = (error as { data?: { code?: string } })?.data?.code;
        setSnapshot({ key: ownerKey, status: null, error: code === 'FORBIDDEN' ? 'access-removed' : 'offline' });
        if (code !== 'FORBIDDEN') timer = setTimeout(tick, 5000);
      }
    }
    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, readOnlyKey]);
  const control = useCallback(
    async (operation: SyncControlOperation) => {
      const k = owner.current,
        s = snapshot.key === k ? snapshot.status : null;
      if (!k || !s || (s.userPaused && operation !== 'resume'))
        throw new Error('Sync paused or unavailable');
      if (controlFlight.current) throw new Error('Sync control already in progress');
      const flight = { key: k, revision: scopeRevision.current };
      const isCurrent = () => owner.current === k && scopeRevision.current === flight.revision;
      controlFlight.current = flight;
      statusRevision.current++;
      setPendingControl(flight);
      try {
        const native = current.current;
        const root = native.readRoots.find((r) => r.policyVersion === 1)!;
        let resumeActivation: Awaited<
          ReturnType<typeof trpcClient.workstation.outlookSync.activate.mutate>
        > | null = null;
        const resumeKey = crypto.randomUUID();
        if (operation === 'resume')
          resumeActivation = await trpcClient.workstation.outlookSync.activate.mutate({
            sourceId: s.sourceId,
            deviceId: native.deviceId!,
            storeId: root.storeId,
            rootEntryId: root.rootEntryId,
            capabilityVersion: 1,
            idempotencyKey: resumeKey,
          });
        if (!isCurrent()) return;
        await trpcClient.workstation.outlookSync.control.mutate({
          sourceId: s.sourceId,
          operation,
          idempotencyKey: crypto.randomUUID(),
        });
        if (isCurrent() && resumeActivation)
          await native.activateNative({
            version: 1,
            sourceId: s.sourceId,
            storeId: root.storeId,
            rootEntryId: root.rootEntryId,
            activationTicket: resumeActivation.activationTicket,
            idempotencyKey: resumeKey,
          });
        if (isCurrent()) await readStatus(k, s.sourceId);
      } catch (error) {
        if (isCurrent()) setSnapshot((previous) => ({ ...previous, error: 'offline' }));
        throw error;
      } finally {
        if (controlFlight.current === flight) {
          controlFlight.current = null;
          setPendingControl(null);
        }
      }
    },
    [snapshot, readStatus],
  );
  return {
    status: snapshot.key === statusKey ? snapshot.status : null,
    error: snapshot.key === statusKey ? snapshot.error : null,
    statusLoaded: Boolean(statusKey && snapshot.key === statusKey),
    busy: pendingControl?.key === key && pendingControl.revision === scopeRevision.current,
    eligible,
    control,
  };
}
