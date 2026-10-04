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
  activateNative: (payload: Activation) => Promise<unknown>;
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
  const current = useRef(input);
  current.current = input;
  const owner = useRef(key);
  owner.current = key;
  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    status: SyncStatusV1 | null;
    error: string | null;
    busy: boolean;
  }>({ key: null, status: null, error: null, busy: false });
  const readStatus = useCallback(async (k: string, id: string) => {
    const result = await trpcClient.workstation.outlookSync.status.query({ sourceId: id });
    if (owner.current === k) setSnapshot({ key: k, status: result, error: null, busy: false });
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
        const status = await readStatus(k, local.sourceId!);
        const busy = status.discovered > status.committed && !status.userPaused;
        timer = setTimeout(tick, busy ? 5000 : 30000);
      } catch (error) {
        if (!mounted || owner.current !== k) return;
        const code = (error as { data?: { code?: string } })?.data?.code;
        setSnapshot((previous) => ({
          key: k,
          status: previous.key === k ? previous.status : null,
          error: code === 'FORBIDDEN' ? 'access-removed' : 'offline',
          busy: false,
        }));
        if (code !== 'FORBIDDEN') timer = setTimeout(tick, 5000);
      }
    }
    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, readStatus]);
  const control = useCallback(
    async (operation: SyncControlOperation) => {
      const k = owner.current,
        s = snapshot.key === k ? snapshot.status : null;
      if (!k || !s || (s.userPaused && operation !== 'resume'))
        throw new Error('Sync paused or unavailable');
      setSnapshot((previous) => ({ ...previous, busy: true }));
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
        await trpcClient.workstation.outlookSync.control.mutate({
          sourceId: s.sourceId,
          operation,
          idempotencyKey: crypto.randomUUID(),
        });
        if (owner.current === k && resumeActivation)
          await native.activateNative({
            version: 1,
            sourceId: s.sourceId,
            storeId: root.storeId,
            rootEntryId: root.rootEntryId,
            activationTicket: resumeActivation.activationTicket,
            idempotencyKey: resumeKey,
          });
        if (owner.current === k) await readStatus(k, s.sourceId);
      } catch (error) {
        if (owner.current === k)
          setSnapshot((previous) => ({ ...previous, error: 'offline', busy: false }));
        throw error;
      }
    },
    [snapshot, readStatus],
  );
  return {
    status: snapshot.key === key ? snapshot.status : null,
    error: snapshot.key === key ? snapshot.error : null,
    busy: snapshot.key === key ? snapshot.busy : false,
    eligible,
    control,
  };
}
