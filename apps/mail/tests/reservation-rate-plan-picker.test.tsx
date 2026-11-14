/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativePicker } from '../components/reservation-pane/shared/native-pickers';
import { nativeChoices } from '../lib/reservation-workflow/views';
import { afterEach, describe, expect, it, vi } from 'vitest';

const path = '/proposal/content/requests/quote-1/body/groups/0/ratePlan';

function snapshot(observations: Record<string, unknown>[], propertyCode = 'HRCEN') {
  const request = {
    id: 'quote-1',
    kind: 'quote',
    text: 'Quote one room',
    body: { groups: [{ ratePlan: '' }] },
  };
  return {
    session: {
      draft: {
        generationId: 'generation-1',
        propertyCode,
        source: { messageId: 'message-1', sourceHash: 'source-hash-1' },
        proposal: { content: { requests: [request] }, annotations: [], sourceClaims: [] },
        observations,
        fieldOverrides: {},
        fieldReviewRequirements: {},
        staffReviews: {},
        operationResults: [],
      },
      preparationViews: [],
      revision: 1,
      revisionHead: 1,
      seq: 1,
    },
    sourceMessageId: 'message-1',
    requests: [
      {
        id: request.id,
        kind: request.kind,
        text: request.text,
        fieldPaths: [path],
        supported: true,
      },
    ],
    fields: {},
    issues: [],
    operationResults: [],
    preparationViews: [],
    preparation: { state: 'idle', message: '' },
  } as any;
}

function rateOptionsObservation() {
  return {
    ref: 'rate-options-1',
    generationId: 'generation-1',
    propertyCode: 'HRCEN',
    sourceMessageId: 'message-1',
    kind: 'rate_availability',
    status: 'complete',
    observedAt: '2026-11-14T00:00:00.000Z',
    sourceRefs: [],
    criteria: { requestId: 'quote-1' },
    coverage: { complete: true, notes: [] },
    result: { rateOptions: [{ rateCode: 'BAR', rateName: 'Priced BAR offer' }] },
  };
}

describe('reservation Rate Plan picker', () => {
  afterEach(cleanup);

  it('merges static rate codes behind priced offers and lets the offer win duplicate codes', () => {
    const choices = nativeChoices(snapshot([rateOptionsObservation()]), path, 'rate_plan');

    expect(choices.find((choice) => choice.value === 'BAR')).toMatchObject({
      ref: 'rate-options-1',
      label: 'Priced BAR offer',
    });
    expect(choices.length).toBeGreaterThan(1);
    expect(choices.some((choice) => choice.ref.startsWith('catalogue:'))).toBe(true);
  });

  it('loads Infor choices when only priced offer UUID choices exist', async () => {
    const lookupChoices = vi.fn().mockResolvedValue(undefined);
    const value = {
      snapshot: snapshot([{ ...rateOptionsObservation(), propertyCode: 'HRDAV' }], 'HRDAV'),
      request: { id: 'quote-1', kind: 'quote' },
      view: { busy: false, error: null, preview: false, saving: false },
      commands: {
        lookupChoices,
        lookup: vi.fn(),
        edit: vi.fn().mockResolvedValue(undefined),
        stageEdit: vi.fn(),
        setUncommitted: vi.fn(),
      },
    } as any;

    render(<NativePicker label="Rate Plan" path={path} editor={value} kind="rate_plan" />);
    fireEvent.focus(screen.getByLabelText('Rate Plan'));

    await waitFor(() => expect(lookupChoices).toHaveBeenCalledWith(path));
  });

  it('sets the known board when staff selects a catalogued rate plan', async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const value = {
      snapshot: snapshot([]),
      request: { id: 'quote-1', kind: 'quote' },
      view: { busy: false, error: null, preview: false, saving: false },
      commands: {
        lookupChoices: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn(),
        edit,
        stageEdit: vi.fn(),
        setUncommitted: vi.fn(),
      },
    } as any;

    render(<NativePicker label="Rate Plan" path={path} editor={value} kind="rate_plan" />);
    fireEvent.focus(screen.getByLabelText('Rate Plan'));
    fireEvent.click(screen.getByRole('option', { name: /BARRO/ }));

    await waitFor(() => expect(edit).toHaveBeenCalledWith(path, 'BARRO'));
    expect(edit).toHaveBeenCalledWith(
      '/proposal/content/requests/quote-1/body/groups/0/mealPlan',
      'room_only',
    );
  });
});
