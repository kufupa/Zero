import type { TriageOutput } from '../triage.js';

export function scoreCategoryMatch(input: {
  expectedCategory: string;
  actual: TriageOutput;
}): { id: string; pass: boolean; score: number } {
  const pass = input.actual.category === input.expectedCategory;
  return {
    id: 'category-match',
    pass,
    score: pass ? 1 : 0,
  };
}

export function scoreUrgentMatch(input: {
  expectedUrgent: boolean;
  actual: TriageOutput;
}): { id: string; pass: boolean; score: number } {
  const pass = input.actual.urgent === input.expectedUrgent;
  return {
    id: 'urgent-match',
    pass,
    score: pass ? 1 : 0,
  };
}
