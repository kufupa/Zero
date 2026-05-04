import { isbot } from 'isbot';
import { isFrontendOnlyDemo } from './runtime';

type WaitDecisionInput = {
  userAgent: string | null;
  isSpaMode: boolean;
  env?: {
    VITE_PUBLIC_MAIL_API_MODE?: string;
    VITE_ZERO_DEMO_MODE?: string;
    VITE_FRONTEND_ONLY?: string;
  };
};

export function shouldWaitForAllReady(input: WaitDecisionInput): boolean {
  if (isFrontendOnlyDemo(input.env)) {
    return false;
  }

  return (input.userAgent ? isbot(input.userAgent) : false) || input.isSpaMode;
}
