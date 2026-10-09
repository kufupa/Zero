/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaneMenu } from '../components/nava-pane/pane-menu';

beforeAll(() => {
  // Radix positions the menu with ResizeObserver, which happy-dom does not provide.
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const onCheckConnection = vi.fn();
  const onReplayTour = vi.fn();
  render(
    <PaneMenu
      buildRelease="abcdef1234"
      onCheckConnection={onCheckConnection}
      onRunSystemCheck={vi.fn()}
      onReplayTour={onReplayTour}
    />,
  );
  return { trigger: screen.getByRole('button', { name: 'More' }), onCheckConnection, onReplayTour };
}

describe('PaneMenu keyboard', () => {
  it('opens with focus on the first item, moves with the arrows, and Escape returns focus to ⋯', async () => {
    const { trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const first = await screen.findByRole('menuitem', { name: 'Check connection' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByRole('menuitem', { name: 'Replay tour' });
    await waitFor(() => expect(document.activeElement).toBe(second));

    fireEvent.keyDown(second, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('Enter on an item runs it and closes the menu', async () => {
    const { trigger, onReplayTour, onCheckConnection } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const replay = await screen.findByRole('menuitem', { name: 'Replay tour' });
    fireEvent.keyDown(replay, { key: 'Enter' });
    expect(onReplayTour).toHaveBeenCalledTimes(1);
    expect(onCheckConnection).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('shows About with the build id inside the menu', async () => {
    const { trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByRole('menu');
    expect(screen.getByText(/About Nava Reservationist · Build abcdef1/)).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Feedback by email' }).getAttribute('href')).toBe(
      'mailto:aroransh17@gmail.com',
    );
  });
});

describe('PaneMenu on the webmail preview', () => {
  it('leaves out the connection check and tour replay, which only the Outlook pane can run', async () => {
    render(
      <PaneMenu
        buildRelease={null}
        onCheckConnection={vi.fn()}
        onRunSystemCheck={vi.fn()}
        onReplayTour={vi.fn()}
        preview
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Run system check' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Check connection' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Replay tour' })).toBeNull();
  });
});
