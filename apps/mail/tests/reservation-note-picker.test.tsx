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
  afterEach(cleanup);

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
