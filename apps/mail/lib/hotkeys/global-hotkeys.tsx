import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useResetSearchValue } from '@/hooks/use-search-value';
import { enhancedKeyboardShortcuts } from '@/config/shortcuts';
import { useShortcuts } from './use-hotkey-utils';
import { useQueryState } from 'nuqs';

export function GlobalHotkeys() {
  const [, setComposeOpen] = useQueryState('isComposeOpen');
  const resetSearchValue = useResetSearchValue();
  const { undoLastAction } = useOptimisticActions();
  const scope = 'global';

  const handlers = {
    newEmail: () => setComposeOpen('true'),
    commandPalette: () => {
      document.getElementById('mail-search')?.focus();
    },
    clearAllFilters: () => {
      resetSearchValue();
    },
    undoLastAction: () => {
      undoLastAction();
    },
  };

  const globalShortcuts = enhancedKeyboardShortcuts.filter((shortcut) => shortcut.scope === scope);

  useShortcuts(globalShortcuts, handlers, { scope });

  return null;
}
