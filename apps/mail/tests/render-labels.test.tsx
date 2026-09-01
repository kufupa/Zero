/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderLabels } from '../components/mail/render-labels';
import { useSearchValue } from '../hooks/use-search-value';
import {
  EMPTY_SEARCH_VALUE,
  unreadFilter,
  type SearchValueState,
} from '../lib/mail/search-list';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

const vipLabel = {
  id: 'label-vip',
  name: 'VIP',
  type: 'user',
};

function SearchValueInitializer({ state }: { state: SearchValueState }) {
  const [, setSearchValue] = useSearchValue();

  useEffect(() => {
    setSearchValue(state);
  }, [setSearchValue, state]);

  return null;
}

function SearchValueProbe() {
  const [state] = useSearchValue();
  return <output data-testid="search-value">{JSON.stringify(state)}</output>;
}

function renderLabels(initialSearchValue: SearchValueState) {
  return render(
    <Provider store={createStore()}>
      <SearchValueInitializer state={initialSearchValue} />
      <RenderLabels labels={[vipLabel]} />
      <SearchValueProbe />
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RenderLabels search integration', () => {
  it('leaves search state unchanged when label click exceeds effective-query limit', () => {
    const initialSearchValue = {
      ...EMPTY_SEARCH_VALUE,
      value: 'x'.repeat(512),
      highlight: 'x'.repeat(512),
    };
    renderLabels(initialSearchValue);

    fireEvent.click(screen.getByRole('button', { name: 'VIP' }));

    expect(screen.getByTestId('search-value').textContent).toBe(
      JSON.stringify(initialSearchValue),
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Search query must be 512 characters or fewer.',
    );
  });

  it('resets scope and header chips when a fitting label query is applied', () => {
    renderLabels({
      ...EMPTY_SEARCH_VALUE,
      value: 'invoice',
      highlight: 'invoice',
      scope: 'all',
      filters: [unreadFilter()],
    });

    fireEvent.click(screen.getByRole('button', { name: 'VIP' }));

    expect(JSON.parse(screen.getByTestId('search-value').textContent ?? '{}')).toEqual({
      ...EMPTY_SEARCH_VALUE,
      value: 'invoice label:VIP',
    });
  });
});
