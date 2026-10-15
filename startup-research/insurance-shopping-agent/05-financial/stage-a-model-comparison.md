# Financial Stage A — Model Comparison, Not Forecast

**Phase:** 7 — Financial (Stage A groundwork)
**Project:** insurance-shopping-agent
**Date:** 2026-10-01
**Financial Model Stage:** **A — Assumption-Based.** No startup-specific price, funnel, CAC, renewal, gross margin, sales cycle or customer count is known. All numeric price points below are illustrative arithmetic only, not market benchmarks or forecasts.

---

## 1. First-principles revenue equations

These models are not interchangeable. Report subscription ARR, annualized transaction revenue and premium/GMV separately.

| Model | Revenue equation | What counts as recurring | Required evidence |
|---|---|---|---|
| Agency/MGA workflow software | Paying accounts × recurring contract value + separately disclosed setup/usage | Contracted subscription/committed recurring usage | Signed paid pilots, repeat use, workflow ROI, retention, delivery margin |
| Consumer licensed agency | Completed eligible binds × realized retained commission + actually realized renewals | Renewal revenue only to extent retained, contractual and observed; not automatically SaaS ARR | Licenses/appointments, authorized quotes/binds, actual statements, persistence, service cost, CAC |
| Qualified referrals | Accepted billable clicks/leads/calls × realized contract fee | Usually transaction revenue unless buyer has minimum recurring commitment | Written buyer contract, criteria, acceptance/rejection, compliant consent, repeat purchase, acquisition cost |
| Embedded commerce | Eligible completed policies × net contracted revenue share + platform SaaS fee, where specified | Contracted SaaS or minimum guarantee; transaction share may fluctuate | Signed distribution rights, licensing role, attribution, incremental conversion, partner economics |
| Policy/quote API | Paying integrations × recurring access fees + contracted usage | Minimum recurring contract, not mere API calls without commitment | Signed API customers, access/data rights, integration cost, uptime/quality, renewal |

## 2. $1M ARR arithmetic (illustrative, not forecast)

$1M ARR corresponds to approximately $83,333/month in recurring contracted revenue.

| Hypothetical annual contract value | Accounts needed for $1M ARR | Interpretation |
|---:|---:|---|
| $10,000 | 100 | Lower ACV requires scalable onboarding and support |
| $25,000 | 40 | Still requires repeatable buyer acquisition |
| $50,000 | 20 | Value/sales-cycle/cost of delivery must support enterprise-like ACV |
| $100,000 | 10 | Fewer buyers, likely harder procurement and concentration risk |

These ACVs are **not observed public insurance-agent/Foresee prices**; they are scenario knobs. They say nothing about the number of buyers available, close rate or time to sign.

Commission/referral sensitivity must use actual collected net revenue, not premium. Required yearly events = $1,000,000 ÷ observed retained revenue per event. A purely illustrative $200 net per bound policy would require 5,000 binds/year; $500 would require 2,000. These amounts are examples, not sourced commission rates. For referrals, annual revenue at $10 per accepted lead would require 100,000 accepted leads; not ARR absent recurring contractual commitments. Paid acquisition, human service, cancellation reversals, carrier/data costs and partner splits are not deducted in this arithmetic.

## 3. Ranked financial posture

### A. Agency/MGA operations copilot — first to test

- **Payer:** broker, agency, MGA, possibly wholesale broker.
- **Potential fast proof:** paid time-boxed workflow pilot; user has two reported LOIs that may offer access.
- **Economic equation:** recurring net ACV − compute/data/hosting − integration + implementation cost − human review/support − CAC.
- **Scalable case:** same workflow across many unrelated U.S. agencies, repeated usage, low onboarding/support, expansion into adjacent high-frequency tasks.
- **Kill case:** each customer is bespoke consulting; no repeatable time/quality impact; no paid pilot; buyer will not grant lawful data/system access.
- **Unknown:** buyer budget and procurement time, addressable number of agency/MGA buyers for selected task, ACV, support load, founder sales capacity. No forecast until measured.

### B. Controlled embedded distribution — fastest only with access

- **Payer:** carrier/agency/partner, under executed agreement.
- **Potential fast proof:** a channel partner has user intent and will run a controlled cohort.
- **Equation:** eligible transactions × incremental conversion × collected net revenue share; report policy premium as pass-through, not startup revenue.
- **Scalable case:** repeatable integrations and measurable improvement across platforms/products.
- **Kill case:** no channel ownership, no incremental conversion, partner retains economics or integration takes too long.
- **Unknown:** channel traffic, consent, conversion, legal structure, split, servicing, attribution.

### C. Consumer broker / quote marketplace

- **Payer:** carriers through commissions or contracted referral compensation.
- **Equation:** eligible shoppers × completed quotes × bind rate × observed retained commission − traffic + human service + cancellations.
- **Scalable case:** defensible customer acquisition, strong binds/persistency/renewals, additional lines and servicing efficiency.
- **Kill case:** CAC exceeds contribution; insufficient carrier access; lots of estimated/declined quotes; support burden.
- **Unknown:** all meaningful startup unit economics. Competitor revenue does not solve this.

### D. Referral marketplace

- **Payer:** licensed buyers/provider for accepted event, under executed terms.
- **Equation:** compliant, qualified accepted events × actual rate − acquisition and validation costs.
- **Scalable case:** differentiated consented high-intent supply with recurring multi-buyer demand.
- **Kill case:** lead quality/acceptance poor; duplicate/saturated traffic; buyer concentration; no contribution after acquisition.
- **Unknown:** fees and criteria are private and vary; referral rules are state-specific.

