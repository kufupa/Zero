const LOCAL_BACKEND_URL = 'http://localhost:8787';
const LOCAL_APP_URL = 'http://localhost:3000';

export function getBackendUrl(): string {
  const backendUrl = import.meta.env.VITE_PUBLIC_BACKEND_URL;
  if (backendUrl) return backendUrl;

  if (import.meta.env.DEV) {
    return LOCAL_BACKEND_URL;
  }

  throw new Error('Missing VITE_PUBLIC_BACKEND_URL');
}

export function getAppUrl(): string {
  const appUrl = import.meta.env.VITE_PUBLIC_APP_URL;
  if (appUrl) return appUrl;

  if (import.meta.env.DEV) {
    return LOCAL_APP_URL;
  }

  throw new Error('Missing VITE_PUBLIC_APP_URL');
}

export function isAutumnDisabled(): boolean {
  return import.meta.env.VITE_DISABLE_AUTUMN === '1';
}

export function isSentryDisabled(): boolean {
  return import.meta.env.VITE_DISABLE_SENTRY === '1';
}

export function isFrontendOnlyMode(): boolean {
  return import.meta.env.VITE_FRONTEND_ONLY === '1';
}

export function getAuthBaseUrl(): string {
  return isFrontendOnlyMode() ? getAppUrl() : getBackendUrl();
}
