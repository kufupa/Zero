import type { ReservationPaneSnapshot } from './types';

export type PendingReservationEdit = {
  path: string;
  value: unknown;
  state: 'set' | 'none' | 'unknown' | 'inherit' | 'clear';
  sequence: number;
};

export type ReservationUiState = {
  selectionEpoch: number;
  pendingEdits: PendingReservationEdit[];
  busyAction: string | null;
  actionError: string | null;
};

export type ReservationUiAction =
  | { type: 'source-changed'; selectionEpoch: number }
  | { type: 'stage-edit'; edit: PendingReservationEdit }
  | { type: 'edit-acknowledged'; sequence: number }
  | { type: 'snapshot-received'; snapshot: ReservationPaneSnapshot }
  | { type: 'set-busy'; action: string | null }
  | { type: 'action-error'; message: string | null };

export function initialReservationUiState(selectionEpoch: number): ReservationUiState {
  return { selectionEpoch, pendingEdits: [], busyAction: null, actionError: null };
}

export function reduceReservationUi(state: ReservationUiState, action: ReservationUiAction): ReservationUiState {
  switch (action.type) {
    case 'source-changed':
      return action.selectionEpoch === state.selectionEpoch ? state : initialReservationUiState(action.selectionEpoch);
    case 'stage-edit':
      return { ...state, actionError: null,
        pendingEdits: [...state.pendingEdits.filter((edit) => edit.path !== action.edit.path), action.edit] };
    case 'edit-acknowledged':
      return { ...state, pendingEdits: state.pendingEdits.filter((edit) => edit.sequence !== action.sequence) };
    case 'snapshot-received':
      return { ...state, actionError: null };
    case 'set-busy':
      return { ...state, busyAction: action.action };
    case 'action-error':
      return { ...state, actionError: action.message, busyAction: null };
  }
}
