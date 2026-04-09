import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/** Per-thread: user has opened AI draft in edit mode in this session (frontend-only demo). */
export const demoAiDraftReviewedAtomFamily = atomFamily((_threadId: string) => atom(false));
