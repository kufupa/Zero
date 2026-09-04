'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { getMainSearchTerm } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  mailSearchBarFocusedAtom,
  searchResultCountAtom,
  useResetSearchValue,
  useSearchValue,
} from '@/hooks/use-search-value';
import { getMailCacheScope, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import {
  attachmentFilter,
  fromFilter,
  getRecentSearchScopeKey,
  last7DaysFilter,
  loadRecentSearches,
  MAX_EFFECTIVE_SEARCH_LENGTH,
  mergeSearchQuery,
  removeLegacyRecentSearches,
  SEARCH_QUERY_TOO_LONG_MESSAGE,
  saveRecentSearch,
  toggleSearchFilter,
  type ActiveSearchFilter,
  type SearchScope,
  unreadFilter,
} from '@/lib/mail/search-list';

type MailSearchBarProps = {
  folderTitle: string;
  resultCount?: number;
};

type SearchSuggestion =
  | { kind: 'recent'; value: string }
  | { kind: 'from'; value: string };

function hasFilter(filters: ActiveSearchFilter[], next: ActiveSearchFilter) {
  return filters.some((filter) => filter.type === next.type && filter.value === next.value);
}

export function MailSearchBar({ folderTitle, resultCount }: MailSearchBarProps) {
  const { folder } = useParams<{ folder: string }>();
  const [searchValue, setSearchValue] = useSearchValue();
  const resetSearchValue = useResetSearchValue();
  const setSearchBarFocused = useSetAtom(mailSearchBarFocusedAtom);
  const mailCacheScope = useSyncExternalStore(
    subscribeMailCacheScope,
    getMailCacheScope,
    getMailCacheScope,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionListRef = useRef<HTMLUListElement>(null);
  const resetVersionRef = useRef(searchValue.resetVersion);
  const [localSearch, setLocalSearch] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [recentSearchScopeKey, setRecentSearchScopeKey] = useState<string | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(-1);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [filtersMenuOpen, setFiltersMenuOpen] = useState(false);
  const [hasSearchControlFocus, setHasSearchControlFocus] = useState(false);
  const atomResultCount = useAtomValue(searchResultCountAtom);
  const effectiveResultCount = resultCount !== undefined ? resultCount : atomResultCount;
  const isDraftsRoute = folder?.toLowerCase() === 'draft' || folder?.toLowerCase() === 'drafts';
  const isThisFolderDrafts = isDraftsRoute && searchValue.scope === 'folder';
  const currentRecentSearchScopeKey = getRecentSearchScopeKey(mailCacheScope);
  const hasActiveSearch = Boolean(
    localSearch.trim() || searchValue.value.trim() || searchValue.filters.length > 0,
  );

  const suggestions = useMemo<SearchSuggestion[]>(() => {
    const term = localSearch.trim();
    if (term) return [{ kind: 'from', value: term }];
    if (recentSearchScopeKey !== currentRecentSearchScopeKey) return [];
    return recentSearches.map((value) => ({ kind: 'recent', value }));
  }, [currentRecentSearchScopeKey, localSearch, recentSearches, recentSearchScopeKey]);
  const isSuggestionPopupOpen = recentOpen && suggestions.length > 0;

  const effectiveQuery = mergeSearchQuery(searchValue.value, searchValue.filters);
  useEffect(() => {
    setLocalSearch(searchValue.value);
  }, [searchValue.value]);

  useEffect(() => {
    if (resetVersionRef.current === searchValue.resetVersion) return;
    resetVersionRef.current = searchValue.resetVersion;
    setLocalSearch('');
  }, [searchValue.resetVersion]);

  useEffect(() => {
    removeLegacyRecentSearches();
  }, []);

  useEffect(() => {
    setRecentSearches([]);
    setRecentSearchScopeKey(null);
    setRecentOpen(false);
    setHighlightedSuggestion(-1);
  }, [mailCacheScope.activeTransportId, mailCacheScope.userId]);

  useEffect(() => {
    if (!isThisFolderDrafts || searchValue.filters.length === 0) return;
    setSearchValue({ ...searchValue, filters: [] });
  }, [isThisFolderDrafts, searchValue, setSearchValue]);

  useEffect(() => {
    setSearchBarFocused(
      hasSearchControlFocus || scopeMenuOpen || filtersMenuOpen || isSuggestionPopupOpen,
    );
  }, [
    filtersMenuOpen,
    hasSearchControlFocus,
    isSuggestionPopupOpen,
    scopeMenuOpen,
    setSearchBarFocused,
  ]);

  useEffect(() => () => setSearchBarFocused(false), [setSearchBarFocused]);

  const canUseEffectiveQuery = useCallback((query: string) => {
    if (query.length <= MAX_EFFECTIVE_SEARCH_LENGTH) return true;
    toast.error(SEARCH_QUERY_TOO_LONG_MESSAGE);
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
      if (isThisFolderDrafts) return false;
      const filters = toggleSearchFilter(searchValue.filters, filter);
      const nextEffectiveQuery = mergeSearchQuery(searchValue.value, filters);
      if (!canUseEffectiveQuery(nextEffectiveQuery)) return false;

      setSearchValue({ ...searchValue, filters });
      return true;
    },
    [canUseEffectiveQuery, isThisFolderDrafts, searchValue, setSearchValue],
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
    setRecentSearchScopeKey(currentRecentSearchScopeKey);
    setRecentOpen(true);
    setHighlightedSuggestion(-1);
  }, [currentRecentSearchScopeKey]);

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
    };
  }, [setSearchBarFocused]);

  const selectScope = useCallback(
    (scope: SearchScope) => {
      setSearchValue({
        ...searchValue,
        scope,
        filters: scope === 'folder' && isDraftsRoute ? [] : searchValue.filters,
      });
      setScopeMenuOpen(false);
    },
    [isDraftsRoute, searchValue, setSearchValue],
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
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setHasSearchControlFocus(false);
        }
      }}
      onFocusCapture={() => {
        setHasSearchControlFocus(true);
      }}
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
              if (!suggestionListRef.current?.contains(event.relatedTarget)) {
                closeRecentSearches();
              }
            }}
            onChange={(event) => {
              setLocalSearch(event.target.value);
              setHighlightedSuggestion(-1);
            }}
            onFocus={() => {
              openRecentSearches();
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={inputPlaceholder}
            ref={inputRef}
            role="searchbox"
            type="search"
            value={localSearch}
          />

          {hasActiveSearch && effectiveResultCount !== undefined && (
            <Badge
              variant="secondary"
              className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground shrink-0"
              aria-label={`${effectiveResultCount} ${effectiveResultCount === 1 ? 'result' : 'results'} found`}
            >
              {effectiveResultCount} {effectiveResultCount === 1 ? 'result' : 'results'}
            </Badge>
          )}

          {!localSearch && !hasActiveSearch && (
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
                resetSearchValue();
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
              disabled={isThisFolderDrafts}
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
