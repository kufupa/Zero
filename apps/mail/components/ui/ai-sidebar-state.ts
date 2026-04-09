import { useCallback, useEffect, useState } from 'react';
import { useQueryState } from 'nuqs';

type ViewMode = 'sidebar' | 'popup' | 'fullscreen';

export function useAIFullScreen() {
  const [isFullScreenQuery, setIsFullScreenQuery] = useQueryState('isFullScreen');

  const [isFullScreen, setIsFullScreenState] = useState<boolean>(() => {
    if (isFullScreenQuery) {
      return isFullScreenQuery === 'true';
    }
    if (typeof window !== 'undefined') {
      const savedFullScreen = localStorage.getItem('ai-fullscreen');
      if (savedFullScreen) return savedFullScreen === 'true';
    }
    return false;
  });

  const setIsFullScreen = useCallback(
    (value: boolean) => {
      setIsFullScreenState(value);
      if (!value) {
        if (typeof window !== 'undefined') {
          localStorage.removeItem('ai-fullscreen');
        }
        setTimeout(() => {
          setIsFullScreenQuery(null).catch(console.error);
        }, 0);
      } else {
        setIsFullScreenQuery('true').catch(console.error);
        if (typeof window !== 'undefined') {
          localStorage.setItem('ai-fullscreen', 'true');
        }
      }
    },
    [setIsFullScreenQuery],
  );

  useEffect(() => {
    const queryValue = isFullScreenQuery === 'true';
    if (isFullScreenQuery !== null && queryValue !== isFullScreen) {
      setIsFullScreenState(queryValue);
    }
  }, [isFullScreenQuery, isFullScreen]);

  useEffect(() => {
    if (typeof window !== 'undefined' && !isFullScreenQuery) {
      const savedFullScreen = localStorage.getItem('ai-fullscreen');
      if (savedFullScreen === 'true') {
        setIsFullScreenQuery('true');
      }
    }

    if (isFullScreenQuery === null && isFullScreen) {
      setIsFullScreenState(false);
    }
  }, [isFullScreenQuery, setIsFullScreenQuery, isFullScreen]);

  return {
    isFullScreen,
    setIsFullScreen,
  };
}

export function useAISidebarState() {
  const [open, setOpenQuery] = useQueryState('aiSidebar');
  const [viewModeQuery, setViewModeQuery] = useQueryState('viewMode');
  const { isFullScreen, setIsFullScreen } = useAIFullScreen();

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    if (viewModeQuery) return viewModeQuery as ViewMode;

    if (typeof window !== 'undefined') {
      const savedViewMode = localStorage.getItem('ai-viewmode');
      if (savedViewMode && (savedViewMode === 'sidebar' || savedViewMode === 'popup')) {
        return savedViewMode as ViewMode;
      }
    }

    return 'popup';
  });

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setViewModeState(mode);
      setViewModeQuery(mode === 'popup' ? null : mode);
      if (typeof window !== 'undefined') localStorage.setItem('ai-viewmode', mode);
    },
    [setViewModeQuery],
  );

  const setOpen = useCallback(
    (openState: boolean) => {
      if (!openState) {
        if (typeof window !== 'undefined') localStorage.removeItem('ai-sidebar-open');
        setTimeout(() => {
          setOpenQuery(null).catch(console.error);
        }, 0);
      } else {
        setOpenQuery('true').catch(console.error);
        if (typeof window !== 'undefined') localStorage.setItem('ai-sidebar-open', 'true');
      }
    },
    [setOpenQuery],
  );

  const toggleOpen = useCallback(() => setOpen(open !== 'true'), [open, setOpen]);

  useEffect(() => {
    if (viewModeQuery && viewModeQuery !== viewMode) {
      setViewModeState(viewModeQuery as ViewMode);
    }
  }, [viewModeQuery, viewMode]);

  return {
    open: !!open,
    viewMode,
    setViewMode,
    setOpen,
    toggleOpen,
    toggleViewMode: () => setViewMode(viewMode === 'popup' ? 'sidebar' : 'popup'),
    isFullScreen,
    setIsFullScreen,
    isSidebar: viewMode === 'sidebar',
    isPopup: viewMode === 'popup',
  };
}

