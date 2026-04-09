import { ThreadDisplayHotkeys } from '@/lib/hotkeys/thread-display-hotkeys';
import { NavigationHotkeys } from '@/lib/hotkeys/navigation-hotkeys';
import { MailListHotkeys } from '@/lib/hotkeys/mail-list-hotkeys';
import { ComposeHotkeys } from '@/lib/hotkeys/compose-hotkeys';
import { GlobalHotkeys } from '@/lib/hotkeys/global-hotkeys';
import { HotkeysProvider } from 'react-hotkeys-hook';
import React from 'react';

interface HotkeyProviderWrapperProps {
  children: React.ReactNode;
  includeMailHotkeys?: boolean;
}

export function HotkeyProviderWrapper({
  children,
  includeMailHotkeys = true,
}: HotkeyProviderWrapperProps) {
  return (
    <HotkeysProvider initiallyActiveScopes={['global', 'navigation']}>
      <NavigationHotkeys />
      <GlobalHotkeys />
      {includeMailHotkeys ? (
        <>
          <MailListHotkeys />
          <ThreadDisplayHotkeys />
          <ComposeHotkeys />
        </>
      ) : null}
      {children}
    </HotkeysProvider>
  );
}
