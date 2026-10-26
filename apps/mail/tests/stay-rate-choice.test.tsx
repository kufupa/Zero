/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OTHER_RATE_VALUE,
  StayRateChoice,
  type StayRateChoiceValue,
  type StayRateOption,
} from '../components/quote-workflow/stay-rate-choice';

afterEach(cleanup);

const RATES: StayRateOption[] = [
  { rateCode: 'BAR', rateLabel: 'Best available' },
  { rateCode: 'CORP1', rateLabel: 'Corporate 1' },
];

function Harness({
  rates = RATES,
  initial,
}: {
  rates?: readonly StayRateOption[];
  initial?: StayRateChoiceValue;
}) {
  const [value, setValue] = useState<StayRateChoiceValue>(
    initial ?? { rateCode: '', source: 'listed', authorisedBy: '' },
  );
  return (
    <>
      <StayRateChoice rates={rates} value={value} onChange={setValue} />
      <pre data-testid="choice">{JSON.stringify(value)}</pre>
    </>
  );
}

function rateSelect(): HTMLSelectElement {
  const element = screen.getByLabelText('Rate code');
  if (!(element instanceof HTMLSelectElement)) throw new Error('Rate code is not a select');
  return element;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.querySelectorAll('option')].map((option) => option.textContent ?? '');
}

describe('StayRateChoice', () => {
  it('selecting Other then pencil-editing retains the custom code and authorization', () => {
    render(<Harness />);

    const select = rateSelect();
    expect(optionLabels(select).at(-1)).toBe('Other rate…');
    expect(optionLabels(select).slice(0, -1)).not.toContain('Other rate…');
    expect(screen.queryByLabelText('Showing rates for')).toBeNull();

    fireEvent.change(select, { target: { value: OTHER_RATE_VALUE } });
    const code = screen.getByLabelText('Other rate code');
    fireEvent.change(code, { target: { value: 'xyz99' } });
    fireEvent.blur(code);
    fireEvent.change(screen.getByLabelText('Authorised by'), { target: { value: 'Duty manager' } });

    expect(rateSelect().value).toBe('XYZ99');
    expect(optionLabels(rateSelect()).at(-1)).toBe('Other rate…');
    expect(optionLabels(rateSelect())).toContain('XYZ99');
    expect(screen.getByTestId('choice').textContent).toBe(
      JSON.stringify({ rateCode: 'XYZ99', source: 'other', authorisedBy: 'Duty manager' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit rate code' }));
    const edit = screen.getByLabelText('Other rate code');
    expect((edit as HTMLInputElement).value).toBe('XYZ99');
    expect((screen.getByLabelText('Authorised by') as HTMLInputElement).value).toBe('Duty manager');
    expect(rateSelect().value).toBe('XYZ99');

    fireEvent.change(edit, { target: { value: 'abc1' } });
    fireEvent.blur(edit);

    expect(rateSelect().value).toBe('ABC1');
    expect(optionLabels(rateSelect())).toContain('ABC1');
    expect(optionLabels(rateSelect())).not.toContain('XYZ99');
    expect(optionLabels(rateSelect()).at(-1)).toBe('Other rate…');
    expect((screen.getByLabelText('Authorised by') as HTMLInputElement).value).toBe('Duty manager');
    expect(screen.getByTestId('choice').textContent).toBe(
      JSON.stringify({ rateCode: 'ABC1', source: 'other', authorisedBy: 'Duty manager' }),
    );
  });
});
