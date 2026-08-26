export interface MailRowSelectionInput {
  /** The row matches the thread selected by the URL/current mail state. */
  isMailSelected: boolean;
  /** Bulk selection is an independent visual state and remains active in keyboard mode. */
  isMailBulkSelected: boolean;
  /** The row owns the current focused index while keyboard navigation is active. */
  isKeyboardFocused: boolean;
  /** Whether focused-index selection is currently authoritative. */
  isKeyboardNavigationActive: boolean;
}

export function isMailRowActive(input: MailRowSelectionInput): boolean {
  if (input.isMailBulkSelected) return true;

  return input.isKeyboardNavigationActive ? input.isKeyboardFocused : input.isMailSelected;
}

export function getMailRowSelectionClasses(input: MailRowSelectionInput): string {
  if (!isMailRowActive(input)) return '';

  if (input.isKeyboardNavigationActive && input.isKeyboardFocused) {
    return 'border-border bg-primary/15 opacity-100 ring-2 ring-inset ring-primary/70';
  }

  return 'border-border bg-primary/10 opacity-100 ring-1 ring-inset ring-primary/60';
}
