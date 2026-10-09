import { atomWithStorage } from 'jotai/utils';

/**
 * Whether the Nava pane sits beside the open thread on wide screens. Stored in localStorage
 * under `nava-side-panel`; on by default. Read on init so the first render has the saved value.
 */
export const navaSidePanelAtom = atomWithStorage('nava-side-panel', true, undefined, {
  getOnInit: true,
});
