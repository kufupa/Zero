import { atom, useAtom } from 'jotai';

export type State = {
  isSyncing: boolean;
  syncingFolders: string[];
  storageSize: number;
  counts: { label: string; count: number }[];
  shards: number;
  /** Epoch ms of last successful forceSync (or poll-driven sync marker). */
  lastSyncAt: number | null;
};

const stateAtom = atom<State>({
  isSyncing: false,
  syncingFolders: [],
  storageSize: 0,
  counts: [],
  shards: 0,
  lastSyncAt: null,
});

function useDoState() {
  return useAtom(stateAtom);
}

const setIsSyncingAtom = atom(null, (get, set, isSyncing: boolean) => {
  const current = get(stateAtom);
  set(stateAtom, { ...current, isSyncing });
});

const setSyncingFoldersAtom = atom(null, (get, set, syncingFolders: string[]) => {
  const current = get(stateAtom);
  set(stateAtom, { ...current, syncingFolders });
});

const setStorageSizeAtom = atom(null, (get, set, storageSize: number) => {
  const current = get(stateAtom);
  set(stateAtom, { ...current, storageSize });
});

const setLastSyncAtAtom = atom(null, (get, set, lastSyncAt: number | null) => {
  const current = get(stateAtom);
  set(stateAtom, { ...current, lastSyncAt });
});

export {
  setIsSyncingAtom,
  setSyncingFoldersAtom,
  setStorageSizeAtom,
  setLastSyncAtAtom,
  useDoState,
};
