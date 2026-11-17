const failures = {
  BEDROCK_TRANSIENT: {
    happened: "Nava's email-reading service is temporarily unavailable.",
    next: 'Wait a moment, then retry this step. Your saved edits are kept.',
  },
  ARTIFACT_TRANSIENT: {
    happened: 'Nava could not load or create a file needed for this step.',
    next: 'Check which files are available, then retry the missing file.',
  },
  AUDIT_CAPTURE: {
    happened: 'Nava could not record the evidence needed to verify this step.',
    next: 'Contact Nava support before continuing.',
  },
  STAFF_QUOTE_ACTIVE: {
    happened: 'Infor is in use.',
    next: 'Wait for the current action to finish, then try again.',
  },
  HMS_LOCK_BUSY: {
    happened: 'Infor is in use.',
    next: 'Wait for the current action to finish, then try again.',
  },
  refused_lock_busy: {
    happened: 'Infor is in use.',
    next: 'Wait for the current action to finish, then try again.',
  },
  HMS_CREDENTIAL_LEASE_CONTENDED: {
    happened: 'Infor is busy.',
    next: 'Please try again.',
  },
  WORKER_SHUTDOWN: {
    happened: 'Nava restarted before this step finished.',
    next: 'Refresh the email to check the latest status before continuing.',
  },
  HMS_OUTAGE: {
    happened: 'Infor is temporarily unavailable.',
    next: 'Wait for Infor to recover, then check the latest status before continuing.',
  },
  UNKNOWN: {
    happened: 'Nava could not confirm that this step finished.',
    next: 'Refresh the email to check the latest status. Contact Nava support if it remains unclear.',
  },
} as const;

export function knownFailureCopy(code: unknown, writeOutcomeUncertain = false): string | undefined {
  if (typeof code !== 'string' || !Object.hasOwn(failures, code)) return undefined;
  const failure = failures[code as keyof typeof failures];
  return `${failure.happened} ${writeOutcomeUncertain
    ? 'Check the outcome in Infor or contact Nava support before trying to save again.'
    : failure.next}`;
}

export function staffFailureCopy(code: unknown, writeOutcomeUncertain = false): string {
  return knownFailureCopy(code, writeOutcomeUncertain) ?? knownFailureCopy('UNKNOWN', writeOutcomeUncertain)!;
}
