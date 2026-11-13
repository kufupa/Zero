export function normalizeRequestedMealPlan(value: unknown): {
  mealPlan: 'room_only' | 'bb' | 'dinner_bb' | null;
  lunchRequested: boolean;
} {
  const phrase = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalized = phrase.replace(/[,\s&_-]+/gu, ' ').replace(/\b(?:and|for all)\b/gu, '').replace(/\s+/gu, ' ').trim();
  const lunchRequested = /\blunch\b/u.test(normalized);
  const board = normalized.replace(/\blunch\b/gu, '').replace(/\s+/gu, ' ').trim();
  if (['room only', 'roomonly', 'ro', 'room only r'].includes(board)) return { mealPlan: 'room_only', lunchRequested };
  if (['dbb', 'dinner bb', 'dinner b b'].includes(board) || /\bdinner\b/u.test(board) && /\b(?:breakfast|bb)\b/u.test(board)) {
    return { mealPlan: 'dinner_bb', lunchRequested };
  }
  if (['bb', 'b b'].includes(board) || /\bbreakfast\b/u.test(board)) return { mealPlan: 'bb', lunchRequested };
  return { mealPlan: null, lunchRequested };
}
