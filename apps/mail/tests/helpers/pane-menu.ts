import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';

/** Radix positions menus with ResizeObserver, which happy-dom does not provide. Call from beforeAll. */
export function stubResizeObserverForMenus() {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
}

/** Opens the pane's ⋯ menu from the keyboard, as staff do, and returns the open menu. */
export async function openPaneMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' });
  return screen.findByRole('menu');
}

/** Opens the ⋯ menu and runs the item with this exact name. */
export async function runPaneMenuItem(name: string) {
  await openPaneMenu();
  fireEvent.keyDown(await screen.findByRole('menuitem', { name }), { key: 'Enter' });
}
