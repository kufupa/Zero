import { QueryProvider } from './query-provider';
import type { PropsWithChildren } from 'react';

export function ServerProviders({ children }: PropsWithChildren) {
  return <QueryProvider>{children}</QueryProvider>;
}
