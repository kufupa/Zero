# Hotel Folder UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `overnight-autonomous-zero` + `superpowers:subagent-driven-development`. Execute task-by-task overnight — no “which approach?” pause. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring FE-demo hotel Folders visual language onto EC2-pilot’s live `categoryIds` + AI triage pipeline — polished sidebar, live pills, demoted Labels — without flipping demo mode or changing triage taxonomy.

**Architecture:** One FE presentation module owns slug→title/subtitle/theme/urgent-stripe and id→pill resolve. Live nav keeps `categories.list` + `/mail/:slug` + `filters.categoryIds`. `mail.get` gains the same category membership as `listThreads` (plus `categories[]` for wire contract). Pills resolve from `categoryIds` with `centurionCategory` demo fallback. Labels become a real collapsed collapsible titled “Labels”.

**Tech Stack:** TypeScript, React, tRPC, Vitest, Drizzle (`mail_category` / `mail_thread_category`), existing Centurion pastel tokens in `apps/mail/lib/demo/folder-map.ts`

**Spec source:** Eng-hardened plan `hotel_folder_ui_polish` (Approach B, scope A max completeness). CEO: presentation on live path; HOLD taxonomy/counts.

## Global Constraints

- **`FORCE_FRONTEND_ONLY_DEMO` stays `false`** in live pilot. Never re-enable demo mode to “fix” UI.
- **No AI triage / seed taxonomy / prompt / slug changes.** Slugs locked: `internal`, `individual`, `group`, `travel-agents`, `urgent`.
- **Hotel filters use `categoryIds` only** — never write hotel folders into `labelIds` / `?labels=`.
- **Spam stays system folder** (`spamAt`); never inject as hotel Folders nav item.
- **Urgent is overlay** — may coexist with one primary; pill shows primary + urgent affordance when both; urgent-only → urgent pill.
- **Theme precedence:** AI-managed slugs always use presentation pastels; DB seed hex only for unknown/custom slugs.
- **Stale triage UI:** rely on existing list/open-thread poll (`VITE_MAIL_POLL_MS`); no new websocket.
- **Commits:** one commit per task (overnight autonomy authorizes commits on `EC2-pilot`). Never `--no-verify` / force-push main.

---

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Overnight wave

```text
local: tests + builds green → commit → push EC2-pilot
→ ops-deploy.sh            # no --migrate (read-path only; no schema)
→ SSM smoke: mail FE build / targeted vitest if available on box
→ handoff report under docs/superpowers/plans/handoff-reports/
```

### Done criteria

- [ ] Tasks 1–7 implemented + committed on `EC2-pilot`
- [ ] FE vitest green: `hotel-folder-presentation`, `search-filter-contract`, demo adapter/folder-map tests
- [ ] Server vitest green (or honest skipIf): `package-contract`, `mail-category-filter` get wire
- [ ] `FORCE_FRONTEND_ONLY_DEMO` remains `false`; no triage/seed taxonomy edits
- [ ] Live Folders: demo titles/subtitles/pastels/urgent stripe; managed slugs ignore seed hex
- [ ] Live list + detail pills from `categoryIds`; demo `centurionCategory` fallback still works
- [ ] `mail.get` returns `categoryIds` + `categories` consistent with list
- [ ] Labels titled Labels, real collapsed collapsible, no mailbox “Folders” clash
- [ ] Category chips aligned with presentation map; hotel filter still `categoryIds` not `labels`
- [ ] Hex consumer audit done (live surfaces fixed or deferred in handoff)
- [ ] Pushed + `ops-deploy.sh` on EC2; handoff report written
- [ ] No open blockers for hotel folder UI parity goal

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development (+ overnight-autonomous-zero). Do not ask "which approach?"

---

## File map

| File | Responsibility |
|------|----------------|
| **Create** `apps/mail/lib/mail/hotel-folder-presentation.ts` | Slug display map, nav theme, primary/urgent resolve, id→slug helpers |
| **Create** `apps/mail/tests/hotel-folder-presentation.test.ts` | Unit tests for map + resolve + theme precedence helpers |
| **Modify** `apps/mail/config/navigation.ts` | `buildLiveCategoryNavItems` uses presentation (title/subtitle/theme/stripe) |
| **Modify** `apps/server-pilot/src/trpc/routes/mail.ts` | Shared category loader; `mail.get` returns `categoryIds` + `categories` |
| **Modify** `apps/server-pilot/src/lib/driver/types.ts` | `ThreadDetailResponse.categoryIds` |
| **Modify** `apps/server-pilot/tests/package-contract.test.ts` | Detail fixture includes `categoryIds` |
| **Modify** `apps/server-pilot/tests/mail-category-filter.test.ts` | Assert `mail.get` membership |
| **Modify** `apps/mail/types/index.ts` | `MailListThreadRow.categoryIds` |
| **Modify** `apps/mail/components/mail/centurion-category-pill.tsx` | Live pills; dual-path; remove demo gate |
| **Modify** `apps/mail/components/mail/mail-list.tsx` | Pass `categoryIds` + id→slug into pill |
| **Modify** `apps/mail/components/mail/mail-display.tsx` | Same for detail |
| **Modify** `apps/mail/lib/demo-data/adapter.ts` | Keep `centurionCategory`; dual-path still works (`categoryIds` may stay `[]`) |
| **Modify** `apps/mail/components/ui/nav-main.tsx` | Labels title + real CollapsibleTrigger/Content |
| **Modify** `apps/mail/components/mail/mail.tsx` | CategoryDropdown display from presentation map |
| **Modify** `apps/mail/tests/search-filter-contract.test.ts` | Chip display helper + filter regression |
| **Modify** `apps/mail/tests/demo-folder-map.test.ts` | Pill visibility still covered (or move to hotel tests) |

