export function normalizeRequestedMealPlan(value: unknown): {
  mealPlan: 'room_only' | 'bb' | 'dinner_bb' | null;
  lunchRequested: boolean;
} {
  const phrase = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalized = phrase.replace(/[,+\s&_-]+/gu, ' ').replace(/\b(?:and|for all)\b/gu, '').replace(/\s+/gu, ' ').trim();
  const lunchRequested = /\blunch\b/u.test(normalized);
  const board = normalized.replace(/\b(?:lunch|with|plus|including)\b/gu, '').replace(/\s+/gu, ' ').trim();
  if (['room only', 'roomonly', 'ro', 'room only r'].includes(board)) return { mealPlan: 'room_only', lunchRequested };
  if (['dbb', 'dinner bb', 'dinner b b'].includes(board) || /\bdinner\b/u.test(board) && /\b(?:breakfast|bb)\b/u.test(board)) {
    return { mealPlan: 'dinner_bb', lunchRequested };
  }
  if (['bb', 'b b'].includes(board) || /\bbreakfast\b/u.test(board)) return { mealPlan: 'bb', lunchRequested };
  return { mealPlan: null, lunchRequested };
}

export function isLunchOnlyMealRequest(value: string): boolean {
  const phrase = value.trim().toLowerCase().replace(/[,+\s&_-]+/gu, ' ').trim();
  return /^(?:with )?lunch(?: only)?(?: for all(?: guests| rooms)?)?$/u.test(phrase);
}

export function quoteLunchHintScope(input: {
  hint: { raw: string; value: unknown };
  mealHints: Array<{ raw: string; value: unknown }>;
  groupCount: number;
}): 'repeated_meal_plan' | 'overall' | 'unresolved' {
  const key = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const keys = (claim: { raw: string; value: unknown }) => [claim.raw, typeof claim.value === 'string' ? claim.value : '']
    .map(key).filter(Boolean);
  const hintKeys = keys(input.hint);
  const hintRaw = key(input.hint.raw);
  const meal = normalizeRequestedMealPlan(input.hint.raw);
  if (meal.lunchRequested && meal.mealPlan && input.mealHints.some(claim => key(claim.raw) === hintRaw))
    return 'repeated_meal_plan';
  const text = hintKeys.join(' ');
  return input.groupCount === 1 || /\b(?:all|each|every|both)\s+(?:(?:the|of the)\s+)?(?:guests?|rooms?|groups?|participants?|people)\b|\beveryone\b/u.test(text)
    ? 'overall' : 'unresolved';
}
