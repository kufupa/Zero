import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

const CommandPaletteProvider = lazy(() =>
  import('@/components/context/command-palette-context').then((module) => ({
    default: module.CommandPaletteProvider,
  })),
);

export function LazyCommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        setIsLoaded(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!isLoaded) {
    return <>{children}</>;
  }

  return (
    <Suspense fallback={<>{children}</>}>
      <CommandPaletteProvider>{children}</CommandPaletteProvider>
    </Suspense>
  );
}