**Out of this plan:** badge counts API, seed renames, settings categories page enablement, BE writing `centurionCategory`, IMAP/Gmail.

---

### Task 1: Hotel folder presentation module (pure)

**Files:**
- Create: `apps/mail/lib/mail/hotel-folder-presentation.ts`
- Test: `apps/mail/tests/hotel-folder-presentation.test.ts`

**Interfaces:**
- Consumes: color tokens + demo titles from `apps/mail/lib/demo/folder-map.ts` (`DEMO_MAIL_FOLDER_DEFINITIONS`, `getCenturionCategoryColorStyle`, `CENTURION_CATEGORY_COLOR_STYLES`)
- Produces:
  - `HOTEL_PRIMARY_CATEGORY_SLUGS` / `HOTEL_OVERLAY_CATEGORY_SLUGS` / `HOTEL_MANAGED_CATEGORY_SLUGS` (must match server `apps/server-pilot/src/ai/categories.ts` — comment lock)
  - `isHotelManagedCategorySlug(slug: string): boolean`
  - `getHotelFolderPresentation(slug: string): { title: string; subtitle: string } | null`
  - `getHotelFolderNavTheme(slug: string): { style?: CSSProperties; className?: string }`
  - `buildCategoryIdToSlugMap(categories: Array<{ id: string; slug?: string | null }>): Map<string, string>`
  - `resolveThreadCategoryPresentation(categoryIds: string[], idToSlug: Map<string, string>): { primarySlug: HotelPrimarySlug | null; isUrgent: boolean; pillSlug: HotelManagedSlug | null }`
  - `shouldShowHotelCategoryPill(input: { routeFolder: string | undefined; pillSlug: HotelManagedSlug | null }): boolean`
  - `getHotelPillColorStyle(slug: HotelManagedSlug): { bg: string; text: string; darkBg: string; darkText: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/mail/tests/hotel-folder-presentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildCategoryIdToSlugMap,
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  isHotelManagedCategorySlug,
  resolveThreadCategoryPresentation,
  shouldShowHotelCategoryPill,
} from '@/lib/mail/hotel-folder-presentation';

describe('hotel-folder-presentation', () => {
  it('locks managed slugs to AI taxonomy', () => {
    expect(isHotelManagedCategorySlug('individual')).toBe(true);
    expect(isHotelManagedCategorySlug('urgent')).toBe(true);
    expect(isHotelManagedCategorySlug('spam')).toBe(false);
  });

  it('returns demo-style title and subtitle for managed slugs', () => {
    expect(getHotelFolderPresentation('individual')).toEqual({
      title: 'Individual Room Bookings',
      subtitle: 'Guest & room requests',
    });
    expect(getHotelFolderPresentation('unknown-custom')).toBeNull();
  });

  it('nav theme for managed slug uses Centurion pastel CSS vars not solid hex', () => {
    const theme = getHotelFolderNavTheme('individual');
    expect(theme.className).toContain('--centurion-sidebar-bg');
    expect(JSON.stringify(theme.style)).toContain('#DCFCE7');
  });

  it('urgent nav theme includes right-edge stripe class', () => {
    const theme = getHotelFolderNavTheme('urgent');
    expect(theme.className).toContain('after:bg-red-500');
  });

  it('resolve: primary + urgent → primary pillSlug + isUrgent', () => {
    const idToSlug = buildCategoryIdToSlugMap([
      { id: 'c-ind', slug: 'individual' },
      { id: 'c-urg', slug: 'urgent' },
    ]);
    const resolved = resolveThreadCategoryPresentation(['c-ind', 'c-urg'], idToSlug);
    expect(resolved).toEqual({
      primarySlug: 'individual',
      isUrgent: true,
      pillSlug: 'individual',
    });
  });

  it('resolve: urgent only → pillSlug urgent', () => {
    const idToSlug = buildCategoryIdToSlugMap([{ id: 'c-urg', slug: 'urgent' }]);
    expect(resolveThreadCategoryPresentation(['c-urg'], idToSlug).pillSlug).toBe('urgent');
  });

  it('resolve: empty or unmapped → null pill', () => {
    const idToSlug = buildCategoryIdToSlugMap([{ id: 'c-ind', slug: 'individual' }]);
    expect(resolveThreadCategoryPresentation([], idToSlug).pillSlug).toBeNull();
    expect(resolveThreadCategoryPresentation(['missing'], idToSlug).pillSlug).toBeNull();
  });

  it('hides pill when route already is that category', () => {
    expect(
      shouldShowHotelCategoryPill({ routeFolder: 'individual', pillSlug: 'individual' }),
    ).toBe(false);
    expect(shouldShowHotelCategoryPill({ routeFolder: 'inbox', pillSlug: 'individual' })).toBe(
      true,
    );
    expect(shouldShowHotelCategoryPill({ routeFolder: 'urgent', pillSlug: 'urgent' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail && pnpm exec vitest run tests/hotel-folder-presentation.test.ts`

Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mail/lib/mail/hotel-folder-presentation.ts`:

```ts
import type { CSSProperties } from 'react';
import {
  DEMO_MAIL_FOLDER_DEFINITIONS,
  getCenturionCategoryColorStyle,
  isCenturionMailCategorySlug,
  normalizeDemoMailFolderSlug,
  type CenturionCategoryColorStyle,
} from '@/lib/demo/folder-map';
import { cn } from '@/lib/utils';

