/**
 * Narrow, read-only facade for the reviewed GSGRPB list surface.
 *
 * The request body is intentionally closed to the two observed list calls;
 * selectors, detail tabs, rooming-list actions, and arbitrary paths have no
 * representation here. The response parser lives in the driver so raw HMS
 * transport never crosses the read-service boundary.
 */
import { LIVE_GROUP_BLOCK_LIST_PATH, LIVE_GROUP_BLOCK_OPEN_PATH } from './live-read-manifest.js';
import type { HmsReadSession } from './runtime.js';

const OPEN_FIELDS = {
  SYSTEM_FUNCTION_NAME: 'GSGRPB',
  USER_FUNCTION_NAME: 'GSGRPB',
  FUNCTION_CLASS: 'WEBL',
  CURRENT_TAB_NAME: '',
  MENU_MODULE_KEY: '0',
  removescreenflows: 'yes',
} as const;

const LIST_FIELDS = {
  SYSTEM_FUNCTION_NAME: 'GSGRPB',
  USER_FUNCTION_NAME: 'GSGRPB',
  CURRENT_TAB_NAME: 'LST',
  COMPONENT_INFO_TYPE: 'DATA_ONLY',
  GRID_NAME: 'GSGRPB',
} as const;

export type GroupBlockReadFacade = {
  openList(): Promise<string>;
};

export function createGroupBlockReadFacade(session: HmsReadSession): GroupBlockReadFacade {
  return {
    async openList() {
      await session.page
        .postForm(`${session.origin}${LIVE_GROUP_BLOCK_OPEN_PATH}`, { ...OPEN_FIELDS })
        .catch(() => undefined);

      const correlated = session.page.waitForCorrelatedResponse
        ? session.page.waitForCorrelatedResponse(LIVE_GROUP_BLOCK_LIST_PATH)
        : Promise.resolve();
      const [post, response] = await Promise.allSettled([
        session.page.postForm(`${session.origin}${LIVE_GROUP_BLOCK_LIST_PATH}`, { ...LIST_FIELDS }),
        correlated,
      ]);
      if (post.status === 'rejected') throw post.reason;
      if (response.status === 'rejected') {
        throw new Error('GSGRPB.LST correlated response was not observed');
      }
      return post.value || (await session.page.content());
    },
  };
}
