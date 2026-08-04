import { describe, expect, it } from 'vitest';
import {
  fileDragOverlayLabel,
  isUserFolderDroppableId,
  resolveFileDragThreadIds,
} from '@/lib/mail/file-drag';

describe('resolveFileDragThreadIds', () => {
  it('files all selected when dragged id is in bulk selection', () => {
    expect(resolveFileDragThreadIds('b', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('files only dragged id when not in selection', () => {
    expect(resolveFileDragThreadIds('x', ['a', 'b'])).toEqual(['x']);
    expect(resolveFileDragThreadIds('solo', [])).toEqual(['solo']);
  });
});

describe('isUserFolderDroppableId', () => {
  it('rejects group-* synthetic folder rows', () => {
    expect(isUserFolderDroppableId('group-Bookings')).toBe(false);
    expect(isUserFolderDroppableId('group-other')).toBe(false);
  });

  it('accepts real user label ids', () => {
    expect(isUserFolderDroppableId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isUserFolderDroppableId('Label_42')).toBe(true);
  });

  it('rejects empty ids', () => {
    expect(isUserFolderDroppableId('')).toBe(false);
    expect(isUserFolderDroppableId(null)).toBe(false);
    expect(isUserFolderDroppableId(undefined)).toBe(false);
  });
});

describe('fileDragOverlayLabel', () => {
  it('shows subject for single thread', () => {
    expect(fileDragOverlayLabel(['t1'], 'Invoice PO-9')).toBe('Invoice PO-9');
  });

  it('shows N threads for multi-select payload', () => {
    expect(fileDragOverlayLabel(['a', 'b', 'c'], 'ignored')).toBe('3 threads');
  });

  it('falls back when subject missing', () => {
    expect(fileDragOverlayLabel(['t1'], null)).toBe('1 thread');
    expect(fileDragOverlayLabel(['t1'], '  ')).toBe('1 thread');
  });
});