/**
 * Locked to apps/server-pilot/src/ai/categories.ts
 * AI_PRIMARY_CATEGORY_SLUGS / AI_OVERLAY_CATEGORY_SLUGS — do not drift.
 */
export const HOTEL_PRIMARY_CATEGORY_SLUGS = [
  'internal',
  'individual',
  'group',
  'travel-agents',
] as const;

export const HOTEL_OVERLAY_CATEGORY_SLUGS = ['urgent'] as const;

export const HOTEL_MANAGED_CATEGORY_SLUGS = [
  ...HOTEL_PRIMARY_CATEGORY_SLUGS,
  ...HOTEL_OVERLAY_CATEGORY_SLUGS,
] as const;

export type HotelPrimarySlug = (typeof HOTEL_PRIMARY_CATEGORY_SLUGS)[number];
export type HotelOverlaySlug = (typeof HOTEL_OVERLAY_CATEGORY_SLUGS)[number];
export type HotelManagedSlug = (typeof HOTEL_MANAGED_CATEGORY_SLUGS)[number];

const PRIMARY_SET = new Set<string>(HOTEL_PRIMARY_CATEGORY_SLUGS);
const MANAGED_SET = new Set<string>(HOTEL_MANAGED_CATEGORY_SLUGS);

const URGENT_COLOR_STYLE: CenturionCategoryColorStyle = {
  bg: '#FEE2E2',
  text: '#991B1B',
  darkBg: '#7F1D1D',
  darkText: '#FEE2E2',
};

export function isHotelManagedCategorySlug(slug: string): slug is HotelManagedSlug {
  return MANAGED_SET.has(slug);
}

export function isHotelPrimaryCategorySlug(slug: string): slug is HotelPrimarySlug {
  return PRIMARY_SET.has(slug);
}

export function getHotelFolderPresentation(
  slug: string,
): { title: string; subtitle: string } | null {
  if (!isHotelManagedCategorySlug(slug)) return null;
  const def = DEMO_MAIL_FOLDER_DEFINITIONS.find((d) => d.id === slug);
  if (!def) return null;
  return { title: def.title, subtitle: def.subtitle };
}

export function getHotelPillColorStyle(slug: HotelManagedSlug): CenturionCategoryColorStyle {
  if (slug === 'urgent') return URGENT_COLOR_STYLE;
  return getCenturionCategoryColorStyle(slug);
}

export function getHotelFolderNavTheme(slug: string): {
  style?: CSSProperties;
  className?: string;
} {
  if (!isHotelManagedCategorySlug(slug)) return {};

  if (slug === 'urgent') {
    const palette = URGENT_COLOR_STYLE;
    return {
      style: {
        '--centurion-sidebar-bg': palette.bg,
        '--centurion-sidebar-text': palette.text,
        '--centurion-sidebar-bg-dark': palette.darkBg,
        '--centurion-sidebar-text-dark': palette.darkText,
      } as CSSProperties,
      className: cn(
        'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
        "relative after:absolute after:inset-y-1.5 after:right-0 after:w-1 after:rounded-l-sm after:bg-red-500/90 after:content-['']",
      ),
    };
  }

  if (!isCenturionMailCategorySlug(slug)) return {};
  const palette = getCenturionCategoryColorStyle(slug);
  return {
    style: {
      '--centurion-sidebar-bg': palette.bg,
      '--centurion-sidebar-text': palette.text,
      '--centurion-sidebar-bg-dark': palette.darkBg,
      '--centurion-sidebar-text-dark': palette.darkText,
    } as CSSProperties,
    className:
      'bg-[var(--centurion-sidebar-bg)] text-[var(--centurion-sidebar-text)] dark:bg-[var(--centurion-sidebar-bg-dark)] dark:text-[var(--centurion-sidebar-text-dark)]',
  };
}

export function buildCategoryIdToSlugMap(
  categories: Array<{ id: string; slug?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const category of categories) {
    if (category.slug) map.set(category.id, category.slug);
  }
  return map;
}

