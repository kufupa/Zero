import { LoginClient } from './login-client';
import { useLoaderData } from 'react-router';
import { getAuthApi } from '@/lib/auth/factory';

export async function clientLoader() {
  const isProd = !import.meta.env.DEV;
  const auth = getAuthApi();
  const { providers, loadError, isProd: prodFromAuth } = await auth.getLoginProviders({ isProd });
  return {
    allProviders: providers,
    isProd: prodFromAuth,
    loadError,
  };
}

export default function LoginPage() {
  const { allProviders, isProd, loadError } = useLoaderData<typeof clientLoader>();

  return (
    <div className="flex min-h-screen w-full flex-col bg-white dark:bg-black">
      <LoginClient providers={allProviders} isProd={isProd} loadError={loadError} />
    </div>
  );
}
