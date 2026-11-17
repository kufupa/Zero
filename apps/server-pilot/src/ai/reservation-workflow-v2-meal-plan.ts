export function normalizeRequestedMealPlan(value: unknown): {
  mealPlan: 'room_only' | 'bb' | 'dinner_bb' | null;
  lunchRequested: boolean;
} {
  const phrase = typeof value === 'string' ? value.trim().toLowerCase().replace(
    /\b(?:don|doesn|didn|won|wouldn|shouldn|isn|aren|wasn|weren|hasn|haven|hadn|can|couldn|mustn)['’]t\b/gu, 'not') : '';
  const exclusions = new Set<string>();
  const positive = phrase.replace(/[,+\s&/_-]+/gu, ' ').replace(
    /\b(?:no(?:\s+(?:need|requirement|request)(?:\s+for)?)?|without|excluding|exclude|(?:not|never)(?:\s+(?:including|need|require|want|request|include|provide|have))?)\s+(?:(?:any|the)\s+)?(?:breakfast|lunch|dinner|meals?)(?:\s+(?:(?:and|or)\s+)?(?:breakfast|lunch|dinner|meals?))*/gu,
    clause => {
      for (const meal of clause.match(/\b(?:breakfast|lunch|dinner|meals?)\b/gu) ?? []) exclusions.add(meal);
      return ' ';
    });
  const normalized = positive.replace(/\b(?:and|for all)\b/gu, '').replace(/\s+/gu, ' ').trim();
  const allMealsExcluded = exclusions.has('meal') || exclusions.has('meals');
  const lunchDeclined = /\blunch\s+(?:(?:is|was|will|would|should|must|may|can|could)\s+(?:be\s+)?)?(?:not|never)\s+(?:be\s+)?(?:required|needed|necessary|wanted|requested|included|provided)\b|\b(?:not|never)\s+(?:require|need|want|request|include|provide|have)\s+lunch\b/u.test(normalized);
  const lunchRequested = /\blunch\b/u.test(normalized) && !exclusions.has('lunch') && !allMealsExcluded && !lunchDeclined;
  if (/\b(?:no|not|never|without|excluding|exclude|except|skip(?:ped|ping)?)\b/u.test(positive)) return { mealPlan: null, lunchRequested };
  if (/\b(?:no|not|never|without|excluding|exclude|except)\b[^;]*\bsupper\b/u.test(phrase))
    return { mealPlan: null, lunchRequested };
  if (/\b(?:breakfast|lunch|dinner|supper|bb|b b|dbb)\b[^;]*\bor\b[^;]*\b(?:breakfast|lunch|dinner|supper|bb|b b|dbb)\b/u.test(normalized))
    return { mealPlan: null, lunchRequested };
  const board = normalized.replace(/\b(?:lunch|with|plus|including)\b/gu, '').replace(/\s+/gu, ' ').trim();
  if (/\bsupper\b/u.test(board) && !['breakfast supper', 'supper breakfast', 'bb supper', 'supper bb', 'b b supper', 'supper b b'].includes(board))
    return { mealPlan: null, lunchRequested };
  const breakfast = /\b(?:breakfast|bb|b b|dbb)\b/u.test(board), dinner = /\b(?:dinner|supper|dbb)\b/u.test(board);
  if ((allMealsExcluded || exclusions.has('breakfast')) && breakfast || (allMealsExcluded || exclusions.has('dinner')) && dinner)
    return { mealPlan: null, lunchRequested };
  if (['room only', 'roomonly', 'ro', 'room only r'].includes(board)) return { mealPlan: 'room_only', lunchRequested };
  if (['dbb', 'dinner bb', 'dinner b b', 'supper bb', 'supper b b'].includes(board) || /\b(?:dinner|supper)\b/u.test(board) && /\b(?:breakfast|bb)\b/u.test(board)) {
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
