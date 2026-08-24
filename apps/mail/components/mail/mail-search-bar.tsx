'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { getMainSearchTerm } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { mailSearchBarFocusedAtom, useSearchValue } from '@/hooks/use-search-value';
import {
  attachmentFilter,
  EMPTY_SEARCH_VALUE,
  fromFilter,
  last7DaysFilter,
  loadRecentSearches,
  mergeSearchQuery,
  saveRecentSearch,
  toggleSearchFilter,
  type ActiveSearchFilter,
  type SearchScope,
  unreadFilter,
} from '@/lib/mail/search-list';

const MAX_EFFECTIVE_SEARCH_LENGTH = 512;
const QUERY_TOO_LONG_MESSAGE = 'Search query must be 512 characters or fewer.';

type MailSearchBarProps = {
  folderTitle: string;
};

type SearchSuggestion =
  | { kind: 'recent'; value: string }
  | { kind: 'from'; value: string };

function hasFilter(filters: ActiveSearchFilter[], next: ActiveSearchFilter) {
  return filters.some((filter) => filter.type === next.type && filter.value === next.value);
}

export function MailSearchBar({ folderTitle }: MailSearchBarProps) {
  const [searchValue, setSearchValue] = useSearchValue();
  const setSearchBarFocused = useSetAtom(mailSearchBarFocusedAtom);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchFieldRef = useRef<HTMLDivElement>(null);
  const suggestionListRef = useRef<HTMLUListElement>(null);
  const [localSearch, setLocalSearch] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(-1);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [filtersMenuOpen, setFiltersMenuOpen] = useState(false);

  const suggestions = useMemo<SearchSuggestion[]>(() => {
    const term = localSearch.trim();
    if (term) return [{ kind: 'from', value: term }];
    return recentSearches.map((value) => ({ kind: 'recent', value }));
  }, [localSearch, recentSearches]);
  const isSuggestionPopupOpen = recentOpen && suggestions.length > 0;

  const effectiveQuery = mergeSearchQuery(searchValue.value, searchValue.filters);
  useEffect(() => {
    setLocalSearch(searchValue.value);
  }, [searchValue.value]);

  const canUseEffectiveQuery = useCallback((query: string) => {
    if (query.length <= MAX_EFFECTIVE_SEARCH_LENGTH) return true;
    toast.error(QUERY_TOO_LONG_MESSAGE);
    return false;
  }, []);

  const closeRecentSearches = useCallback(() => {
    setRecentOpen(false);
    setHighlightedSuggestion(-1);
  }, []);

  const commitSearch = useCallback(
    (nextValue = localSearch) => {
      const nextEffectiveQuery = mergeSearchQuery(nextValue, searchValue.filters);
      if (!canUseEffectiveQuery(nextEffectiveQuery)) return false;

      setSearchValue({
        ...searchValue,
        value: nextValue,
        highlight: getMainSearchTerm(nextValue),
      });
      saveRecentSearch(nextValue);
      closeRecentSearches();
      return true;
    },
    [canUseEffectiveQuery, closeRecentSearches, localSearch, searchValue, setSearchValue],
  );

  const toggleFilter = useCallback(
    (filter: ActiveSearchFilter) => {
      const filters = toggleSearchFilter(searchValue.filters, filter);
      const nextEffectiveQuery = mergeSearchQuery(searchValue.value, filters);
      if (!canUseEffectiveQuery(nextEffectiveQuery)) return false;

      setSearchValue({ ...searchValue, filters });
      return true;
    },
    [canUseEffectiveQuery, searchValue, setSearchValue],
  );

  const toggleLast7DaysFilter = useCallback(() => {
    const activeDateFilter = searchValue.filters.find((filter) => filter.type === 'date');
    return toggleFilter(activeDateFilter ?? last7DaysFilter());
  }, [searchValue.filters, toggleFilter]);

  const addFromFilter = useCallback(() => {
    const filter = fromFilter(localSearch);
    if (!filter) {
      toast.error('Type a name first');
      return false;
    }
    return toggleFilter(filter);
  }, [localSearch, toggleFilter]);

  const openRecentSearches = useCallback(() => {
    setRecentSearches(loadRecentSearches());
    setRecentOpen(true);
    setHighlightedSuggestion(-1);
  }, []);

  const applySuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      if (suggestion.kind === 'from') {
        addFromFilter();
        closeRecentSearches();
        return;
      }

      setLocalSearch(suggestion.value);
      commitSearch(suggestion.value);
    },
    [addFromFilter, closeRecentSearches, commitSearch],
  );

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', focusSearch);
    return () => {
      window.removeEventListener('keydown', focusSearch);
      setSearchBarFocused(false);
    };
  }, [setSearchBarFocused]);

  const selectScope = useCallback(
    (scope: SearchScope) => {
      setSearchValue({ ...searchValue, scope });
      setScopeMenuOpen(false);
    },
    [searchValue, setSearchValue],
  );

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setScopeMenuOpen(false);
      setFiltersMenuOpen(false);
      closeRecentSearches();
      event.currentTarget.blur();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!recentOpen) {
        openRecentSearches();
        setHighlightedSuggestion(0);
        return;
      }
      if (suggestions.length) {
        setHighlightedSuggestion((current) => (current + 1) % suggestions.length);
      }
      return;
    }

    if (event.key === 'ArrowUp' && recentOpen && suggestions.length) {
      event.preventDefault();
      setHighlightedSuggestion((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = suggestions[highlightedSuggestion];
      if (recentOpen && suggestion) {
        applySuggestion(suggestion);
        return;
      }
      commitSearch();
    }
  };

  const inputPlaceholder = searchValue.scope === 'all' ? 'Search all folders' : `Search ${folderTitle}`;
  const scopeLabel = searchValue.scope === 'all' ? 'All folders' : folderTitle;

  return (
    <form
      role="search"
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault();
        commitSearch();
      }}
    >
      <label className="sr-only" htmlFor="mail-search">
        Search mail
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <div
          ref={searchFieldRef}
          className="relative flex h-14 min-w-0 flex-1 items-center rounded-lg border border-input bg-background px-1 shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
        >
          <DropdownMenu open={scopeMenuOpen} onOpenChange={setScopeMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={scopeLabel}
                className="min-h-11 max-w-36 shrink-0 justify-between gap-1 px-2"
                size="sm"
                type="button"
                variant="ghost"
              >
                <span className="truncate">{scopeLabel}</span>
                <span aria-hidden="true">▾</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[40vh] overflow-y-auto">
              <DropdownMenuRadioGroup
                onValueChange={(scope) => selectScope(scope === 'all' ? 'all' : 'folder')}
                value={searchValue.scope}
              >
                <DropdownMenuRadioItem value="folder">This folder</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="all">All folders</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            aria-autocomplete="list"
            aria-controls={isSuggestionPopupOpen ? 'mail-search-suggestions' : undefined}
            aria-expanded={isSuggestionPopupOpen}
            aria-activedescendant={
              highlightedSuggestion >= 0 && suggestions[highlightedSuggestion]
                ? `mail-search-suggestion-${highlightedSuggestion}`
                : undefined
            }
            className="h-14 min-w-0 flex-1 bg-transparent px-2 text-base outline-none placeholder:text-muted-foreground"
            id="mail-search"
            onBlur={(event) => {
              setSearchBarFocused(false);
              if (!suggestionListRef.current?.contains(event.relatedTarget)) {
                closeRecentSearches();
              }
            }}
            onChange={(event) => {
              setLocalSearch(event.target.value);
              setHighlightedSuggestion(-1);
            }}
            onFocus={() => {
              setSearchBarFocused(true);
              openRecentSearches();
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={inputPlaceholder}
            ref={inputRef}
            role="searchbox"
            type="search"
            value={localSearch}
          />

          {!localSearch && (
            <>
              <span className="sr-only">Press Command or Control K to focus search</span>
              <kbd
                aria-hidden="true"
                className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground md:inline-flex"
              >
                ⌘K / Ctrl+K
              </kbd>
            </>
          )}

          {(localSearch || searchValue.value || searchValue.filters.length > 0) && (
            <Button
              aria-label="Clear search"
              className="min-h-11 min-w-11 shrink-0 px-0"
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setSearchValue(EMPTY_SEARCH_VALUE);
                setLocalSearch('');
                closeRecentSearches();
              }}
            >
              <span aria-hidden="true">×</span>
            </Button>
          )}

          {isSuggestionPopupOpen && (
            <ul
              className="bg-popover text-popover-foreground absolute top-full right-0 left-0 z-50 mt-1 max-h-[40vh] overflow-y-auto rounded-md border p-1 shadow-md"
              id="mail-search-suggestions"
              ref={suggestionListRef}
              role="listbox"
            >
              {suggestions.map((suggestion, index) => {
                const label =
                  suggestion.kind === 'from' ? `From ${suggestion.value}` : suggestion.value;
                return (
                  <li key={`${suggestion.kind}-${suggestion.value}`} role="none">
                    <button
                      aria-selected={highlightedSuggestion === index}
                      className="hover:bg-accent flex min-h-11 w-full cursor-pointer items-center rounded-sm px-2 text-left text-sm"
                      id={`mail-search-suggestion-${index}`}
                      role="option"
                      type="button"
                      onClick={() => applySuggestion(suggestion)}
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DropdownMenu open={filtersMenuOpen} onOpenChange={setFiltersMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              className="min-h-11 shrink-0"
              size="sm"
              type="button"
              variant="secondary"
            >
              Filters
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[40vh] overflow-y-auto">
            <DropdownMenuCheckboxItem
              checked={hasFilter(searchValue.filters, unreadFilter())}
              onSelect={() => {
                toggleFilter(unreadFilter());
                setFiltersMenuOpen(false);
              }}
            >
              Unread
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={hasFilter(searchValue.filters, attachmentFilter())}
              onSelect={() => {
                toggleFilter(attachmentFilter());
                setFiltersMenuOpen(false);
              }}
            >
              Has attachment
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={searchValue.filters.some((filter) => filter.type === 'date')}
              onSelect={() => {
                toggleLast7DaysFilter();
                setFiltersMenuOpen(false);
              }}
            >
              Last 7 days
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onSelect={() => {
                addFromFilter();
                setFiltersMenuOpen(false);
              }}
            >
              From
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {searchValue.filters.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2" aria-label="Active filters">
          {searchValue.filters.map((filter) => (
            <span
              className="bg-muted flex min-h-11 items-center gap-1 rounded-full pl-3 text-sm"
              key={`${filter.type}-${filter.value}`}
            >
              {filter.display}
              <Button
                aria-label={`Remove ${filter.display}`}
                className="min-h-11 min-w-11 rounded-full px-0"
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => toggleFilter(filter)}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </span>
          ))}
        </div>
      )}

      {searchValue.scope === 'all' && effectiveQuery && (
        <p className="mt-2 text-sm text-muted-foreground">
          All mail · Trash and Spam not included
        </p>
      )}
    </form>
  );
}
