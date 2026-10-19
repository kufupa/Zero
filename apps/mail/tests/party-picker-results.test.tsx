/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  PARTY_PICKER_HINT,
  PARTY_SEARCH_DEADLINE_MS,
  PartyPicker,
} from '../components/quote-workflow/party-picker';
import type { HmsJobTransport, HmsJobView } from '../lib/quote-workflow/amend-find';
import {
  PARTY_TRUNCATED_NOTE,
  partyNoCandidateNote,
  type PartyCandidate,
  type PartyFindReply,
} from '../lib/quote-workflow/party-lookup';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ABC_TRAVEL = { kind: 'company' as const, nativeId: '4411', name: 'ABC Travel' };
const ABCD_TRAVEL = { kind: 'company' as const, nativeId: '4412', name: 'ABCD Travel' };
const ABC_TRAVEL_AGENCY = { kind: 'agency' as const, nativeId: '7711', name: 'ABC Travel Agency' };

function prefetchedPartyView(): HmsJobView {
  return {
    runId: 'party-run-1',
    sourceMessageId: 'message-1',
    request: { kind: 'party', name: 'ABC Travel' },
    prefetch: true,
    status: 'done',
    position: null,
    attempts: 1,
    failureClass: null,
    asOf: '2026-10-12T12:00:00.000Z',
    createdAt: '2026-10-12T11:59:00.000Z',
    result: {
      kind: 'party',
      outcome: 'ambiguous',
      results: [ABC_TRAVEL, ABCD_TRAVEL, ABC_TRAVEL_AGENCY],
      best: ABC_TRAVEL,
      truncated: false,
      searchedFor: 'ABC Travel',
    },
  };
}

function v2PartyView(matchStatus: 'bound' | 'needs_pick', requestName = 'ABC Travel'): HmsJobView {
  const boundParty = matchStatus === 'bound' ? ABC_TRAVEL : null;
  return {
    runId: `party-v2-${matchStatus}`,
    sourceMessageId: 'message-1',
    request: { kind: 'party', name: requestName, matchVersion: 2 },
    prefetch: true,
    status: 'done',
    position: null,
    attempts: 1,
    failureClass: null,
    asOf: '2026-10-13T12:00:00.000Z',
    createdAt: '2026-10-13T11:59:00.000Z',
    result: {
      kind: 'party',
      outcome: matchStatus === 'bound' ? 'resolved' : 'ambiguous',
      results: [ABC_TRAVEL, ABCD_TRAVEL, ABC_TRAVEL_AGENCY],
      best: boundParty,
      truncated: false,
      searchedFor: 'ABC Travel',
      matchVersion: 2,
      matchStatus,
      boundParty,
      suggestions: [ABC_TRAVEL, ABCD_TRAVEL, ABC_TRAVEL_AGENCY],
      reason: matchStatus === 'bound' ? 'Unique exact name.' : 'Two rows have an equal claim.',
      searchesTried: [{ term: 'ABC Travel', candidateName: 'ABC Travel', kind: 'company', outcome: 'ambiguous', returned: 3 }],
    },
  };
}

function manualPartyView(sourceMessageId?: string): HmsJobView {
  const view: HmsJobView = {
    ...prefetchedPartyView(),
    request: { kind: 'party', name: 'ABC Travel', partyKind: 'company' },
    prefetch: false,
  };
  delete view.sourceMessageId;
  if (sourceMessageId) view.sourceMessageId = sourceMessageId;
  return view;
}


function listed(...results: PartyCandidate[]): PartyFindReply {
  return { outcome: 'ambiguous', results, truncated: false };
}

