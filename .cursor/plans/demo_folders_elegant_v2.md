# Demo mail — elegant folder model (v2, revised UX)

## Inbox vs folders vs spam — user-facing model (decision)

**Your read is right:** “folders” can mean two different things:

1. **Views / slices (Gmail-ish “labels” mental model)**  
   Same thread can appear in **Inbox** and in **Internal** (or Individual, etc.). Inbox = “everything I still care about”; other nav items = **filters** on that pool.

2. **Exclusive buckets (file-folder mental model)**  
   Each thread lives in **one** place only. Moving to Internal **removes** from Inbox. Harder for a short demo; easy to confuse (“where did it go?”).

**Recommendation for this hotel front-end demo:** use **views, not exclusive buckets**.

- **Inbox** = “all non-spam” (`thread.folder !== 'spam'`). Matches *“everything in inbox apart from spam.”*
- **Internal / Individual / Group / Travel agents** = **narrow filters** (`thread.folder === slug`). Same thread still **counts as in Inbox** because it is not spam.
- **Urgent** = **cross-cutting filter** (`thread.urgent === true`). Threads **keep** primary `folder` (internal, individual, …) so story stays coherent; Urgent nav is “priority queue across categories.”
- **Spam** = **only** threads with `folder === 'spam'`; they **do not** appear in Inbox or other operational folders.

**Why this is best for users here**

- One sentence to narrate: *“Inbox is the main pile; these folders are how we slice it; spam is separate; urgent pulls the hot ones.”*
- No false expectation that clicking Internal **moves** mail out of Inbox (unless you later add real “archive from inbox” behavior).
- Still **one `folder` field** on the thread for primary category — no duplicate rows.

## Implementation note (single matcher)

Replace the earlier “strict `inbox` === `thread.folder`” default with:

| Route slug   | Match rule |
|-------------|------------|
| `inbox`     | `thread.folder !== 'spam'` |
| `spam`      | `thread.folder === 'spam'` |
| `urgent`    | `thread.urgent === true` |
| `internal`, `individual`, `group`, `travel-agents` | `thread.folder === slug` |

Optional: `folder: inbox` on threads for “unclassified” only; then `inbox` could be `folder === 'inbox' || folder !== 'spam'` — **not needed** if every thread has an operational folder and spam is the only exclusion.

## Registry + nav (unchanged intent)

- One [`folder-map` registry](apps/mail/lib/demo/folder-map.ts): ids, titles, subtitles, aliases.
- [`navigation.ts`](apps/mail/config/navigation.ts): single **Folders** section built from registry; remove Demo Queues; subtitles on items.
- [`label-filter`](apps/mail/lib/demo-data/label-filter.ts): drop `billing`, `notification` from sidebar seed.

## Corpus

- Every thread: `folder` ∈ `{ internal, individual, group, travel-agents, spam }` (plus optional `inbox` if you add unclassified later).
- **2+** threads `folder: spam` so Spam nav is non-empty.
- **No** requirement to seed “inbox-only” threads for Inbox to be full — Inbox is **derived** as non-spam.

## Remove

- `workQueue`, `resolveDemoFolderQueryContext`, [`work-queue.ts`](apps/mail/lib/demo-data/work-queue.ts), label-based folder fallback in adapter.

## Tests

- `listDemoThreads({ folder: 'inbox' })` includes internal/individual/… threads, excludes spam.
- `listDemoThreads({ folder: 'internal' })` subset of inbox set.
- Urgent list includes urgent threads regardless of primary folder.
