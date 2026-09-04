import { describe, expect, it } from 'vitest';
import {
  fileDragOverlayLabel,
  formatFileSuccessMessage,
  isUserFolderDroppableId,
  mailFileCollisionDetection,
  resolveFileDragThreadIds,
  shouldFileOnDragEnd,
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

describe('shouldFileOnDragEnd', () => {
  const base = {
    overId: '550e8400-e29b-41d4-a716-446655440000',
    threadIds: ['t1'] as string[],
    startTransportId: 'transport-a',
    currentTransportId: 'transport-a',
  };

  it('files when droppable + threadIds + same transport', () => {
    expect(shouldFileOnDragEnd(base)).toBe(true);
  });

  it('skips when activeDrag threadIds empty (stale state race)', () => {
    expect(shouldFileOnDragEnd({ ...base, threadIds: [] })).toBe(false);
  });

  it('skips on transport switch or missing over', () => {
    expect(
      shouldFileOnDragEnd({ ...base, currentTransportId: 'transport-b' }),
    ).toBe(false);
    expect(shouldFileOnDragEnd({ ...base, overId: null })).toBe(false);
    expect(shouldFileOnDragEnd({ ...base, overId: 'group-x' })).toBe(false);
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

describe('mailFileCollisionDetection', () => {
  const containerId = '550e8400-e29b-41d4-a716-446655440000';
  const droppableContainers = [
    {
      id: containerId,
      key: containerId,
      data: { current: undefined },
      disabled: false,
      node: { current: null },
      rect: { current: null },
    },
  ];

  const droppableRects = new Map([
    [
      containerId,
      {
        top: 100,
        left: 100,
        bottom: 200,
        right: 200,
        width: 100,
        height: 100,
      },
    ],
  ]);

  type CollisionArgs = Parameters<typeof mailFileCollisionDetection>[0];

  it('returns container collision when pointer is inside container bounds', () => {
    const args = {
      active: { id: 'thread-1' },
      collisionRect: { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 },
      droppableContainers,
      droppableRects,
      pointerCoordinates: { x: 150, y: 150 },
    } as unknown as CollisionArgs;

    const collisions = mailFileCollisionDetection(args);
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]?.id).toBe(containerId);
  });

  it('returns empty array when pointer is outside container bounds (no distant closestCenter fallback)', () => {
    const args = {
      active: { id: 'thread-1' },
      collisionRect: { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 },
      droppableContainers,
      droppableRects,
      pointerCoordinates: { x: 500, y: 500 },
    } as unknown as CollisionArgs;

    const collisions = mailFileCollisionDetection(args);
    expect(collisions).toEqual([]);
  });

  it('returns empty array when pointerCoordinates is null', () => {
    const args = {
      active: { id: 'thread-1' },
      collisionRect: { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 },
      droppableContainers,
      droppableRects,
      pointerCoordinates: null,
    } as unknown as CollisionArgs;

    expect(mailFileCollisionDetection(args)).toEqual([]);
  });
});

describe('formatFileSuccessMessage', () => {
  it('formats specific folder name when provided', () => {
    expect(formatFileSuccessMessage('Bookings')).toBe('Moved to Bookings');
    expect(formatFileSuccessMessage('Inquiries')).toBe('Moved to Inquiries');
  });

  it('truncates long folder names to 24 chars to avoid clipping toast undo button', () => {
    expect(formatFileSuccessMessage('Super Extremely Long Hotel Folder Name')).toBe(
      'Moved to Super Extremely Long Hot...',
    );
  });

  it('falls back gracefully when folder name is missing or whitespace', () => {
    expect(formatFileSuccessMessage(null)).toBe('Moved to folder');
    expect(formatFileSuccessMessage(undefined)).toBe('Moved to folder');
    expect(formatFileSuccessMessage('   ')).toBe('Moved to folder');
  });
});
