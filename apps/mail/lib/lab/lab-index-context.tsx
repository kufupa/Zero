import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  loadCenturionLabIndex,
  type LabIndexLoadResult,
} from '@/lib/lab/load-centurion-index';

export type LabIndexContextValue = LabIndexLoadResult | { source: 'loading' };

const LabIndexContext = createContext<LabIndexContextValue | null>(null);

export function LabIndexProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<LabIndexContextValue>({ source: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void loadCenturionLabIndex(new Request(window.location.href)).then((result) => {
      if (!cancelled) setValue(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <LabIndexContext.Provider value={value}>{children}</LabIndexContext.Provider>;
}

export function useLabIndexLoad(): LabIndexContextValue | null {
  return useContext(LabIndexContext);
}
