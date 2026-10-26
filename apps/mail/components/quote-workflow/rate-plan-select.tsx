import {
  Field,
  paneFieldClass,
} from '@/components/nava-pane/pane-ui';
import type {
  RatePlanBoard,
  RatePlanCatalogueEntry,
  RateOption,
} from '@/lib/quote-workflow/types';

export type RatePlanCategory = 'public' | 'contract' | 'government' | 'other';
export type RatePlanChoice = RatePlanCatalogueEntry & {
  category: RatePlanCategory;
  readByNava: boolean;
};

const RATE_OPTION_BOARD: Record<RateOption['board'], RatePlanBoard> = {
  room_only: 'room_only',
  bb: 'bed_breakfast',
  dinner_bb: 'dinner_bed_breakfast',
};

function ratePlanCategory(entry: RatePlanCatalogueEntry): RatePlanCategory {
  if (entry.event) return 'other';
  if (entry.government) return 'government';
  if (entry.contract) return 'contract';
  return 'public';
}

/** Add HMS-only codes without treating their labels or flags as static catalogue facts. */
export function ratePlanChoices(
  catalogue: readonly RatePlanCatalogueEntry[],
  hmsOptions: readonly RateOption[],
): RatePlanChoice[] {
  const readByNavaCodes = new Set(
    hmsOptions.map((option) => option.rateCode.trim().toUpperCase()).filter(Boolean),
  );
  const choices = new Map<string, RatePlanChoice>();
  for (const entry of catalogue) {
    const code = entry.code.trim().toUpperCase();
    if (code) {
      choices.set(code, {
        ...entry,
        code,
        category: ratePlanCategory(entry),
        readByNava: readByNavaCodes.has(code),
      });
    }
  }
  for (const option of hmsOptions) {
    const code = option.rateCode.trim().toUpperCase();
    if (!code || choices.has(code)) continue;
    const event = option.hint === 'event_rate';
    choices.set(code, {
      code,
      name: code,
      board: RATE_OPTION_BOARD[option.board],
      ...(event ? { event: true } : {}),
      ...(option.contract ? { contract: true } : {}),
      category: event ? 'other' : option.contract ? 'contract' : 'other',
      readByNava: true,
    });
  }
  return [...choices.values()];
}

export function filteredRateOptions(
  options: RateOption[],
  selectedPlan: string,
  choices: RatePlanChoice[],
): RateOption[] {
  if (selectedPlan === 'all') return options;
  if (selectedPlan === 'government' || selectedPlan === 'public') {
    // Public (BAR) is every code that is not a government code, so it still filters with no catalogue.
    const governmentCodes = new Set(
      choices.filter((choice) => choice.category === 'government').map((choice) => choice.code),
    );
    // No government category is known (the catalogue query failed, or HMS-only codes): the search already
    // priced under Government, so show what HMS returned instead of hiding every rate.
    if (selectedPlan === 'government' && governmentCodes.size === 0) return options;
    const wantGovernment = selectedPlan === 'government';
    return options.filter(
      (option) => governmentCodes.has(option.rateCode.trim().toUpperCase()) === wantGovernment,
    );
  }
  const selected = selectedPlan.toUpperCase();
  return options.filter((option) => option.rateCode.trim().toUpperCase() === selected);
}

/** Rate plan filters returned options. Contract eligibility still comes only from each HMS result. */
export function RatePlanSelect({
  ratePlans,
  ratePlan,
  onRatePlanChange,
}: {
  ratePlans: RatePlanChoice[];
  ratePlan: string;
  onRatePlanChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Showing rates for" htmlFor="quote-rate-plan">
        <select
          id="quote-rate-plan"
          aria-label="Rate plan"
          className={paneFieldClass}
          value={ratePlan}
          onChange={(event) => onRatePlanChange(event.target.value)}
        >
          <option value="all">All rates</option>
          {(['public', 'contract', 'government', 'other'] as const).map((category) => {
            const plans = ratePlans
              .filter((entry) => entry.category === category)
              .sort((left, right) => Number(right.readByNava) - Number(left.readByNava));
            // Public (BAR) and government keep their "All" choice even when the catalogue is down.
            if (!plans.length && category !== 'government' && category !== 'public') return null;
            const label = category === 'other' ? 'Other HMS rates' : `${category[0]!.toUpperCase()}${category.slice(1)}`;
            return (
              <optgroup key={category} label={label}>
                {category === 'public' ? <option value="public">All public rates (BAR)</option> : null}
                {category === 'government' ? <option value="government">All government rates</option> : null}
                {plans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name === plan.code ? plan.code : `${plan.code}: ${plan.name}`}
                    {plan.readByNava ? ' (read by Nava)' : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <span className="mt-0.5 block text-[13px] font-normal text-[#64748b]">
          All rates shows every code HMS returned. Choosing a plan filters the cards below.
        </span>
      </Field>
    </div>
  );
}
