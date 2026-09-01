export function getFocusableThreadElement(
  threadElement: HTMLElement | null,
): HTMLElement | null {
  if (!threadElement) return null;
  if (threadElement.matches('[tabindex]')) return threadElement;

  return threadElement.closest<HTMLElement>('[tabindex]');
}

export function focusThreadElement(threadElement: HTMLElement | null): boolean {
  const focusableElement = getFocusableThreadElement(threadElement);
  if (!focusableElement) return false;
  if (typeof document !== 'undefined' && document.activeElement === focusableElement) return true;

  focusableElement.focus({ preventScroll: true });
  return true;
}
