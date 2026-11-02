import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptimisticActions } from './use-optimistic-actions';
import { useMail } from '@/components/mail/use-mail';
import { mailSearchBarFocusedAtom } from '@/hooks/use-search-value';
import { focusThreadElement } from '@/lib/mail/mail-row-focus';
import { useHotkeys } from 'react-hotkeys-hook';
import { atom, useAtom, useAtomValue } from 'jotai';

export const focusedIndexAtom = atom<number | null>(null);
export const mailNavigationCommandAtom = atom<null | 'next' | 'previous'>(null);

export interface UseMailNavigationProps {
  items: { id: string }[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  onNavigate: (threadId: string | null) => Promise<boolean>;
}

export function useMailNavigation({ items, containerRef, onNavigate }: UseMailNavigationProps) {
  const [, setMail] = useMail();
  const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);
  const [command, setCommand] = useAtom(mailNavigationCommandAtom);
  const { optimisticMarkAsRead } = useOptimisticActions();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const isSearchBarFocused = useAtomValue(mailSearchBarFocusedAtom);

  const hoveredMailRef = useRef<string | null>(null);
  const keyboardActiveRef = useRef(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const lastMoveTime = useRef(0);

  const setKeyboardNavigationActive = useCallback((active: boolean) => {
    keyboardActiveRef.current = active;
    setKeyboardActive(active);
  }, []);

  const navigationInFlight = useRef(false);
  const attemptNavigation = useCallback(async (threadId: string | null): Promise<boolean> => {
    if (navigationInFlight.current) return false;
    navigationInFlight.current = true;
    try {
      return await onNavigateRef.current(threadId);
    } catch {
      return false;
    } finally {
      navigationInFlight.current = false;
    }
  }, []);

  const resetNavigation = useCallback(async () => {
    if (!(await attemptNavigation(null))) return;
    setFocusedIndex(null);
    setKeyboardNavigationActive(false);
  }, [setFocusedIndex, attemptNavigation, setKeyboardNavigationActive]);

  const getThreadElement = useCallback(
    (index: number | null) => {
      if (index === null || !containerRef.current) return null;
      return containerRef.current.querySelector(
        `[data-thread-id="${itemsRef.current[index]?.id}"]`,
      ) as HTMLElement | null;
    },
    [containerRef],
  );

  const focusThreadAtIndex = useCallback(
    (index: number) => focusThreadElement(getThreadElement(index)),
    [getThreadElement],
  );

  const focusedThreadId =
    focusedIndex === null ? null : (itemsRef.current[focusedIndex]?.id ?? null);

  useEffect(() => {
    if (!keyboardActive || focusedIndex === null || !focusedThreadId) return;

    let cancelled = false;
    let frameId: number | null = null;
    let attempts = 0;

    const tryFocus = () => {
      if (cancelled || !keyboardActiveRef.current) return;
      if (focusThreadAtIndex(focusedIndex)) return;
      if (attempts >= 6 || typeof window === 'undefined') return;

      attempts += 1;
      frameId = window.requestAnimationFrame(tryFocus);
    };

    tryFocus();

    return () => {
      cancelled = true;
      if (frameId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [focusedIndex, focusedThreadId, focusThreadAtIndex, keyboardActive]);

  const scrollIntoView = useCallback(
    (index: number, behavior: ScrollBehavior = 'smooth') => {
      const threadElement = getThreadElement(index);
      if (!threadElement || !containerRef.current) return;

      const container = containerRef.current;
      const containerRect = container.getBoundingClientRect();
      const threadRect = threadElement.getBoundingClientRect();

      if (threadRect.top < containerRect.top || threadRect.bottom > containerRect.bottom) {
        threadElement.scrollIntoView({
          block: 'nearest',
          behavior,
        });
      }
    },
    [containerRef, getThreadElement],
  );

  const navigateToThread = useCallback(
    async (index: number): Promise<boolean> => {
      const threadId = itemsRef.current[index]?.id;
      if (!threadId || !(await attemptNavigation(threadId))) return false;
      optimisticMarkAsRead([threadId], true);
      setMail((prev) => ({ ...prev, bulkSelected: [] }));
      return true;
    },
    [attemptNavigation, setMail, optimisticMarkAsRead],
  );

  const navigateNext = useCallback(async () => {
    const index = focusedIndex;
    const items = itemsRef.current;
    const nextIndex = index === null ? (items.length ? 0 : null)
      : index < items.length - 1 ? index + 1 : items.length > 1 ? index - 1 : null;
    const nextId = nextIndex === null ? null : items[nextIndex]?.id ?? null;
    if (!(await attemptNavigation(nextId))) return;
    const focusIndex = index !== null && nextIndex === index + 1 ? index : nextIndex;
    setKeyboardNavigationActive(true);
    setFocusedIndex(focusIndex);
    if (focusIndex !== null) scrollIntoView(focusIndex, 'auto');
  }, [attemptNavigation, focusedIndex, scrollIntoView, setFocusedIndex, setKeyboardNavigationActive]);

  useEffect(() => {
    if (command === 'next') {
      navigateNext();
      setCommand(null);
    }
  }, [command, navigateNext, setCommand]);

  const getHoveredIndex = useCallback(() => {
    if (!hoveredMailRef.current) return -1;
    return itemsRef.current.findIndex((item) => item.id === hoveredMailRef.current);
  }, []);

  const moveFocus = useCallback(
    async (direction: 'up' | 'down') => {
      if (navigationInFlight.current || itemsRef.current.length === 0) return;
      const hoveredIndex = getHoveredIndex();
      const newIndex = focusedIndex === null
        ? hoveredIndex !== -1 ? hoveredIndex : direction === 'up' ? itemsRef.current.length - 1 : 0
        : direction === 'up' ? Math.max(0, focusedIndex - 1) : Math.min(itemsRef.current.length - 1, focusedIndex + 1);
      if (newIndex === focusedIndex) return;
      const targetId = itemsRef.current[newIndex]?.id;
      if (!targetId || !(await navigateToThread(newIndex))) return;
      const currentIndex = itemsRef.current.findIndex((item) => item.id === targetId);
      if (currentIndex < 0) return;
      setKeyboardNavigationActive(true);
      setFocusedIndex(currentIndex);
      scrollIntoView(currentIndex, 'smooth');
    },
    [focusedIndex, setFocusedIndex, getHoveredIndex, scrollIntoView, navigateToThread, setKeyboardNavigationActive],
  );

  const handleArrowUp = useCallback(() => {
    void moveFocus('up');
  }, [moveFocus]);

  const handleArrowDown = useCallback(() => {
    void moveFocus('down');
  }, [moveFocus]);

  const handleEnter = useCallback(() => {
    if (focusedIndex === null) return;

    const message = itemsRef.current[focusedIndex];
    if (message) void attemptNavigation(message.id);
  }, [focusedIndex, attemptNavigation]);

  const handleEscape = useCallback(() => {
    void resetNavigation();
  }, [resetNavigation]);

  useHotkeys('ArrowUp', handleArrowUp, { preventDefault: true, enabled: !isSearchBarFocused });
  useHotkeys('ArrowDown', handleArrowDown, {
    preventDefault: true,
    enabled: !isSearchBarFocused,
  });
  useHotkeys('j', handleArrowDown, { enabled: !isSearchBarFocused });
  useHotkeys('k', handleArrowUp, { enabled: !isSearchBarFocused });
  useHotkeys('Enter', handleEnter, { preventDefault: true, enabled: !isSearchBarFocused });
  useHotkeys('Escape', handleEscape, { preventDefault: true, enabled: !isSearchBarFocused });

  const handleMouseEnter = useCallback(
    (threadId: string) => {
      hoveredMailRef.current = threadId;

      setKeyboardNavigationActive(false);
    },
    [setKeyboardNavigationActive],
  );

  useEffect(() => {
    let isProcessingKey = false;
    const MOVE_DELAY = 100;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSearchBarFocused) return;
      if (!event.repeat) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

      event.preventDefault();

      const now = Date.now();
      if (now - lastMoveTime.current < MOVE_DELAY) return;

      if (isProcessingKey) return;
      isProcessingKey = true;
      lastMoveTime.current = now;

      requestAnimationFrame(() => {
        if (event.key === 'ArrowUp') {
          void moveFocus('up');
        } else if (event.key === 'ArrowDown') {
          void moveFocus('down');
        }
        isProcessingKey = false;
      });
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [moveFocus, isSearchBarFocused]);

  useEffect(() => {
    if (isSearchBarFocused) {
      setKeyboardNavigationActive(false);
    }
  }, [isSearchBarFocused, setKeyboardNavigationActive]);

  return {
    focusedIndex,
    handleMouseEnter,
    keyboardActive,
    resetNavigation,
  };
}
