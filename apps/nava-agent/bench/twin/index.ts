import type {CaseCard} from '../types.js';
import {projectHmsShown} from './backdate.js';
import type {PartySearchHistory} from '../../src/party-matching.js';
import {createTwinDispatch} from './tools.js';
import type {ReadResult, Scope} from './read-result.js';
import {loadTwinWorld, type TwinWorld, type ThreadSenders} from './world.js';

export type {TwinWorld, ReadResult, Scope};
export {projectHmsShown, loadTwinWorld};
export {
  queryDigest, contentDigest, observedResult, completeNoMatch, unobservedResult, twinCoverageOf,
} from './read-result.js';

export function createTwin(caseCard: CaseCard, options: {worldDir?: string; property?: string; threadSenders?: ThreadSenders; partyHistory?: (world: TwinWorld) => PartySearchHistory} = {}) {
  const world = loadTwinWorld(caseCard, options.worldDir, options.property, options.threadSenders);
  const dispatch = createTwinDispatch(world, caseCard, options.partyHistory?.(world));
  return {
    world,
    mode: 'twin' as const,
    dispatch,
    shown: () => projectHmsShown(world, caseCard),
    coverage: () => ({...world.coverage}),
  };
}
