import { atom, useAtom } from 'jotai';
import { EMPTY_SEARCH_VALUE, type SearchValueState } from '@/lib/mail/search-list';

const configAtom = atom<SearchValueState>(EMPTY_SEARCH_VALUE);

export const mailSearchBarFocusedAtom = atom(false);

export function useSearchValue() {
  return useAtom(configAtom);
}
