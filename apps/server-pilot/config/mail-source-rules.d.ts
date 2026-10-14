export type MailSourceRuleData = {
  readonly id: string;
  readonly kind: 'channel' | 'system';
  readonly source: string;
  readonly domains: readonly string[];
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
};

export declare const MAIL_SOURCE_RULE_DATA: readonly MailSourceRuleData[];
