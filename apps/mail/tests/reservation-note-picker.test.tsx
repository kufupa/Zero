/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReservationNote } from '../components/reservation-pane/shared/reservation-note';
import { AWAITING_PAYMENT_PREFIX, RESERVATION_NOTE_PRESETS } from '../../server-pilot/src/ai/reservation-note-presets';

function editor(note = 'Staff-entered note', kind: 'create' | 'amend' = 'create') {
  const edit = vi.fn().mockResolvedValue(undefined);
  return {
    edit,
    value: {
      source: { messageId: 'message-1' },
      snapshot: {
        session: {
          draft: {
            note,
            fieldOverrides: {},
            fieldReviewRequirements: {},
            staffReviews: {},
            proposal: { sourceClaims: [], annotations: [] },
          },
        },
      },
      request: { id: 'request-1', kind },
      view: { busy: false, error: null, preview: false, saving: false },
      commands: {
        edit,
        stageEdit: vi.fn(),
        setUncommitted: vi.fn(),
      },
    } as any,
  };
}

describe('Reservation Note quick-picker', () => {
  afterEach(() => { cleanup(); window.sessionStorage.clear(); });

  function guidance(value: any, state = 'set') {
    const draft = value.snapshot.session.draft;
    Object.assign(draft, { generationId: 'generation-1', propertyCode: 'HRCEN', source: { messageId: 'message-1', sourceHash: 'hash-1' },
      observations: [{ ref: 'note-1', kind: 'source', status: 'complete', generationId: 'generation-1', propertyCode: 'HRCEN',
        sourceMessageId: 'message-1', criteria: { kind: 'reservation_note_composition', workflow: 'create', requestId: 'request-1',
          fieldPath: '/note', generationId: 'generation-1', sourceHash: 'hash-1', propertyCode: 'HRCEN' },
        result: { path: '/note', existing: { state, text: state === 'set' ? draft.note : '' }, sourceClauses: [{ text: 'Parking requested', sourceRefs: ['src-1'] }],
          memory: { dinnerCap: { value: '350', text: 'Dinner allowance R350', support: 1, denominator: 1, purity: 1,
            autoApplied: false, blockedReason: 'support_below_min' } }, conflicts: [], compositionStatus: state === 'none' ? 'blocked_none' : 'clean' } }] });
  }

  it('shows source and single-stay guidance and adds only on an explicit click', () => {
    const { edit, value } = editor(); guidance(value);
    render(<ReservationNote path="/note" editor={value} />);
    expect(screen.getByText('Source: Parking requested')).toBeTruthy();
    expect(screen.getByText(/1\/1 · 100% · support below min/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add dinnerCap suggestion' }));
    expect(edit).toHaveBeenCalledWith('/note', 'Staff-entered note\nDinner allowance R350', 'set');
    expect(screen.queryByText(/History dinnerCap/)).toBeNull();
  });

  it('does not resurrect dismissed guidance after a staff edit', () => {
    const { value } = editor(); guidance(value);
    const view = render(<ReservationNote path="/note" editor={value} />);
    fireEvent.change(screen.getByLabelText('Reservation Note'), { target: { value: 'Staff change' } });
    view.rerender(<ReservationNote path="/note" editor={value} />);
    expect(screen.queryByText(/History dinnerCap/)).toBeNull();
    expect((screen.getByLabelText('Reservation Note') as HTMLTextAreaElement).value).toBe('Staff change');
  });

  it('keeps dismissal when the editor is remounted for the same source and path', () => {
    const { value } = editor(); guidance(value);
    const view = render(<ReservationNote path="/note" editor={value} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss note guidance' }));
    view.unmount();
    render(<ReservationNote path="/note" editor={value} />);
    expect(screen.queryByText(/History dinnerCap/)).toBeNull();
  });

  it('protects an explicit none from memory suggestions', () => {
    const { value } = editor(''); guidance(value, 'none');
    value.snapshot.session.draft.fieldOverrides['/note'] = { state: 'none' };
    render(<ReservationNote path="/note" editor={value} />);
    expect((screen.getByRole('button', { name: 'Add dinnerCap suggestion' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks conflicting guidance and ignores stale observations', () => {
    const { value } = editor(); guidance(value);
    const observation = value.snapshot.session.draft.observations[0];
    observation.result.compositionStatus = 'conflict';
    observation.result.conflicts = ['Dinner allowance differs from the current note.'];
    const view = render(<ReservationNote path="/note" editor={value} />);
    expect(screen.getByText('Dinner allowance differs from the current note.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add dinnerCap suggestion' }) as HTMLButtonElement).disabled).toBe(true);
    value.snapshot.session.draft.source.sourceHash = 'new-source';
    view.rerender(<ReservationNote path="/note" editor={value} />);
    expect(screen.queryByText(/History dinnerCap/)).toBeNull();
  });

  it('offers seven presets and explicitly replaces editable note text', () => {
    const { edit, value } = editor();
    render(<ReservationNote path="/note" editor={value} />);

    expect(RESERVATION_NOTE_PRESETS).toHaveLength(7);
    fireEvent.change(screen.getByLabelText('Reservation Note preset'), { target: { value: 'dbb-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace note with preset' }));

    expect((screen.getByLabelText('Reservation Note') as HTMLTextAreaElement).value).toBe('DBB to agent, extras direct');
    expect(edit).toHaveBeenCalledWith('/note', 'DBB to agent, extras direct', 'set');
    fireEvent.change(screen.getByLabelText('Reservation Note'), { target: { value: 'Custom follow-up' } });
    expect((screen.getByLabelText('Reservation Note') as HTMLTextAreaElement).value).toBe('Custom follow-up');
  });

  it('keeps Awaiting payment when applying a preset in Amend', () => {
    const { edit, value } = editor(`${AWAITING_PAYMENT_PREFIX}Old note`, 'amend');
    render(<ReservationNote path="/note" editor={value} />);

    fireEvent.change(screen.getByLabelText('Reservation Note preset'), { target: { value: 'settle-direct' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace note with preset' }));

    expect(edit).toHaveBeenCalledWith('/note', `${AWAITING_PAYMENT_PREFIX}Settle direct`, 'set');
  });
});
