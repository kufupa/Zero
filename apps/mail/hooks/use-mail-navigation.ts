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
  onNavigate: (threadId: string | null) => void;
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

  const resetNavigation = useCallback(() => {
    setFocusedIndex(null);
    onNavigateRef.current(null);
    setKeyboardNavigationActive(false);
  }, [setFocusedIndex, onNavigateRef, setKeyboardNavigationActive]);

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
    (index: number) => {
      if (index === null || !itemsRef.current[index]) return;

      const message = itemsRef.current[index];
      const threadId = message.id;

      if (threadId) {
        onNavigateRef.current(threadId);
        optimisticMarkAsRead([threadId], true);
      }

      setMail((prev) => ({
        ...prev,
        bulkSelected: [],
      }));
    },
    [setMail, optimisticMarkAsRead],
  );

  const navigateNext = useCallback(() => {
    setKeyboardNavigationActive(true);

    setFocusedIndex((prevIndex) => {
      if (prevIndex === null) {
        if (itemsRef.current.length > 0) {
          const firstItem = itemsRef.current[0];
          if (firstItem) {
            onNavigateRef.current(firstItem.id);
          }
          scrollIntoView(0, 'auto');
          return 0;
        }
        onNavigateRef.current(null);
        return null;
      }

      if (prevIndex < itemsRef.current.length - 1) {
        const newIndex = prevIndex;
        const nextItem = itemsRef.current[prevIndex + 1];
        if (nextItem) {
          onNavigateRef.current(nextItem.id);
        }
        scrollIntoView(newIndex, 'auto');
        return newIndex;
      } else {
        const newIndex = itemsRef.current.length > 1 ? prevIndex - 1 : null;

        if (newIndex !== null) {
          const nextItem = itemsRef.current[newIndex];
          if (nextItem) {
            onNavigateRef.current(nextItem.id);
          }
          scrollIntoView(newIndex, 'auto');
          return newIndex;
        } else {
          onNavigateRef.current(null);
          return null;
        }
      }
    });
  }, [onNavigateRef, scrollIntoView, setFocusedIndex, setKeyboardNavigationActive]);

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
    (direction: 'up' | 'down') => {
      setKeyboardNavigationActive(true);

      setFocusedIndex((prevIndex) => {
        let newIndex: number;
        if (prevIndex === null) {
          const hoveredIndex = getHoveredIndex();
          if (hoveredIndex !== -1) {
            newIndex = hoveredIndex;
          } else {
            newIndex = direction === 'up' ? itemsRef.current.length - 1 : 0;
          }
        } else {
          newIndex =
            direction === 'up'
              ? Math.max(0, prevIndex - 1)
              : Math.min(itemsRef.current.length - 1, prevIndex + 1);
        }

        if (newIndex === prevIndex && prevIndex !== null) return prevIndex;

        scrollIntoView(newIndex, 'smooth');
        navigateToThread(newIndex);
        return newIndex;
      });
    },
    [setFocusedIndex, getHoveredIndex, scrollIntoView, navigateToThread, setKeyboardNavigationActive],
  );

  const handleArrowUp = useCallback(() => {
    moveFocus('up');
  }, [moveFocus]);

  const handleArrowDown = useCallback(() => {
    moveFocus('down');
  }, [moveFocus]);

  const handleEnter = useCallback(() => {
    if (focusedIndex === null) return;

    const message = itemsRef.current[focusedIndex];
    if (message) onNavigateRef.current(message.id);
  }, [focusedIndex]);

  const handleEscape = useCallback(() => {
    setFocusedIndex(null);
    onNavigateRef.current(null);
    setKeyboardNavigationActive(false);
  }, [setFocusedIndex, onNavigateRef, setKeyboardNavigationActive]);

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

  const fastScroll = useCallback(
    (direction: 'up' | 'down') => {
      setKeyboardNavigationActive(true);

      setFocusedIndex((prev) => {
        const { length } = itemsRef.current;
        const newIndex =
          direction === 'up'
            ? prev === null
              ? length - 1
              : Math.max(0, prev - 1)
            : prev === null
              ? 0
              : Math.min(length - 1, prev + 1);

        if (newIndex !== prev || prev === null) {
          scrollIntoView(newIndex, 'auto');
        }
        return newIndex;
      });
    },
    [scrollIntoView, setFocusedIndex, setKeyboardNavigationActive],
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
          fastScroll('up');
        } else if (event.key === 'ArrowDown') {
          fastScroll('down');
        }
        isProcessingKey = false;
      });
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [fastScroll, isSearchBarFocused]);

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
