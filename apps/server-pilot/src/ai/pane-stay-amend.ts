import {
  paneWriteMode,
  type PaneSaveMode,
  type PaneWriteMoneyState,
} from './pane-stay-save.js';

/** Amend switch for this money state. Create mode never enables amend. */
export function paneStayAmendMode(
  moneyState: PaneWriteMoneyState = 'unpaid',
  env: NodeJS.Dict<string> = process.env,
): PaneSaveMode {
  return paneWriteMode('amend', moneyState, env);
}

export function paneStayAmendEnabled(
  moneyState: PaneWriteMoneyState = 'unpaid',
  env: NodeJS.Dict<string> = process.env,
): boolean {
  return paneStayAmendMode(moneyState, env) !== 'off';
}
