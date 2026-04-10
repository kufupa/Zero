import * as Sentry from '@sentry/react';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

const sentryDisabled =
  import.meta.env.VITE_DISABLE_SENTRY === '1' ||
  isFrontendOnlyDemo({
    VITE_ZERO_DEMO_MODE: import.meta.env.VITE_ZERO_DEMO_MODE,
    VITE_FRONTEND_ONLY: import.meta.env.VITE_FRONTEND_ONLY,
  });

if (!sentryDisabled) {
  Sentry.init({
    dsn: 'https://03f6397c0eb458bf1e37c4776a31797c@o4509328786915328.ingest.us.sentry.io/4509328795303936',
    tunnel: import.meta.env.VITE_PUBLIC_BACKEND_URL + '/monitoring/sentry',
    integrations: [Sentry.replayIntegration()],
    tracesSampleRate: 1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    debug: false,
  });
}
