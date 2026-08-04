import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { MailFileDragProvider } from '@/components/mail/mail-file-drag-provider';
import { OnboardingWrapper } from '@/components/onboarding';
import { AppSidebar } from '@/components/ui/app-sidebar';
import { authProxy } from '@/lib/auth-proxy';
import { Outlet } from 'react-router';
import type { Route } from './+types/layout';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/login`);
  }
  return null;
}

export default function MailLayout() {
  return (
    <HotkeyProviderWrapper>
      <MailFileDragProvider>
        <AppSidebar />
        <div className="bg-sidebar dark:bg-sidebar min-w-0 w-full">
          <Outlet />
        </div>
        <OnboardingWrapper />
      </MailFileDragProvider>
    </HotkeyProviderWrapper>
  );
}
