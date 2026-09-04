import { atom, useAtom, useSetAtom } from 'jotai';
import { EMPTY_SEARCH_VALUE, type SearchValueState } from '@/lib/mail/search-list';

const configAtom = atom<SearchValueState>(EMPTY_SEARCH_VALUE);
const resetSearchValueAtom = atom(null, (get, set) => {
  const current = get(configAtom);
  set(configAtom, {
    ...EMPTY_SEARCH_VALUE,
    resetVersion: current.resetVersion + 1,
  });
});

export const mailSearchBarFocusedAtom = atom(false);
export const searchResultCountAtom = atom<number | undefined>(undefined);

export function useSearchValue() {
  return useAtom(configAtom);
}

export function useResetSearchValue() {
  return useSetAtom(resetSearchValueAtom);
}
