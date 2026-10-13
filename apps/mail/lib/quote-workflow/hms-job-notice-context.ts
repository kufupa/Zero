import { createContext, useContext } from 'react';
import type { HmsJobQueueOptions, HmsJobRequest, HmsJobTransport, HmsJobView } from './amend-find';

export type HmsJobNoticeInput = {
  observerId: string;
  jobId: string;
  request: HmsJobRequest;
  options?: HmsJobQueueOptions;
  retryOptions?: HmsJobQueueOptions;
  targetId?: string;
  retry: () => void;
  transport: HmsJobTransport | null;
  runId?: string | null;
};

export type HmsJobNoticeEmail = {
  emailKey: string | null;
  emailSubject: string | null;
};

export type HmsJobNoticeReporter = {
  setCurrentEmail: (email: HmsJobNoticeEmail) => void;
  started: (input: HmsJobNoticeInput) => void;
  pending: (input: HmsJobNoticeInput) => void;
  settled: (observerId: string, jobId: string, view: HmsJobView, retry: () => void) => void;
  queueFailed: (observerId: string, jobId: string, retry: () => void) => void;
  detached: (observerId: string) => void;
  cancel: (observerId: string, jobId: string) => void;
  dismiss: (noticeId: string) => void;
  retryNotice: (noticeId: string) => void;
};

const EMPTY_REPORTER: HmsJobNoticeReporter = {
  setCurrentEmail: () => undefined,
  started: () => undefined,
  pending: () => undefined,
  settled: () => undefined,
  queueFailed: () => undefined,
  detached: () => undefined,
  cancel: () => undefined,
  dismiss: () => undefined,
  retryNotice: () => undefined,
};

export const HmsJobNoticeReporterContext = createContext(EMPTY_REPORTER);

export function useHmsJobNoticeReporter(): HmsJobNoticeReporter {
  return useContext(HmsJobNoticeReporterContext);
}
