import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { AppSidebar } from '@/components/ui/app-sidebar';
import { LabIndexProvider } from '@/lib/lab/lab-index-context';
import { authProxy } from '@/lib/auth-proxy';
import { Loader2 } from 'lucide-react';
import { Outlet } from 'react-router';
import type { Route } from './+types/layout';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.redirect(new URL('/login', new URL(request.url).origin));
  }
  return null;
}

export function HydrateFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center" data-testid="lab-index-loading">
      <Loader2 className="h-10 w-10 animate-spin" />
    </div>
  );
}

export default function LabLayout() {
  return (
    <HotkeyProviderWrapper>
      <LabIndexProvider>
        <AppSidebar />
        <div className="bg-sidebar dark:bg-sidebar min-w-0 w-full">
          <Outlet />
        </div>
      </LabIndexProvider>
    </HotkeyProviderWrapper>
  );
}
