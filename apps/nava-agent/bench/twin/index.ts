import type {CaseCard} from '../types.js';
import {projectHmsShown} from './backdate.js';
import {createTwinDispatch} from './tools.js';
import {loadTwinWorld, type TwinWorld} from './world.js';

export type {TwinWorld};
export {projectHmsShown, loadTwinWorld};

export function createTwin(caseCard: CaseCard, options: {worldDir?: string; property?: string} = {}) {
  const world = loadTwinWorld(caseCard, options.worldDir, options.property);
  const dispatch = createTwinDispatch(world, caseCard);
  return {
    world,
    mode: 'twin' as const,
    dispatch,
    shown: () => projectHmsShown(world, caseCard),
    coverage: () => ({...world.coverage}),
  };
}
