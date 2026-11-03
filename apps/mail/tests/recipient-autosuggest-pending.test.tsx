/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipientAutosuggest } from '../components/ui/recipient-autosuggest';

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({ mail: { suggestRecipients: { queryOptions: () => ({}) } } }),
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: (fn: (value: string) => void) => fn }));

function Harness({ initial = [], events }: { initial?: string[]; events: string[] }) {
  const { control } = useForm({ defaultValues: { to: initial } });
  return <RecipientAutosuggest control={control} name="to"
    onValueChange={() => events.push('committed')} onPendingClear={() => events.push('cleared')} />;
}

afterEach(cleanup);

describe('recipient pending input', () => {
  it('notifies when unfinished text is cleared', () => {
    const events: string[] = [];
    render(<Harness events={events} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'unfinished@' } });
    expect(events).toEqual([]);
    fireEvent.change(input, { target: { value: '' } });
    expect(events).toEqual(['cleared']);
  });

  it('reports the committed recipient before reporting cleared input', () => {
    const events: string[] = [];
    render(<Harness events={events} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'guest@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(events).toEqual(['committed', 'cleared']);
  });

  it('reports pending input cleared when paste resolves to an existing recipient', () => {
    const events: string[] = [];
    render(<Harness initial={['guest@example.com']} events={events} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'guest@' } });
    fireEvent.paste(input, { clipboardData: { getData: () => 'example.com' } });
    expect(events).toEqual(['cleared']);
  });
});
