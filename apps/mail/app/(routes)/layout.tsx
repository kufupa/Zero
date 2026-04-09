import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { LazyCommandPaletteProvider } from '@/components/context/lazy-command-palette-provider';

import { Outlet } from 'react-router';


export default function Layout() {
  return (
    <LazyCommandPaletteProvider>
      <HotkeyProviderWrapper>
        <div className="relative flex max-h-screen w-full overflow-hidden">
          <Outlet />
        </div>
      </HotkeyProviderWrapper>
    </LazyCommandPaletteProvider>
  );
}
