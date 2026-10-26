/**
 * Exclusive page lease for every HMS write CLI.
 * Unknown, inactive, or omitted property fails closed before a page is created.
 * No hotel default. Live writers stay Labtest-only at each CLI.
 *
 * Same Lease-0 wrapper and lock resolution as read CLIs: one exclusive
 * authenticated page per process. A separate write singleton would let a
 * read and a write both believe they held the page.
 */
import { lookupActiveProperty, withReadCliPage, SlotLeaseRefusedError } from './read-cli-lease.mjs';

export { lookupActiveProperty, SlotLeaseRefusedError };

export const withWriteCliPage = withReadCliPage;
export const withLeasedWritePage = withWriteCliPage;

export const WRITE_CLI_TOOLS = Object.freeze([
  'create-lab-stay',
  'amend-stay',
  'cancel-stay',
  'cancel-lab-stay',
  'attach-document',
]);
