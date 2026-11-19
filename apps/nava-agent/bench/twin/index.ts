import type {CaseCard} from '../types.js';
import {projectHmsShown} from './backdate.js';
import {createTwinDispatch, type TwinMode} from './tools.js';
import {loadTwinWorld, type TwinWorld} from './world.js';

export type {TwinMode, TwinWorld};
export {projectHmsShown, loadTwinWorld};

export function createTwin(caseCard: CaseCard, options: {mode?: TwinMode; root?: string} = {}) {
  const world = loadTwinWorld(caseCard, options.root);
  const mode = options.mode ?? 'twin';
  const dispatch = createTwinDispatch(world, caseCard, mode);
  return {
    world,
    mode,
    dispatch,
    shown: () => projectHmsShown(world, caseCard),
    coverage: () => ({...world.coverage}),
  };
}
