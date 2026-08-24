import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useSearchValue } from '@/hooks/use-search-value';
import { enhancedKeyboardShortcuts } from '@/config/shortcuts';
import { EMPTY_SEARCH_VALUE } from '@/lib/mail/search-list';
import { useShortcuts } from './use-hotkey-utils';
import { useQueryState } from 'nuqs';

export function GlobalHotkeys() {
  const [, setComposeOpen] = useQueryState('isComposeOpen');
  const [, setSearchValue] = useSearchValue();
  const { undoLastAction } = useOptimisticActions();
  const scope = 'global';

  const handlers = {
    newEmail: () => setComposeOpen('true'),
    commandPalette: () => {
      document.getElementById('mail-search')?.focus();
    },
    clearAllFilters: () => {
      setSearchValue(EMPTY_SEARCH_VALUE);
    },
    undoLastAction: () => {
      undoLastAction();
    },
  };

  const globalShortcuts = enhancedKeyboardShortcuts.filter((shortcut) => shortcut.scope === scope);

  useShortcuts(globalShortcuts, handlers, { scope });

  return null;
}
