import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { AppSidebar } from '@/components/ui/app-sidebar';
import { lazy, Suspense } from 'react';
import { Outlet } from 'react-router';

const OnboardingWrapper = lazy(() =>
  import('@/components/onboarding').then((module) => ({ default: module.OnboardingWrapper })),
);

export default function MailLayout() {
  return (
    <HotkeyProviderWrapper>
      <AppSidebar />
      <div className="bg-sidebar dark:bg-sidebar w-full">
        <Outlet />
      </div>
      <Suspense fallback={null}>
        <OnboardingWrapper />
      </Suspense>
    </HotkeyProviderWrapper>
  );
}
