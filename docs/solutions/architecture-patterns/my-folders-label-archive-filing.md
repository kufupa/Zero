---
title: My folders filing via mailLabel plus archive
date: 2026-08-04
category: architecture-patterns
module: apps/mail My folders + apps/server-pilot mail.fileThreads
problem_type: architecture
resolution_type: pattern
tags:
  - my-folders
  - mailLabel
  - fileThreads
  - hotel-folders
  - drag-drop
  - dnd-kit
  - ec2-pilot
---

# My folders filing via mailLabel plus archive

## Problem

Centurion FO needed Outlook-style custom folders: create folders, drag finished mail out of inbox, reopen later. The product already had hotel AI **Folders** (category queues) and a flat `mailLabel` / Labels chrome. Shipping a second folder table or a “filing brain” would duplicate IA and confuse FO.

## Symptoms / constraints

- Client workflow: inbox = still needs action; filed = done / find later.
- Hotel sidebar **Folders** must stay AI `categoryIds` only ([hotel-folder-ui-parity](../ui-bugs/hotel-folder-ui-parity.md)).
- System places stay flags (`isArchived` / `spamAt` / `trashedAt`) — [folder-first matrix](folder-first-spam-at-folder-matrix.md).
- Prior “always titled Labels” clash fix is superseded for the user-filing section: FO chrome is **My folders**.

## Solution

### Naming

| Layer | Name |
|-------|------|
| AI queues | **Folders** (`categoryIds`) |
| User filing chrome | **My folders** |
| DB / tRPC | `mailLabel` / `labelIds` / `labels.*` (no mass rename) |

### Mutation

`mail.fileThreads({ threadIds, labelId })`:

- Exclusive among **user** label UUIDs on the transport; keep synthetic system ids (`IMPORTANT`, …).
- Never touch `categoryIds`.
- Archive out of inbox: `isArchived=true`, clear trash/spam; prior spam → `spamUserLockedAt=now()`.
- AuthZ: label + threads on `activeTransportId`.

Unfile = existing `moveThreads` → inbox (no second RPC). Folder list uses `folder:'archive'` + `labelIds`, so unarchived threads leave the folder view naturally.

**UI gate:** Move to Inbox chrome must treat My folders UUID routes as archive-like (`isArchiveLikeMailFolder`). A bare `folder === 'archive'` check hides the action on `/mail/{labelId}`.

### Delete

`labels.delete` scrubs the id from thread `labelIds` in a transaction; if no user labels remain and the thread was archived, set `isArchived=false` so mail does not vanish.

### UI

Reuse LabelDialog, magicui Folder hover/select tokens, sidebar CSS vars. Drag with existing `@dnd-kit` (`MailFileDragProvider` in mail layout) — not bare HTML5. Drop highlight = `bg-sidebar-accent`, not neon/purple.

**Drag-end race:** keep filing payload in a ref (`activeDragRef`). PointerSensor can emit `onDragEnd` before React re-renders `onDragStart` state; reading only `useState` → empty `threadIds` → silent no-op. Dedicated writeup: [dnd-kit dragEnd threadIds race](../logic-errors/dnd-kit-mail-file-drag-dragend-threadids-race.md).

### Route wiring

`/mail/{labelId}` → `resolveMailRouteFilter` + `use-threads` merge of route `labelIds` (listing was broken when only the search-hook labels were passed).

## Plan

[docs/superpowers/plans/2026-08-04-custom-folders-drag.md](../../superpowers/plans/2026-08-04-custom-folders-drag.md)
