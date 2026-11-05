import { randomUUID } from 'node:crypto';

// Observe the clicked panel, not a locator that moves to the next collapsed one.
export async function expandStay360Panel(frame, panel, expand) {
  const element = await panel.elementHandle();
  const key = `__navaExpand_${randomUUID().replaceAll('-', '')}`;
  try {
    const installed = await frame.evaluate(({ element, key }) => {
      const component = globalThis.Ext?.getCmp?.(element?.id);
      if (!component?.collapsed || typeof component.on !== 'function' ||
          typeof component.un !== 'function') return false;
      const state = { component, element, expanded: false };
      state.onExpand = () => { state.expanded = true; };
      component.on('expand', state.onExpand);
      globalThis[key] = state;
      return true;
    }, { element, key });
    if (!installed) throw new Error('RECORD_PANEL_UNAVAILABLE');
    await expand.click();
    await frame.waitForFunction((key) => {
      const state = globalThis[key], component = state?.component;
      const body = component?.body?.dom;
      return state?.expanded && state.element.isConnected &&
        globalThis.Ext?.getCmp?.(state.element.id) === component &&
        component.collapsed === false && !component.isCollapsingOrExpanding &&
        !state.element.classList.contains('x-panel-collapsed') &&
        body && body.getBoundingClientRect().width > 0 && body.getBoundingClientRect().height > 0 &&
        getComputedStyle(body).visibility !== 'hidden';
    }, key, { timeout: 10000 });
  } finally {
    await frame.evaluate((key) => {
      const state = globalThis[key];
      state?.component.un('expand', state.onExpand);
      delete globalThis[key];
    }, key).catch(() => {});
    await element?.dispose();
  }
}