function tourvestCopies(): PartyCandidate[] {
  return Array.from({ length: 13 }, (_, index): PartyCandidate => ({
    kind: 'agency',
    nativeId: String(280 + index),
    name: 'Tourvest Travel Services',
    iata: String(77206673 + index),
    city: index === 0 ? 'Pretoria' : 'Cape Town',
  }));
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

describe('PartyPicker outcome copy', () => {
  it.each([
    [
      'no_match',
      'company',
      'Acme Travel',
      'No company in HMS matches “Acme Travel”. Check the spelling or search a shorter name.',
    ],
    [
      'refused_lock_busy',
      'agency',
      'Travel Hub',
      'HMS is busy with another lookup. Nava will retry.',
    ],
    [
      'external_system_unavailable',
      'agency',
      'Travel Hub',
      "Nava couldn't check HMS for this name. Try again, or quote at public rates.",
    ],
    ['execution_failure', 'company', 'Acme Travel', "Couldn't reach HMS. Try again in a minute."],
    ['refused_flag_off', 'company', 'Acme Travel', 'Company and agency rates are switched off.'],
    ['refused_input_invalid', 'agency', '', 'Type a company or agency name.'],
    [
      'refused_origin_mismatch',
      'agency',
      'Acme',
      'This email is Da Vinci mail. Centurion HMS will not look it up.',
    ],
  ] as const)('names %s as an actionable state', (outcome, kind, name, expected) => {
    expect(partyNoCandidateNote(outcome, kind, name)).toBe(expected);
  });

  it('tells staff the lookup runs in the background', () => {
    expect(PARTY_PICKER_HINT).toBe('Runs in the background. You can keep working.');
  });
});

describe('PartyPicker prefetched party jobs', () => {
  it('offers the best prefetched row for one-click confirmation without auto-binding', async () => {
    const onPick = vi.fn();
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => prefetchedPartyView()),
    };

    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-1"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );

    const confirm = await screen.findByRole('button', { name: 'Confirm ABC Travel' });
    expect(jobTransport.status).toHaveBeenCalledWith({
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onPick).toHaveBeenCalledWith(ABC_TRAVEL);
  });

  it('shares a kind-less prefetched job without offering another kind’s best row', async () => {
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => prefetchedPartyView()),
    };
    const onCompanyPick = vi.fn();
    const onAgencyPick = vi.fn();
    render(
      <>
        <PartyPicker
          name="ABC Travel"
          kind="company"
          parties={{}}
          find={vi.fn()}
          jobTransport={jobTransport}
          threadId="thread-1"
          onPick={onCompanyPick}
          onClear={vi.fn()}
        />
        <PartyPicker
          name="ABC Travel"
          kind="agency"
          parties={{}}
          find={vi.fn()}
          jobTransport={jobTransport}
          threadId="thread-1"
          onPick={onAgencyPick}
          onClear={vi.fn()}
        />
      </>,
    );

    const company = screen.getByRole('group', { name: 'Company lookup in HMS' });
    const agency = screen.getByRole('group', { name: 'Agency lookup in HMS' });
    expect(await within(company).findByRole('button', { name: 'Confirm ABC Travel' })).toBeTruthy();
    expect(within(agency).queryByRole('button', { name: 'Confirm ABC Travel' })).toBeNull();
    expect(
      within(agency).getByRole('list', { name: 'Companies and agencies found in HMS' }).textContent,
    ).toContain('ABC Travel Agency');
    expect(within(company).queryByText('ABC Travel Agency')).toBeNull();
    expect(jobTransport.status).toHaveBeenCalledWith({
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    });
    expect(jobTransport.status).toHaveBeenCalledWith({
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'agency',
    });
    expect(onCompanyPick).not.toHaveBeenCalled();
    expect(onAgencyPick).not.toHaveBeenCalled();
  });

  it('reads a prefetched suggestion by thread and kind when the party name is blank', async () => {
    const onPick = vi.fn();
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => prefetchedPartyView()),
    };

    render(
      <PartyPicker
        name=""
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Confirm ABC Travel' })).toBeTruthy();
    expect(jobTransport.status).toHaveBeenCalledWith({ kind: 'party', partyKind: 'company' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('names the prefetched party in a no-match note when the field name is blank', async () => {
    const noMatch: HmsJobView = {
      ...prefetchedPartyView(),
      result: {
        kind: 'party',
        outcome: 'no_match',
        results: [],
        best: null,
        truncated: false,
        searchedFor: 'ABC Travel',
      },
    };
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => noMatch),
    };

    render(
      <PartyPicker
        name=""
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        'No company in HMS matches “ABC Travel”. Check the spelling or search a shorter name.',
      ),
    ).toBeTruthy();
  });

  it('rejects malformed persisted party rows instead of rendering or offering them', async () => {
    const malformed: HmsJobView = {
      ...prefetchedPartyView(),
      result: {
        kind: 'party',
        outcome: 'ambiguous',
        results: [{ kind: 'company', nativeId: 4411, name: null }],
        best: null,
        truncated: false,
      },
    };
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => malformed),
    };

    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Couldn't reach HMS. Try again in a minute."),
    ).toBeTruthy();
    expect(
      screen.queryByRole('list', { name: 'Companies and agencies found in HMS' }),
    ).toBeNull();
  });

  it('rejects a persisted best row that is absent from the result rows', async () => {
    const malformed: HmsJobView = {
      ...prefetchedPartyView(),
      result: {
        kind: 'party',
        outcome: 'ambiguous',
        results: [ABC_TRAVEL],
        best: ABCD_TRAVEL,
        truncated: false,
      },
    };
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => malformed),
    };

    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Couldn't reach HMS. Try again in a minute."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm ABCD Travel' })).toBeNull();
  });

  it('auto-binds a V2 high-precision job result and does not ask for confirmation', async () => {
    const onPick = vi.fn();
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => v2PartyView('bound')),
    };
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-1"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(ABC_TRAVEL));
    expect(screen.queryByRole('button', { name: 'Confirm ABC Travel' })).toBeNull();
  });

  it('ignores a V2 bound result created for a different message in the same thread', async () => {
    const onPick = vi.fn();
    let settleStatus!: (view: HmsJobView) => void;
    const statusReply = new Promise<HmsJobView>((resolve) => {
      settleStatus = resolve;
    });
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(() => statusReply),
    };
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-1"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );

    await waitFor(() => expect(jobTransport.status).toHaveBeenCalled());
    await act(async () => {
      settleStatus({ ...v2PartyView('bound'), sourceMessageId: 'message-2' });
      await statusReply;
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm ABC Travel' })).toBeNull();
    expect(screen.queryByText('Pick the company/agency')).toBeNull();
  });

  it('renders an ordinary prefetched result when the request marker says V2 but the result does not', async () => {
    const onPick = vi.fn();
    const ordinaryResult = {
      ...prefetchedPartyView(),
      request: { kind: 'party' as const, name: 'ABC Travel', matchVersion: 2 as const },
    };
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => ordinaryResult),
    };
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-1"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Confirm ABC Travel' })).toBeTruthy();
    expect(screen.queryByText('Pick the company/agency')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows stored V2 suggestions with Pick the company/agency when it cannot bind', async () => {
    const onPick = vi.fn();
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => v2PartyView('needs_pick')),
    };
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    expect(await screen.findByText('Pick the company/agency')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ABCD Travel (#4412)' }));
    expect(onPick).toHaveBeenCalledWith(ABCD_TRAVEL);
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
  });

  it('reads a V2 prefetch by thread and kind even when its primary search name differs from this field', async () => {
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      jobQueueEnabled: vi.fn(async () => true),
      status: vi.fn(async () => v2PartyView('needs_pick', 'Amicis Health (Pty) Ltd')),
    };
    render(
      <PartyPicker
        autoLookup
        name="Voerkraal Restaurant"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await screen.findByText('Pick the company/agency');
    await waitFor(() =>
      expect(jobTransport.status).toHaveBeenCalledWith({ kind: 'party', partyKind: 'company' }),
    );
  });
});

