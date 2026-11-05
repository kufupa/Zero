// Bounded retries must not toggle a menu/parent that is already opening.
export async function ensureApplicationMenuOpen(page, frontDesk) {
  const geometry = () => frontDesk.evaluate((element) => {
    const view = element.closest('.x-tree-view'), box = view?.getBoundingClientRect();
    const visibleWidth = box ? Math.max(0, Math.min(innerWidth, box.right) - Math.max(0, box.left)) : 0;
    const animating = view?.getAnimations?.().some((animation) => animation.playState === 'running');
    return { ratio: box?.width ? visibleWidth / box.width : 0, animating: Boolean(animating) };
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await frontDesk.count() === 1 ? await geometry() : null;
    if (state?.ratio >= 0.9) return;
    if (!state || (state.ratio === 0 && !state.animating)) {
      await page.locator('a.app-menu-trigger:visible').click();
    }
    let element;
    try {
      await frontDesk.waitFor({ state: 'visible', timeout: 1200 });
      element = await frontDesk.elementHandle();
      await page.waitForFunction((element) => {
        const box = element?.closest('.x-tree-view')?.getBoundingClientRect();
        return Boolean(box && Math.min(innerWidth, box.right) - Math.max(0, box.left) >= box.width * 0.9);
      }, element, { timeout: 1200 });
      return;
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
    } finally { await element?.dispose(); }
  }
  throw new Error('MENU_NOT_OPENED');
}

export async function ensureMenuChild(parent, child, clickParent, { timeoutMs = 1200 } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await child.isVisible()) return;
    const state = await parent.evaluate((element) => {
      const row = element.closest('.x-grid-row,.x-tree-node');
      const view = globalThis.Ext?.getCmp?.(element.closest('.x-tree-view')?.id);
      const record = row && view?.getRecord?.(row);
      return { expanded: typeof record?.isExpanded === 'function' ? record.isExpanded() :
        row?.classList.contains('x-tree-node-expanded') ? true :
          row?.classList.contains('x-tree-node-collapsed') ? false : null,
      loading: typeof record?.isLoading === 'function' ? record.isLoading() : false };
    });
    if (!state.loading && (state.expanded === false || (attempt === 0 && state.expanded === null))) {
      await clickParent();
    }
    try {
      await child.waitFor({ state: 'visible', timeout: timeoutMs });
      return;
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
    }
  }
  throw new Error('MENU_NOT_EXPANDED');
}
