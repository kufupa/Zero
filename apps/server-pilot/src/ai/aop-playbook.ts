/**
 * AOP-1 Quote spine as typed playbook data — not a HotelPolicy settings form.
 * Clustered staff rules injected into analyse / prefill / draft. HMS writes stay off.
 * No PII. No corpus dump.
 */

export const AOP_QUOTE_ID = 'AOP-1' as const;

export type AopQuoteChannel = 'direct' | 'agent' | 'ota' | 'system';

export type AopQuoteRatePlan = {
  source: 'party_contract' | 'public_bar' | 'skip';
  staffLabel: string;
  skipQuote: boolean;
  skipReason: 'ota' | 'system' | null;
};

export type AopQuoteDelivery = {
  humanApprovalRequired: true;
  draftDelivery: 'unsent_draft';
  autoSend: false;
  hmsWrites: false;
};

export type AopQuoteSpine = {
  id: typeof AOP_QUOTE_ID;
  workflow: 'quote';
  partyContractBeforeBar: true;
  humanApprovalRequired: true;
  draftDelivery: 'unsent_draft';
  autoSend: false;
  hmsWrites: false;
  skipOta: true;
};

export const AOP_QUOTE_SPINE: AopQuoteSpine = {
  id: AOP_QUOTE_ID,
  workflow: 'quote',
  partyContractBeforeBar: true,
  humanApprovalRequired: true,
  draftDelivery: 'unsent_draft',
  autoSend: false,
  hmsWrites: false,
  skipOta: true,
};

export type AopPartyHint = {
  kind: 'agency' | 'organization' | 'government' | 'private' | null;
  name: string | null;
};

/** Company / agency / government with a name is a bound party. Private or unnamed is not. */
export function isAopPartyBound(party: AopPartyHint): boolean {
  return Boolean(party.name?.trim()) && party.kind !== null && party.kind !== 'private';
}

/** Pre-AOP baseline: every quote is labelled public/BAR. */
export function baselineQuoteRatePlan(): AopQuoteRatePlan {
  return {
    source: 'public_bar',
    staffLabel: 'public rate (BAR)',
    skipQuote: false,
    skipReason: null,
  };
}

export function aopQuoteDelivery(): AopQuoteDelivery {
  return {
    humanApprovalRequired: true,
    draftDelivery: 'unsent_draft',
    autoSend: false,
    hmsWrites: false,
  };
}

/**
 * AOP-1 rate-plan rule: contract when the party binds; else BAR, and say "public rate".
 * OTA / system mail is skipped (no hotel quote).
 */
export function decideAopQuoteRatePlan(input: {
  partyBound: boolean;
  channel?: AopQuoteChannel;
}): AopQuoteRatePlan {
  if (input.channel === 'ota' || input.channel === 'system') {
    return {
      source: 'skip',
      staffLabel: 'skip OTA/system — no hotel quote',
      skipQuote: true,
      skipReason: input.channel,
    };
  }
  if (input.partyBound) {
    return {
      source: 'party_contract',
      staffLabel: 'party contract',
      skipQuote: false,
      skipReason: null,
    };
  }
  return {
    source: 'public_bar',
    staffLabel: 'public rate',
    skipQuote: false,
    skipReason: null,
  };
}

export function aopQuoteInstructions(): string {
  return [
    'AOP-1 Quote spine (staff playbook, not a settings form):',
    '- Identify sender/party → HMS profile → contract → rate plan BEFORE BAR.',
    '- Bound party (company, agency, government): use the party contract; never label that rate public or BAR.',
    '- No party bind: BAR, and say "public rate".',
    '- Skip OTA and system-channel mail; do not quote those.',
    '- Human approval required. Save an unsent draft. Never auto-send. HMS writes stay off.',
  ].join('\n');
}

export function aopQuoteDraftClauses(partyBound: boolean): string[] {
  const rate = decideAopQuoteRatePlan({ partyBound });
  return [
    `Rate plan: ${rate.staffLabel}.`,
    'This is an unsent draft for staff review. Nava never sends mail. HMS writes stay off.',
  ];
}

const PARTY_FACT_KEY = /party|organisation|organization|agency|company/i;

export function partyBoundFromFacts(
  facts: ReadonlyArray<{ key: string; status?: string; authority?: string; value?: unknown }>,
): boolean {
  return facts.some(
    (fact) =>
      PARTY_FACT_KEY.test(fact.key) &&
      fact.status === 'known' &&
      fact.authority === 'authorized' &&
      fact.value != null &&
      String(fact.value).trim() !== '',
  );
}
