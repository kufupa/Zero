import { startTransition, StrictMode } from 'react';
import { HydratedRouter } from 'react-router/dom';
import { hydrateRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    {
      onUncaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
        console.warn('Uncaught error', error, errorInfo.componentStack);
      }),
      // Callback called when React catches an error in an ErrorBoundary.
      onCaughtError: Sentry.reactErrorHandler(),
      // Callback called when React automatically recovers from errors.
      onRecoverableError: Sentry.reactErrorHandler(),
    },
  );
});

const initializeInstrumentation = () => {
  void import('./instrument');
};

if (typeof window !== 'undefined') {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(initializeInstrumentation, { timeout: 5000 });
  } else {
    window.setTimeout(initializeInstrumentation, 200);
  }
}