describe('PartyPicker queued party jobs', () => {
  it('queues Find in HMS, polls the saved party result, and waits for a staff pick', async () => {
    const onPick = vi.fn();
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(async () => ({ runId: 'party-run-2' })),
      status: vi.fn(async (input) =>
        'runId' in input
          ? {
              ...prefetchedPartyView(),
              request: { kind: 'party' as const, name: 'ABC Travel', partyKind: 'company' as const },
              runId: input.runId,
              prefetch: false,
            }
          : null,
      ),
    };
    const find = vi.fn();

    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={find}
        jobTransport={jobTransport}
        threadId="thread-1"
        autoLookup={false}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );

    await waitFor(() => expect(findButton().disabled).toBe(false));
    fireEvent.click(findButton());
    expect(jobTransport.queue).toHaveBeenCalledWith({
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    });
    const results = await screen.findByRole('list', {
      name: 'Companies and agencies found in HMS',
    });
    expect(find).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(results).getByRole('button', { name: 'ABC Travel' }));
    expect(onPick).toHaveBeenCalledWith(ABC_TRAVEL);
  });

  it('shows the server refusal when queueing Find in HMS is refused', async () => {
    const refusal = 'This mail is for Da Vinci — Centurion HMS not searched';
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(async () => {
        throw Object.assign(new Error(refusal), { data: { code: 'PRECONDITION_FAILED' } });
      }),
      status: vi.fn(async () => null),
    };
    render(
      <PartyPicker
        name="Acme"
        kind="agency"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-dv"
        autoLookup={false}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await waitFor(() => expect(findButton().disabled).toBe(false));
    fireEvent.click(findButton());
    expect((await screen.findByRole('alert')).textContent).toContain(refusal);
  });

  it('shows the server refusal when Find in HMS is refused with the queue off', async () => {
    const refusal = 'This mail is for Da Vinci — Centurion HMS not searched';
    const find = vi.fn(async () => {
      throw Object.assign(new Error(refusal), { data: { code: 'PRECONDITION_FAILED' } });
    });
    render(
      <PartyPicker
        name="Acme"
        kind="agency"
        parties={{}}
        find={find}
        threadId="thread-dv"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(findButton());
    expect((await screen.findByText(refusal)).textContent).toContain(refusal);
  });

  it('shows a queue-off manual result when the synchronous view has no source message id', async () => {
    const jobTransport: HmsJobTransport = {
      jobQueueEnabled: vi.fn(async () => false),
      queue: vi.fn(async () => ({ runId: null, view: manualPartyView() })),
      status: vi.fn(async () => null),
    };
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-selected"
        autoLookup={false}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    await waitFor(() => expect(findButton().disabled).toBe(false));
    fireEvent.click(findButton());

    const results = await screen.findByRole('list', {
      name: 'Companies and agencies found in HMS',
    });
    expect(within(results).getByRole('button', { name: 'ABC Travel' })).toBeTruthy();
    expect(jobTransport.queue).toHaveBeenCalledWith({
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    });
  });

  it('shows a queued manual result attached to the latest inbound message for an older email', async () => {
    const jobTransport: HmsJobTransport = {
      jobQueueEnabled: vi.fn(async () => true),
      queue: vi.fn(async () => ({ runId: 'party-run-older-email' })),
      status: vi.fn(async (input) =>
        'runId' in input ? manualPartyView('message-latest') : null,
      ),
    };
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        sourceMessageId="message-older"
        autoLookup={false}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    await waitFor(() => expect(findButton().disabled).toBe(false));
    fireEvent.click(findButton());

    const results = await screen.findByRole('list', {
      name: 'Companies and agencies found in HMS',
    });
    expect(within(results).getByRole('button', { name: 'ABC Travel' })).toBeTruthy();
    expect(jobTransport.queue).toHaveBeenCalledWith({
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    });
  });

  it('releases the rates hold after four minutes and offers a named Retry', async () => {
    vi.useFakeTimers();
    const queue = vi.fn(async () => ({ runId: 'party-run-slow' }));
    const jobTransport: HmsJobTransport = {
      queue,
      status: vi.fn(async (input) =>
        'runId' in input ? new Promise<never>(() => {}) : null,
      ),
    };
    const onLookupPending = vi.fn();
    render(
      <PartyPicker
        name="ABC Travel"
        kind="company"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-1"
        autoLookup={false}
        onLookupPending={onLookupPending}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(findButton());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queue).toHaveBeenNthCalledWith(1, {
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    });
    expect(onLookupPending).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARTY_SEARCH_DEADLINE_MS);
    });
    expect(screen.getByRole('alert').textContent).toContain('Party search timed out after four minutes.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(onLookupPending).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queue).toHaveBeenNthCalledWith(2, {
      kind: 'party',
      name: 'ABC Travel',
      partyKind: 'company',
    }, { retry: true });
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