export function resolveThreadCategoryPresentation(
  categoryIds: string[],
  idToSlug: Map<string, string>,
): {
  primarySlug: HotelPrimarySlug | null;
  isUrgent: boolean;
  pillSlug: HotelManagedSlug | null;
} {
  const slugs = categoryIds
    .map((id) => idToSlug.get(id))
    .filter((slug): slug is string => Boolean(slug));

  let primarySlug: HotelPrimarySlug | null = null;
  let isUrgent = false;

  for (const slug of slugs) {
    if (slug === 'urgent') isUrgent = true;
    else if (!primarySlug && isHotelPrimaryCategorySlug(slug)) primarySlug = slug;
  }

  const pillSlug: HotelManagedSlug | null = primarySlug ?? (isUrgent ? 'urgent' : null);
  return { primarySlug, isUrgent, pillSlug };
}

export function shouldShowHotelCategoryPill(input: {
  routeFolder: string | undefined;
  pillSlug: HotelManagedSlug | null;
}): boolean {
  const { routeFolder, pillSlug } = input;
  if (!pillSlug) return false;
  const routeSlug = normalizeDemoMailFolderSlug(routeFolder);
  if (isHotelManagedCategorySlug(routeSlug) && routeSlug === pillSlug) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail && pnpm exec vitest run tests/hotel-folder-presentation.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/hotel-folder-presentation.ts apps/mail/tests/hotel-folder-presentation.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): add hotel folder presentation map and resolve helpers

EOF
)"
```

---

### Task 2: Live sidebar nav uses presentation map

**Files:**
- Modify: `apps/mail/config/navigation.ts` (`buildLiveCategoryNavItems`)
- Test: extend `apps/mail/tests/hotel-folder-presentation.test.ts` (or add `apps/mail/tests/hotel-folder-nav.test.ts`)

**Interfaces:**
- Consumes: `getHotelFolderPresentation`, `getHotelFolderNavTheme`, `isHotelManagedCategorySlug` from Task 1; `categoryColorNavTheme` for unknown slugs only
- Produces: `NavItem[]` with demo titles/subtitles/pastels/urgent stripe for managed slugs

- [ ] **Step 1: Write the failing theme-precedence test**

Add to `apps/mail/tests/hotel-folder-presentation.test.ts`:

```ts
import { buildLiveCategoryNavItems } from '@/config/navigation';

