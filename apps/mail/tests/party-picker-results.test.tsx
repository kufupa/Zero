/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { PartyPicker } from '../components/quote-workflow/party-picker';
import { PARTY_TRUNCATED_NOTE, type PartyFindReply } from '../lib/quote-workflow/party-lookup';

afterEach(() => {
  cleanup();
});

const ABC_TRAVEL = { kind: 'company' as const, nativeId: '4411', name: 'ABC Travel' };
const ABCD_TRAVEL = { kind: 'company' as const, nativeId: '4412', name: 'ABCD Travel' };

function listed(...results: Array<typeof ABC_TRAVEL>): PartyFindReply {
  return { outcome: 'ambiguous', results, truncated: false };
}

/** A reply the test settles by hand, so the order of replies is the test's choice. */
function deferred() {
  let settle!: (reply: PartyFindReply) => void;
  const promise = new Promise<PartyFindReply>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function picker(name: string, find: (query: string) => Promise<PartyFindReply>, onPick = vi.fn()): ReactElement {
  return <PartyPicker name={name} parties={{}} find={find} onPick={onPick} onClear={vi.fn()} />;
}

function findButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement;
}

describe('PartyPicker copy for a search HMS cut short', () => {
  it('shows the 50-match copy when a search has no rows to list but was cut short, not a no-match reason', async () => {
    const find = vi.fn(async (): Promise<PartyFindReply> => ({ outcome: 'no_match', results: [], truncated: true }));
    render(picker('Tour', find));
    fireEvent.click(findButton());
    await waitFor(() => expect(screen.getByText(PARTY_TRUNCATED_NOTE)).toBeTruthy());
    expect(screen.queryByText(/Not found in HMS/)).toBeNull();
  });
});

describe('PartyPicker results follow the name typed now', () => {
  it('clears listed results when the name changes, so a result for the old name cannot be picked', async () => {
    const find = vi.fn(async () => listed(ABC_TRAVEL));
    const onPick = vi.fn();
    const { rerender } = render(picker('ABC', find, onPick));
    fireEvent.click(findButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'ABC Travel' })).toBeTruthy());
    rerender(picker('ABCD', find, onPick));
    expect(screen.queryByRole('button', { name: 'ABC Travel' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Companies and agencies found in HMS' })).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a new search clears the old results while it runs, and lists the new ones when it returns', async () => {
    const second = deferred();
    const find = vi.fn().mockResolvedValueOnce(listed(ABC_TRAVEL)).mockReturnValueOnce(second.promise);
    render(picker('ABC', find));
    fireEvent.click(findButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'ABC Travel' })).toBeTruthy());
    fireEvent.click(findButton());
    expect(screen.queryByRole('button', { name: 'ABC Travel' })).toBeNull();
    await act(async () => {
      second.settle(listed(ABC_TRAVEL));
    });
    expect(screen.getByRole('button', { name: 'ABC Travel' })).toBeTruthy();
  });

  it('a reply that arrives after the name changed is ignored, and Find in HMS is usable again', async () => {
    const pending = deferred();
    const find = vi.fn(() => pending.promise);
    const { rerender } = render(picker('ABC', find));
    fireEvent.click(findButton());
    rerender(picker('XYZ', find));
    await act(async () => {
      pending.settle(listed(ABC_TRAVEL));
    });
    expect(screen.queryByRole('button', { name: 'ABC Travel' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(findButton().disabled).toBe(false);
  });

  it('an older search cannot overwrite a newer one for the name now typed', async () => {
    const older = deferred();
    const newer = deferred();
    const find = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { rerender } = render(picker('ABC', find));
    fireEvent.click(findButton());
    rerender(picker('ABCD', find));
    fireEvent.click(findButton());
    await act(async () => {
      newer.settle(listed(ABCD_TRAVEL));
    });
    await act(async () => {
      older.settle(listed(ABC_TRAVEL));
    });
    expect(screen.getByRole('button', { name: 'ABCD Travel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ABC Travel' })).toBeNull();
  });
});
