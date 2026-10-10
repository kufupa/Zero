/**
 * The preview gate (apps/server-pilot/scripts/nava-preview-run.ts) masks every `[data-pii]` element in its screenshots.
 * Returns each shown text or field value that holds one of `values` (ignoring case) but sits outside a `[data-pii]`
 * element, so a test can assert the list is empty. Screen-reader-only text is not drawn, so it is skipped.
 */
export function unmaskedPii(root: HTMLElement, values: readonly string[]): string[] {
  const needles = values.map((value) => value.toLowerCase());
  const holds = (text: string) => needles.some((needle) => text.toLowerCase().includes(needle));
  const leaks: string[] = [];
  // A plain walk: happy-dom's TreeWalker does not yield text nodes.
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? '';
      const parent = node.parentElement;
      if (holds(text) && parent && !parent.closest('.sr-only') && !parent.closest('[data-pii]')) leaks.push(text);
      return;
    }
    node.childNodes.forEach(visit);
  };
  visit(root);
  for (const field of Array.from(root.querySelectorAll('input, textarea'))) {
    const value = (field as HTMLInputElement).value;
    if (holds(value) && !field.closest('[data-pii]')) leaks.push(value);
  }
  return leaks;
}
