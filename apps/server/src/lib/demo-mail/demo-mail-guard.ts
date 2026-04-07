import { isDemoMode } from '../../config/demo';

/** Skip durable-object / Gmail side effects in demo mailbox mode. */
export function shouldSkipDriverMailMutation(): boolean {
  return isDemoMode();
}
