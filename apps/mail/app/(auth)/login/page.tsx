import { LoginClient } from './login-client';
import { isDemoMode } from '@/lib/demo-session';
import { redirect, useLoaderData } from 'react-router';

export async function clientLoader() {
  if (isDemoMode()) return redirect('/mail/inbox');

  const isProd = !import.meta.env.DEV;

  const response = await fetch(import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/public/providers');
  const data = (await response.json()) as { allProviders?: any[] };

  return {
    allProviders: data.allProviders ?? [],
    isProd,
  };
}

export default function LoginPage() {
  const { allProviders, isProd } = useLoaderData<typeof clientLoader>();

  return (
    <div className="flex min-h-screen w-full flex-col bg-white dark:bg-black">
      <LoginClient providers={allProviders} isProd={isProd} />
    </div>
  );
}