describe('PartyPicker duplicate-name choices', () => {
  it('shows all 13 V2 suggestions for one name with IATA and city', async () => {
    const copies = tourvestCopies();
    const view: HmsJobView = {
      ...v2PartyView('needs_pick', 'Tourvest Travel Services'),
      request: {
        kind: 'party',
        name: 'Tourvest Travel Services',
        partyKind: 'agency',
        matchVersion: 2,
      },
      result: {
        kind: 'party',
        outcome: 'ambiguous',
        results: copies,
        best: null,
        truncated: false,
        searchedFor: 'Tourvest Travel Services',
        matchVersion: 2,
        matchStatus: 'needs_pick',
        boundParty: null,
        suggestions: copies,
        reason: 'Several agencies share this name.',
      },
    };
    const onPick = vi.fn();
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => view),
    };
    render(
      <PartyPicker
        name="Tourvest Travel Services"
        kind="agency"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-tourvest"
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );

    const choices = await screen.findByLabelText('Party match needs a pick');
    expect(within(choices).getAllByRole('button')).toHaveLength(13);
    const firstCopy = within(choices).getByRole('button', {
      name: 'Tourvest Travel Services · IATA 77206673 · Pretoria (#280)',
    });
    expect(
      within(choices).getByRole('button', {
        name: 'Tourvest Travel Services · IATA 77206685 · Cape Town (#292)',
      }),
    ).toBeTruthy();
    fireEvent.click(firstCopy);
    expect(onPick).toHaveBeenCalledWith({
      kind: 'agency',
      nativeId: '280',
      name: 'Tourvest Travel Services',
    });
  });

  it('shows every same-name choice across the five-chip prefetched limit', async () => {
    const copies = tourvestCopies();
    const view: HmsJobView = {
      ...prefetchedPartyView(),
      request: { kind: 'party', name: 'Tourvest Travel Services', partyKind: 'agency' },
      result: {
        kind: 'party',
        outcome: 'ambiguous',
        results: copies,
        best: copies[0],
        truncated: false,
        searchedFor: 'Tourvest Travel Services',
      },
    };
    const jobTransport: HmsJobTransport = {
      queue: vi.fn(),
      status: vi.fn(async () => view),
    };
    render(
      <PartyPicker
        name="Tourvest Travel Services"
        kind="agency"
        parties={{}}
        find={vi.fn()}
        jobTransport={jobTransport}
        threadId="thread-tourvest"
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    await screen.findByRole('button', {
      name: 'Tourvest Travel Services · IATA 77206685 · Cape Town (#292)',
    });
    expect(screen.getAllByRole('button', { name: /Tourvest Travel Services/ })).toHaveLength(13);
  });

  it('keeps unique-name choices unchanged even when rows carry IATA and city', async () => {
    const rows: PartyCandidate[] = [
      { ...ABC_TRAVEL, iata: '4411', city: 'Pretoria' },
      { ...ABCD_TRAVEL, iata: '4412', city: 'Cape Town' },
    ];
    render(picker('Travel', vi.fn(async () => listed(...rows))));
    fireEvent.click(findButton());

    const choices = await screen.findByRole('list', {
      name: 'Companies and agencies found in HMS',
    });
    expect(within(choices).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'ABC Travel',
      'ABCD Travel',
    ]);
  });
});