describe('buildLiveCategoryNavItems theme precedence', () => {
  it('managed slug ignores seed hex and uses presentation title', () => {
    const items = buildLiveCategoryNavItems([
      {
        slug: 'individual',
        name: 'Individual',
        color: '#2563eb',
        sortOrder: 110,
      },
    ]);
    expect(items[0]?.title).toBe('Individual Room Bookings');
    expect(items[0]?.subtitle).toBe('Guest & room requests');
    expect(items[0]?.className).toContain('--centurion-sidebar-bg');
    expect(JSON.stringify(items[0]?.style)).toContain('#DCFCE7');
    expect(JSON.stringify(items[0]?.style)).not.toContain('#2563eb');
  });

  it('unknown slug keeps API name and optional hex theme', () => {
    const items = buildLiveCategoryNavItems([
      { slug: 'vip-custom', name: 'VIP Desk', color: '#112233', sortOrder: 1 },
    ]);
    expect(items[0]?.title).toBe('VIP Desk');
    expect(items[0]?.subtitle).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail && pnpm exec vitest run tests/hotel-folder-presentation.test.ts`

Expected: FAIL — titles still short DB names and/or hex theme wins.

- [ ] **Step 3: Replace `buildLiveCategoryNavItems`**

In `apps/mail/config/navigation.ts`, update imports and replace the function body:

```ts
import {
  getHotelFolderNavTheme,
  getHotelFolderPresentation,
  isHotelManagedCategorySlug,
} from '@/lib/mail/hotel-folder-presentation';
import { categoryColorNavTheme } from '@/lib/mail/route-filter';

export function buildLiveCategoryNavItems(categories: LiveCategoryNavInput[]): NavItem[] {
  return [...categories]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((category) => {
      const presentation = getHotelFolderPresentation(category.slug);
      const managedTheme = isHotelManagedCategorySlug(category.slug)
        ? getHotelFolderNavTheme(category.slug)
        : category.color?.trim()
          ? categoryColorNavTheme(category.color)
          : {};

      return {
        id: category.slug,
        title: presentation?.title ?? category.name,
        subtitle: presentation?.subtitle,
        url: `/mail/${category.slug}`,
        icon: Folder,
        ...managedTheme,
      };
    });
}
```

Remove the old branch that preferred `category.color` whenever set for managed slugs. Keep demo-only `getDemoMailFolderNavItemTheme` for `DEMO_FOLDER_MODEL_ENABLED` static items if still used.

- [ ] **Step 4: Run tests**

Run: `cd apps/mail && pnpm exec vitest run tests/hotel-folder-presentation.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mail/config/navigation.ts apps/mail/tests/hotel-folder-presentation.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): use hotel presentation map for live Folders nav

EOF
)"
```

---

### Task 3: `mail.get` returns `categoryIds` + `categories`

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/lib/driver/types.ts`
- Modify: `apps/server-pilot/tests/package-contract.test.ts`
- Modify: `apps/server-pilot/tests/mail-category-filter.test.ts`

**Interfaces:**
- Consumes: existing `mailThreadCategory` + `mailCategory` tables
- Produces:
  - `loadCategoryIdsByThreadIds(db, transportId, threadIds): Promise<Map<string, string[]>>` (shared by list + get)
  - `mail.get` return includes `categoryIds: string[]` and `categories: MailCategory[]`
  - `ThreadDetailResponse` gains `categoryIds: string[]` (keep `categories: MailCategory[]`)

- [ ] **Step 1: Write the failing integration test**

Append to `apps/server-pilot/tests/mail-category-filter.test.ts` inside the same `describe.skipIf` block:

```ts
  it('mail.get returns categoryIds and categories matching listThreads', async () => {
    await withSeededTestDb(async (db) => {
      const [groupCategory] = await db
        .select()
        .from(mailCategory)
        .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'group')))
        .limit(1);
      expect(groupCategory).toBeDefined();

      const threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Get category wire',
        snippet: 'wire',
        isRead: true,
        latestMessageAt: new Date('2026-07-06T12:00:00Z'),
      });
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'a@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Get category wire',
        textBody: 'hello',
        receivedAt: new Date('2026-07-06T12:00:00Z'),
      });
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: groupCategory!.id,
        transportId: TRANSPORT_ID,
      });

      const { mail } = await callerFor('user-navaai', { db });
      const detail = await mail.get({ id: threadId });
      expect(detail.categoryIds).toEqual([groupCategory!.id]);
      expect(detail.categories.map((c) => c.slug)).toEqual(['group']);
    });
  });
```

Also update `apps/server-pilot/tests/package-contract.test.ts` detail fixture:

```ts
    const detail = {
      latest: message,
      messages: [message],
      drafts: [draft],
      hasUnread: true,
      totalReplies: 1,
      labels: [],
      categories: [category],
      categoryIds: [category.id],
    } satisfies ThreadDetailResponse;
```

And in `apps/server-pilot/src/lib/driver/types.ts`:

```ts
export interface ThreadDetailResponse {
  latest?: ParsedMessage;
  messages: ParsedMessage[];
  drafts: ParsedDraft[];
  hasUnread: boolean;
  totalReplies: number;
  labels: MailLabelWire[];
  categories: MailCategory[];
  categoryIds: string[];
  centurionCategory?: CenturionMailCategory;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server-pilot && pnpm test -- tests/mail-category-filter.test.ts`

Expected: FAIL — `categoryIds` / `categories` undefined on get (skipIf DB unavailable: still update types/contract; note in PR if DB skipped).

- [ ] **Step 3: Implement shared loader + wire get**

Near the listThreads category join in `mail.ts`, extract a helper (same file or `mail-helpers.ts`):

```ts
import { mailCategory, mailThreadCategory } from '../../db/schema/mail.js';

async function loadCategoryIdsByThreadIds(
  db: ReturnType<typeof getDb>,
  transportId: string,
  threadIds: string[],
): Promise<Map<string, string[]>> {
  const categoryIdsByThread = new Map<string, string[]>();
  if (threadIds.length === 0) return categoryIdsByThread;

  const categoryRows = await db
    .select({
      threadId: mailThreadCategory.threadId,
      categoryId: mailThreadCategory.categoryId,
    })
    .from(mailThreadCategory)
    .where(
      and(
        eq(mailThreadCategory.transportId, transportId),
        inArray(mailThreadCategory.threadId, threadIds),
      ),
    );

  for (const row of categoryRows) {
    const existing = categoryIdsByThread.get(row.threadId) ?? [];
    existing.push(row.categoryId);
    categoryIdsByThread.set(row.threadId, existing);
  }
  return categoryIdsByThread;
}

async function loadThreadCategoriesForGet(
  db: ReturnType<typeof getDb>,
  transportId: string,
  threadId: string,
): Promise<{
  categoryIds: string[];
  categories: Array<{
    id: string;
    slug: string;
    name: string;
    color: string | null;
    sortOrder: number;
  }>;
}> {
  const categoryIdsByThread = await loadCategoryIdsByThreadIds(db, transportId, [threadId]);
  const categoryIds = categoryIdsByThread.get(threadId) ?? [];
  if (categoryIds.length === 0) return { categoryIds: [], categories: [] };

  const categories = await db
    .select({
      id: mailCategory.id,
      slug: mailCategory.slug,
      name: mailCategory.name,
      color: mailCategory.color,
      sortOrder: mailCategory.sortOrder,
    })
    .from(mailCategory)
    .where(
      and(eq(mailCategory.transportId, transportId), inArray(mailCategory.id, categoryIds)),
    );

  return { categoryIds, categories };
}
```

Import `mailCategory` in `mail.ts`. Replace the inline listThreads category query with `loadCategoryIdsByThreadIds`. In `get` return, before `return { ... }`:

```ts
      const { categoryIds, categories } = await loadThreadCategoriesForGet(
        db,
        transportId,
        thread.id,
      );

      return {
        // ...existing fields...
        labels: threadLabels,
        drafts,
        categoryIds,
        categories,
      };
```

Also update demo adapter `getDemoThread` to include `categoryIds: []` explicitly if types require it (already has `categories: []`).

- [ ] **Step 4: Run tests**

Run:

```bash
cd apps/server-pilot && pnpm test -- tests/mail-category-filter.test.ts tests/package-contract.test.ts
```

Expected: PASS (or skipIf when no test DB — package-contract must still PASS).

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/src/lib/driver/types.ts apps/server-pilot/tests/mail-category-filter.test.ts apps/server-pilot/tests/package-contract.test.ts apps/mail/lib/demo-data/adapter.ts
git commit -m "$(cat <<'EOF'
feat(server): expose categoryIds and categories on mail.get

EOF
)"
```

---

### Task 4: Live category pills (list + detail + demo dual-path)

**Files:**
- Modify: `apps/mail/types/index.ts`
- Modify: `apps/mail/components/mail/centurion-category-pill.tsx`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Modify: `apps/mail/components/mail/mail-display.tsx`
- Modify: `apps/mail/tests/hotel-folder-presentation.test.ts` (pill dual-path unit if needed)
- Keep: `apps/mail/lib/demo-data/adapter.ts` `centurionCategory` (fallback)

**Interfaces:**
- Consumes: `resolveThreadCategoryPresentation`, `shouldShowHotelCategoryPill`, `getHotelPillColorStyle`, `getHotelFolderPresentation`, `buildCategoryIdToSlugMap`
- Produces: pills visible in live mode from `categoryIds`; demo still works via `centurionCategory` when ids empty

- [ ] **Step 1: Extend types**

In `apps/mail/types/index.ts`:

```ts
export type MailListThreadRow = {
  id: string;
  historyId?: string | null;
  categoryIds?: string[];
  centurionCategory?: CenturionMailCategory;
  latestMessageAt?: string | Date | null;
  isStarred?: boolean;
  receivedOn?: string | Date;
  tags?: Label[];
  threadId?: string;
};
```

- [ ] **Step 2: Rewrite `CenturionCategoryPill`**

Replace `apps/mail/components/mail/centurion-category-pill.tsx` with:

```tsx
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import {
  getHotelFolderPresentation,
  getHotelPillColorStyle,
  isHotelManagedCategorySlug,
  isHotelPrimaryCategorySlug,
  resolveThreadCategoryPresentation,
  shouldShowHotelCategoryPill,
  type HotelManagedSlug,
} from '@/lib/mail/hotel-folder-presentation';
import type { CenturionMailCategory } from '@/types';
import type { CSSProperties } from 'react';

export function CenturionCategoryPill({
  routeFolder,
  category,
  categoryIds,
  idToSlug,
  className,
}: {
  routeFolder: string | undefined;
  /** Demo / legacy fallback when categoryIds empty */
  category?: CenturionMailCategory | undefined;
  categoryIds?: string[];
  idToSlug?: Map<string, string>;
  className?: string;
}) {
  const resolved =
    categoryIds && idToSlug
      ? resolveThreadCategoryPresentation(categoryIds, idToSlug)
      : { primarySlug: null, isUrgent: false, pillSlug: null as HotelManagedSlug | null };

  let pillSlug = resolved.pillSlug;
  let isUrgent = resolved.isUrgent;

  if (!pillSlug && category && isHotelPrimaryCategorySlug(category)) {
    pillSlug = category;
  }

  if (!shouldShowHotelCategoryPill({ routeFolder, pillSlug })) return null;
  if (!pillSlug || !isHotelManagedCategorySlug(pillSlug)) return null;

  const title = getHotelFolderPresentation(pillSlug)?.title ?? pillSlug;
  const palette = getHotelPillColorStyle(pillSlug);

  return (
    <Link
      to={`/mail/${pillSlug}`}
      onClick={(e) => e.stopPropagation()}
      style={
        {
          '--centurion-pill-bg': palette.bg,
          '--centurion-pill-text': palette.text,
          '--centurion-pill-bg-dark': palette.darkBg,
          '--centurion-pill-text-dark': palette.darkText,
        } as CSSProperties
      }
      className={cn(
        'inline-block max-w-[14ch] truncate rounded px-1.5 py-0.5 text-xs font-medium no-underline hover:opacity-90',
        'bg-[var(--centurion-pill-bg)] text-[var(--centurion-pill-text)] dark:bg-[var(--centurion-pill-bg-dark)] dark:text-[var(--centurion-pill-text-dark)]',
        isUrgent &&
          pillSlug !== 'urgent' &&
          "relative after:absolute after:inset-y-0.5 after:right-0 after:w-0.5 after:rounded-l-sm after:bg-red-500/90 after:content-['']",
        className,
      )}
    >
      {title}
    </Link>
  );
}
```

Critical: **remove** `if (!isFrontendOnlyDemo()) return null`.

- [ ] **Step 3: Wire list**

In `mail-list.tsx` Thread component:

- Import `useCategorySettings` and `buildCategoryIdToSlugMap`
- Build map once per row render (or hoist in parent if already available):

```tsx
const categorySettings = useCategorySettings();
const idToSlug = useMemo(
  () => buildCategoryIdToSlugMap(categorySettings),
  [categorySettings],
);

// ...
<CenturionCategoryPill
  routeFolder={folder}
  category={message.centurionCategory}
  categoryIds={message.categoryIds}
  idToSlug={idToSlug}
/>
```

Ensure list query results preserve `categoryIds` onto `MailListThreadRow` (API already returns them — do not strip in mapping). Update memo deps to include `message.categoryIds`.

- [ ] **Step 4: Wire detail**

In `mail-display.tsx` where pill is rendered:

```tsx
const categorySettings = useCategorySettings();
const idToSlug = useMemo(
  () => buildCategoryIdToSlugMap(categorySettings),
  [categorySettings],
);

<CenturionCategoryPill
  routeFolder={folder}
  category={threadData?.centurionCategory}
  categoryIds={threadData?.categoryIds}
  idToSlug={idToSlug}
/>
```

(`folder` from `useParams` if not already in scope.)

- [ ] **Step 5: Run FE tests**

```bash
cd apps/mail && pnpm exec vitest run tests/hotel-folder-presentation.test.ts tests/demo-folder-map.test.ts tests/demo-data.adapter.test.ts
```

Expected: PASS. If `demo-folder-map` still tests old `shouldShowCenturionCategoryPill`, leave that helper intact for demo or update tests to `shouldShowHotelCategoryPill`.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/types/index.ts apps/mail/components/mail/centurion-category-pill.tsx apps/mail/components/mail/mail-list.tsx apps/mail/components/mail/mail-display.tsx
git commit -m "$(cat <<'EOF'
feat(mail): show live category pills from categoryIds

EOF
)"
```

---

### Task 5: Demote Labels — real collapsible, title fix

**Files:**
- Modify: `apps/mail/components/ui/nav-main.tsx`

**Interfaces:**
- Consumes: existing `Collapsible`, `SidebarLabels`, `isFrontendOnlyDemo`
- Produces: section always titled `Labels`; `defaultOpen={false}` with **Trigger + Content** (today Collapsible wraps always-visible children — `defaultOpen` is a no-op)

- [ ] **Step 1: Confirm bug**

Open `nav-main.tsx` ~286–314: Collapsible has no `CollapsibleTrigger` / `CollapsibleContent`. Fixing title alone is incomplete.

- [ ] **Step 2: Implement Labels section**

Update imports:

```ts
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronRight, Plus } from 'lucide-react';
```

Replace the labels block with:

```tsx
        {!pathname.includes('/settings') &&
          !isBottomNav &&
          state !== 'collapsed' &&
          !isFrontendOnlyDemo() && (
          <Collapsible defaultOpen={false} className="group/collapsible flex-col">
            <SidebarMenuItem className="mb-4" style={{ height: 'auto' }}>
              <div className="mx-2 mb-2 flex items-center justify-between">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[13px] dark:text-[#898989]"
                  >
                    <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    Labels
                  </button>
                </CollapsibleTrigger>
                {activeAccount?.providerId === 'google' ? (
                  <LabelDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="mr-1 h-4 w-4 p-0 hover:bg-transparent"
                      >
                        <Plus className="text-muted-foreground h-3 w-3 dark:text-[#898989]" />
                      </Button>
                    }
                    onSubmit={onSubmit}
                  />
                ) : null}
              </div>

              <CollapsibleContent>
                {activeAccount ? <SidebarLabels data={userLabels ?? []} /> : null}
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        )}
```

Never use provider ternary that titles mailbox as `"Folders"`.

- [ ] **Step 3: Manual smoke** (no unit harness for this JSX)

Verify in browser: Labels collapsed by default; expand shows labels; hotel Folders section still above; no second “Folders” heading.

- [ ] **Step 4: Commit**

```bash
git add apps/mail/components/ui/nav-main.tsx
git commit -m "$(cat <<'EOF'
fix(mail): demote Labels with real collapsed collapsible

EOF
)"
```

---

### Task 6: CategoryDropdown chips share presentation map

**Files:**
- Modify: `apps/mail/components/mail/mail.tsx` (`CategoryDropdown`)
- Modify: `apps/mail/tests/search-filter-contract.test.ts`

**Interfaces:**
- Consumes: `getHotelFolderPresentation`, `getHotelPillColorStyle`, `isHotelManagedCategorySlug` from Task 1; `useCategorySettings` still supplies UUID `id` for toggles
- Produces: chip label/dot colors match sidebar; selection still `categoryIds`

- [ ] **Step 1: Add contract assertion for display helper**

In `apps/mail/tests/search-filter-contract.test.ts`:

```ts
import { getHotelFolderPresentation, getHotelPillColorStyle } from '@/lib/mail/hotel-folder-presentation';

it('hotel chip display uses presentation title for managed slug', () => {
  expect(getHotelFolderPresentation('travel-agents')?.title).toBe('Travel Agents');
  expect(getHotelPillColorStyle('travel-agents').bg).toBe('#EDE9FE');
});
```

Keep existing tests that assert `filters.categoryIds` not `labelIds`.

- [ ] **Step 2: Run — should already pass after Task 1**

Run: `cd apps/mail && pnpm exec vitest run tests/search-filter-contract.test.ts`

- [ ] **Step 3: Update CategoryDropdown rendering**

In `mail.tsx` CategoryDropdown item render, replace name/color dots:

```tsx
import {
  getHotelFolderPresentation,
  getHotelPillColorStyle,
  isHotelManagedCategorySlug,
} from '@/lib/mail/hotel-folder-presentation';

// inside map:
const slug = category.slug;
const presentation = slug ? getHotelFolderPresentation(slug) : null;
const displayName = presentation?.title ?? category.name;
const dotColor =
  slug && isHotelManagedCategorySlug(slug)
    ? getHotelPillColorStyle(slug).text
    : category.color;

// ...
{dotColor ? (
  <span
    className="h-2.5 w-2.5 shrink-0 rounded-full"
    style={{ backgroundColor: dotColor }}
    aria-hidden
  />
) : null}
<span className="text-foreground font-medium">
  {displayName}
</span>
```

Do **not** change `handleCategoryChange` / `toggleCategoryId` — still UUID ids.

- [ ] **Step 4: Run filter contract tests**

```bash
cd apps/mail && pnpm exec vitest run tests/search-filter-contract.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mail/components/mail/mail.tsx apps/mail/tests/search-filter-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): align category chips with hotel presentation map

EOF
)"
```

---

### Task 7: DB-hex consumer audit (live surfaces)

**Files:**
- Grep-driven under `apps/mail`
- Likely touch: none beyond Task 2/6 if audit clean; optionally light note in PR

**Interfaces:**
- Consumes: presentation map
- Produces: checklist — every live managed-slug color consumer fixed or explicitly deferred

- [ ] **Step 1: Grep**

```bash
cd apps/mail && rg -n "category\\.color|categoryColorNavTheme|getCenturionCategoryColorStyle" --glob '!node_modules'
```

Expected hits after Tasks 2–6:

| Hit | Action |
|-----|--------|
| `config/navigation.ts` demo path / unknown slug hex | OK — managed uses presentation |
| `mail.tsx` CategoryDropdown | OK after Task 6 |
| `hooks/use-categories.ts` passes color through | OK — raw data; consumers decide |
| `app-sidebar.tsx` passes `color` into nav builder | OK — Task 2 ignores for managed |
| `centurion-category-pill.tsx` | OK — presentation colors |
| Settings categories page (if disabled) | **Defer** — document in PR |

- [ ] **Step 2: Fix any remaining live managed-slug solid-hex UI** found by grep (none expected). If a visible live surface remains, route it through `getHotelPillColorStyle` / `getHotelFolderNavTheme`.

- [ ] **Step 3: Final verification suite**

```bash
cd apps/mail && pnpm exec vitest run tests/hotel-folder-presentation.test.ts tests/search-filter-contract.test.ts tests/demo-folder-map.test.ts tests/demo-data.adapter.test.ts
cd apps/server-pilot && pnpm test -- tests/package-contract.test.ts tests/mail-category-filter.test.ts
```

Expected: all PASS (DB tests may skipIf).

Manual smoke:

1. Live Folders: long titles, subtitles, pastels, urgent stripe
2. Inbox list pills + open thread pills
3. Labels collapsed, titled Labels
4. Chips match sidebar names
5. `FORCE_FRONTEND_ONLY_DEMO` still false

- [ ] **Step 4: Commit** only if audit changed files

```bash
git add -A apps/mail apps/server-pilot
git commit -m "$(cat <<'EOF'
chore(mail): complete hotel folder hex consumer audit

EOF
)"
```

---

## Self-review (spec coverage)

| Spec requirement | Task |
|------------------|------|
| R1 live categories.list + categoryIds routes | 2 (nav), existing filter path |
| R2 titles/subtitles/pastels/urgent stripe | 1–2 |
| R3 live pills + route hide | 1, 4 |
| R4 Labels demote + real collapse | 5 |
| R5 chip alignment | 6 |
| R6 spam system / urgent overlay | 1 resolve rules, 2 no spam inject |
| R7 no triage/seed changes | Global Constraints |
| R8 get categoryIds + categories | 3 |
| R9 demo dual-path | 4 fallback to centurionCategory |
| R10 no third SoT for slug sets | 1 comment-locked constants |
| Theme precedence bug | 2 test |
| U5 hex audit | 7 |
| Stale triage via poll | Global Constraints (no new WS) |

**Placeholder scan:** none intentionally left.

**Type consistency:** `categoryIds: string[]` on list + get + `MailListThreadRow`; `categories: MailCategory[]` on get; `pillSlug: HotelManagedSlug | null` from resolve helper.

---

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development (+ overnight-autonomous-zero overlay above). Do not ask "which approach?"

Handoff report path when wave completes: `docs/superpowers/plans/handoff-reports/2026-07-23-hotel-folder-ui-parity.md`
