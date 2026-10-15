# Revenue Model & Financial Logic — Stage A Inputs

**Phase:** Startup-design research / financial groundwork
**Project:** insurance-shopping-agent
**Date:** 2026-09-30
**Confidence:** High that these models exist in market; Low that any is viable for this startup.

---

## Core answer: why consumer comparison can be free

The consumer often is not the payer. Existing businesses fund shopping through:

1. **Carrier/agency commission after a policy is bound** (licensed agency/broker model).
2. **Provider-paid lead/referral revenue** (qualified clicks, forms/data or calls can be billable before a policy binds).
3. **Embedded distribution economics** (carrier/agency shares an agreed amount with a platform that supplies distribution).
4. **B2B workflow software/API fees** (the business pays for time saved, additional eligible binds, or embedded quote access).

Free does not mean costless: incumbent advertising and distribution spend is large, while legal/appointment, carrier integrations, quotes/data, customer support, payment/servicing and compliance can all cost money.

## Scenario comparison

| Model | Revenue formula | What buyer pays for | Public evidence | Unknowns / gating risks |
|---|---|---|---|---|
| Licensed consumer agency | Bound eligible policies × contractual net commission per policy + verified renewals | New customer acquisition/policy placement and potentially servicing | Jerry, Insurify, The Zebra, Nsure and Policygenius describe commission models | License/entity/appointments, quote/bind rights, actual commission, clawbacks, CAC, conversion and renewal rights |
| Provider-paid lead/referral | Accepted billable qualified events × contract price per event (or click/call) | Compliant, incremental and eligible inquiries | EverQuote FY2025 $692.5M revenue; SEC describes sold qualified inquiries; LendingTree FY2025 Insurance $711.9M | Exact lead pricing, rejection, duplicate, resale, consent, buyer concentration, state-specific restrictions; per-bind payment may be impermissible in some contexts |
| B2B agency SaaS/API | Accounts × subscription + usage + onboarding | Reduced handling time, higher throughput, fewer errors or additional binds | Canopy: $100/mo and $250/mo published tiers; FurtherAI and other YC entrants target workflows | Existing vendor systems, security/E&O, agency willingness to pay, time saved, accuracy, churn, implementation costs |
| Embedded partner | Eligible incremental bound policies × contractual share OR permitted fixed/API/usage fees | Access to a context-specific audience and completed transaction | Insurify partner APIs/white-label; Experian/Gabi; auto dealership examples | Procurement cycles, attribution, existing insurer restrictions, consumer consent, partner leverage and legal/compensation structure |
| Consumer subscription | Paying households × subscription | Ongoing management/service beyond shopping | No credible evidence found of broad paid subscription for basic comparison | Strong free alternatives, low shopping frequency, willingness-to-pay unknown; don't assume |

## Stage A model — formula, not forecast

No projections are produced yet. The founder intake checkpoint requires first product/customer, pricing or payer hypothesis, reachable customer volume, team, timing, budget and validation status. A number-filled forecast without these inputs would be fiction.

For a later scenario model:

- **Lead model:** Revenue = acquired shoppers × quote-flow completion × eligible/accepted lead share × billable events per accepted shopper × net price per event. Contribution = collected revenue − acquisition − quote/data costs − support − partner payout − refunds/compliance-related variable costs.
- **Agency model:** Revenue = acquired shoppers × eligibility × quote completion × bind rate × actual average contractual net commission + realized renewals. Contribution subtracts CAC, licensed agent labor, verification, servicing, payment handling and reversals.
- **B2B SaaS model:** Revenue = paying accounts × monthly contract value + validated usage/implementation. Buyer ROI = verified labor saved × loaded labor cost + attributable incremental contribution − subscription/integration/support cost.
- **Embedded model:** Revenue = incremental completed eligible policies × contracted net share OR a permitted contract fee. Do not double-count lead fee and commission on the same event unless contract and law support both.
- **Break-even CAC:** Must be below observed cohort contribution after variable/partner costs, not a guessed industry benchmark.

## Sensitivity factors to measure

1. State/risk quote availability and comparable-coverage rate.
2. Completed quote rate from consented start.
3. Carrier/agency acceptance and quote-to-bind conversion.
4. Net revenue per accepted lead / bound policy / agency account.
5. Fully loaded acquisition cost by channel and attributable share.
6. Human handling, data/API cost, policy persistence and renewal rights.
7. Buyer concentration and budget/underwriting cycle changes.

## Red Flags

- Startup revenue cannot be inferred from premium volume or incumbent revenue.
- No rates, CAC, bind conversion, retention or paid design commitment are known.
- Commission/referral compensation cannot be chosen without state-specific legal analysis of both product conduct and payment.

## Yellow Flags

- Paid consumer acquisition may be prohibitively expensive against incumbents; incumbent spend is not startup CAC.
- SaaS could have more observable early economics, but only if the founder can reach agencies and prove ROI.

## Sources
- EverQuote FY2025 Form 10-K (SEC): https://www.sec.gov/Archives/edgar/data/1640428/000119312526066957/ever-20251231.htm
- LendingTree FY2025 Form 10-K (SEC): https://www.sec.gov/Archives/edgar/data/1434621/000162828026016084/tree-20251231.htm
- Canopy agency pricing: https://www.usecanopy.com/agencies/agency-pricing
- NAIC PLMA: https://content.naic.org/sites/default/files/model-law-218.pdf
- Policygenius compensation disclosure: https://www.policygenius.com/about/disclosures/
- Insurify partnership information: https://insurify.com/company/partnerships/
