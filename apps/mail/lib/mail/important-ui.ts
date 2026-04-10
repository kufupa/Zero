type TagLike = {
  name?: string | null;
};

type MessageLike = {
  tags?: ReadonlyArray<TagLike> | null;
};

const normalizeTagName = (name: string) => name.trim().toLowerCase().replace(/^category_/, '');

export function hasImportantTag(tags?: ReadonlyArray<TagLike> | null): boolean {
  if (!tags?.length) return false;

  return tags.some((tag) => normalizeTagName(tag?.name ?? '') === 'important');
}

export function resolveImportantState({
  optimisticImportant,
  latestTags,
  messages,
}: {
  optimisticImportant?: boolean | null;
  latestTags?: ReadonlyArray<TagLike> | null;
  messages?: ReadonlyArray<MessageLike> | null;
}): boolean {
  if (typeof optimisticImportant === 'boolean') {
    return optimisticImportant;
  }

  if (hasImportantTag(latestTags)) {
    return true;
  }

  return messages?.some((message) => hasImportantTag(message?.tags)) ?? false;
}
