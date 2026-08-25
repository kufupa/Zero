import type { ParsedMessage } from '@/types';
import {
  isPitchDemoEnabled,
  PITCH_DEMO_SENDER_EMAIL,
  pitchDemoThreadIdOverride,
  type PitchDemoEnv,
} from './config';

export type PitchDemoThreadInput = {
  threadId?: string | null;
  messages?: ParsedMessage[] | null;
};

function normalizeEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

function messageFromPitchDemoSender(message: ParsedMessage): boolean {
  return normalizeEmail(message.sender?.email) === PITCH_DEMO_SENDER_EMAIL;
}

function messageMatchesPitchDemo(message: ParsedMessage): boolean {
  if (!messageFromPitchDemoSender(message)) return false;
  const haystack = `${message.subject ?? ''}\n${message.body ?? ''}\n${message.decodedBody ?? ''}`.toLowerCase();
  return (
    haystack.includes('26 august') ||
    haystack.includes('quotation') ||
    haystack.includes('bed and breakfast')
  );
}

export function isPitchDemoThread(
  input: PitchDemoThreadInput,
  env?: PitchDemoEnv,
): boolean {
  if (!isPitchDemoEnabled(env)) return false;

  const overrideThreadId = pitchDemoThreadIdOverride(env);
  if (overrideThreadId && input.threadId === overrideThreadId) {
    return true;
  }

  const messages = input.messages ?? [];
  if (messages.length === 0) return false;

  return messages.some(messageMatchesPitchDemo);
}
