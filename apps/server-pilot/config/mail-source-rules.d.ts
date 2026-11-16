export type MailSourceRuleData = {
  readonly id: string;
  readonly kind: 'channel' | 'system';
  readonly source: string;
  readonly domains: readonly string[];
  /** Owner-listed skip hosts match only the exact sender host; subdomains stay direct. */
  readonly exactHost?: boolean;
  readonly forwardedSubjectPatterns?: readonly {
    readonly source: string;
    readonly flags: string;
  }[];
  readonly otaChip?: boolean;
  readonly bookingPhrase?: string;
  readonly directSubjectPatterns?: readonly {
    readonly source: string;
    readonly flags: string;
  }[];
  readonly skipSubjectPatterns?: readonly {
    readonly source: string;
    readonly flags: string;
  }[];
  /** Envelope gate: the sender address must match one pattern or the mail stays direct. */
  readonly senderPatterns?: readonly {
    readonly source: string;
    readonly flags: string;
  }[];
  /** Evidence gate: every pattern must match the body or the mail stays direct. */
  readonly skipBodyPatterns?: readonly {
    readonly source: string;
    readonly flags: string;
  }[];
  /** Evidence gate: skip only when the caller confirms no non-inline attachment. */
  readonly requiresNoAttachments?: boolean;
  /** A human-forwarded copy of this source stays staff-visible; the skip only applies to direct send. */
  readonly directWhenForwarded?: boolean;
};

export declare const MAIL_SOURCE_RULE_DATA: readonly MailSourceRuleData[];

export type RoutineNoticeExclusionData = {
  readonly id: string;
  readonly kind: 'system';
  readonly source: string;
  /** Anchored envelope sender pattern; forwards keep authored asks visible. */
  readonly senderPattern: { readonly source: string; readonly flags: string };
  /** Anchored subject pattern for the routine notice. */
  readonly subjectPattern: { readonly source: string; readonly flags: string };
  /**
   * Set for notices a person can reply to or forward: the exclusion then
   * applies only to an unannotated re-send (no authored content, unchanged
   * forwarded subject), keeping current staff asks reviewable.
   */
  readonly humanOrigin?: boolean;
};

export declare const ROUTINE_NOTICE_EXCLUSION_DATA: readonly RoutineNoticeExclusionData[];
