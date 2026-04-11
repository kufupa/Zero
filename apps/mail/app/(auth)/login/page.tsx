import { LoginClient } from './login-client';
import { useLoaderData } from 'react-router';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

export async function clientLoader() {
  const isProd = !import.meta.env.DEV;
  if (isFrontendOnlyDemo()) {
    return {
      allProviders: [
        {
          id: 'zero',
          name: 'Continue to Demo',
          enabled: true,
          required: false,
          envVarStatus: [],
          isCustom: true,
          customRedirectPath: '/mail/inbox',
        },
      ],
      isProd,
    };
  }

  const fallbackProvider = [
    {
      id: 'zero',
      name: 'Continue to Demo',
      enabled: true,
      required: false,
      envVarStatus: [],
      isCustom: true,
      customRedirectPath: '/mail/inbox',
    },
  ];

  try {
    const response = await fetch(import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/public/providers');

    if (!response.ok) {
      return {
        allProviders: fallbackProvider,
        isProd,
      };
    }

    const data = (await response.json()) as { allProviders?: any[] };
    return {
      allProviders: data.allProviders ?? fallbackProvider,
      isProd,
    };
  } catch (error) {
    console.warn('Falling back to demo provider due missing backend:', error);

    return {
      allProviders: fallbackProvider,
      isProd,
    };
  }
}

export default function LoginPage() {
  const { allProviders, isProd } = useLoaderData<typeof clientLoader>();

  return (
    <div className="flex min-h-screen w-full flex-col bg-white dark:bg-black">
      <LoginClient providers={allProviders} isProd={isProd} />
    </div>
  );
}