### E. General-purpose “agent insurance API”

- **Payer:** AI platform, fintech, agency software provider or carrier.
- **Equation:** recurring platform commits + contracted usage − per-carrier integration and support cost.
- **Scalable case:** broad authorized connectivity/standard schema with high integration reuse and renewal.
- **Kill case:** incumbents offer their API directly; buyer interest is speculative; each insurer connection needs bespoke permission and maintenance.
- **Unknown:** no signed API buyer or public comparable contract price identified.

## 4. The 50/50 Insurify report: relevance and limits

The user reports hearing Insurify’s CEO describe revenue as roughly half commissions and half advertising. Exact episode/recording and period are not verified. Insurify’s public page names commissions plus advertising, and describes click-through compensation, but provides no mix.

If a 50/50 mix were confirmed, it would **not** prove that advertising is the same as lead sales or that either side is profitable. It would signal that an incumbent can support two monetization channels and that “free” need not imply pure commission brokerage. For our model, investigate each payment event separately: (1) bound-policy commission, (2) paid click/referral, (3) accepted lead, (4) sponsored placement/display advertising, (5) software/API. Ask who buys, what event bills, consent/attribution requirements, and whether pricing compromises neutrality. Do not insert the 50/50 split as a startup assumption.

## 5. $1B valuation scenario

A billion-dollar valuation is not derivable from insurance premium TAM or an ARR target alone. Any valuation/multiple is market-dependent. The company would need demonstrable growth, retention, delivery margin, low acquisition cost, large serviceable buyer/transaction base, and defensibility (distribution rights, workflow integration, data feedback, renewals or trusted execution). Venture paths include:

1. **Workflow software:** cross-line operating system; recurring expansion with low service burden.
2. **Commerce/distribution:** repeatable owned/contracted demand, profitable conversion, multi-product repeat/renewal.
3. **Infrastructure:** permissioned connectivity and a neutral/authorized data layer embedded across multiple platforms.

No reviewed evidence proves the user’s company currently has any of these. Do not claim unicorn likelihood, date or “YC wants $1M ARR” as fact. YC’s public idea-advice frames evaluation around market size, founder/market fit, confidence in the problem and insight; it does not state an ARR quota.

## 6. Financial proof plan

1. **Before a model:** confirm LOI terms/decision makers, whether a paid pilot can be contracted, usable data, budget and expected decision date.
2. **Baseline:** sample actual workflows with buyer permission; log volume, timestamps, handling/rework, exception types, error severity and labor costs.
3. **Pilot economics:** measure collected cash, direct service/integration costs, hours saved, adoption and willingness to renew/expand. Include founder labor at market replacement cost in a second view.
4. **Channel economics:** track source-level reach, completion, accepted/bound events, gross versus net revenue, partner share, cancellations, repeat and consent.
5. **Scenario model:** after measurements, build conservative/base/upside cases. Use empirical bottom-of-funnel conversion and range; run ±30% sensitivity, cash runway, break-even, and time-to-cash (not just contracted ACV).
6. **Stop gate:** do not treat unsigned LOIs, pilot interest, free use, quote counts, written premiums or one-off implementation fee as ARR.

## Inputs currently missing

- Foresee ownership: whether it is the founder's/company's existing product, current revenue, active users, product/demo status, usage, quote completion, carrier integrations and authorized bind scope.
- Team: founder/cofounder roles, technical/insurance experience, producer licenses, U.S. relationships, distribution access, and specific unfair advantage.
- The two founder-reported LOIs: signers, scope, buyer/budget, price/payment, data/workflow access, procurement, conversion decision, exclusivity and commercial commitments.
- Available runway, founder commitment/time, hiring budget and tolerance for licensed/human operations.
- Selected buyer/product/workflow will be derived through evidence; the founder need not select a revenue model before research concludes.
- Actual ACV, CAC, sales cycle, quote/acceptance/bind rates, churn/renewal, delivery/support cost, margin and runway scenarios.

## Flags

**Red Flags:** No company-specific forecast or quick-$1M path is evidenced. Revenue models require access/contract rights; consumer DTC has strong incumbents.  
**Yellow Flags:** Insurify 50/50 mix is founder-reported, not verified; “advertising” accounting category uncertain; both LOIs’ enforceability/economics unreviewed.

## Sources

- [Insurify compensation disclosure](https://insurify.com/company/trust/) (company-described categories, no percentages)
- [Insurify/Muse announcement](https://insurify.com/press/news/insurify-blocks-muse-from-its-marketplace/)
- [Driving Force episode show notes](https://podcast.show/drivingforcepodcast/episode-29-snejina-zacharia-founder-ceo-of-insurify/) (28:02 chapter label; no verified split)
- [MIT Sloan transcript](https://mitsloan.mit.edu/alumni/snejina-zacharia-sf-13) (founder’s marketplace/carrier history)
- [EverQuote FY2025 10-K](https://www.sec.gov/Archives/edgar/data/1640428/000119312526066957/ever-20251231.htm)
- [LendingTree FY2025 10-K](https://www.sec.gov/Archives/edgar/data/1434621/000162828026016084/tree-20251231.htm)
- [Canopy published pricing](https://www.usecanopy.com/agencies/agency-pricing) (adjacent price anchor only)
- [NAIC producer licensing model](https://content.naic.org/sites/default/files/model-law-218.pdf) (model law, state adoption varies)
- [YC startup idea evaluation](https://www.ycombinator.com/library/8g-how-to-get-startup-ideas)
