# Market & Monetization Scan — U.S. Insurance Shopping

**Phase:** 3 — Market research (first-pass synthesis)
**Project:** insurance-shopping-agent
**Date:** 2026-09-30
**Confidence:** Medium on demand and incumbent economics; Low on this startup’s addressable revenue.

---

## Demand and timing

- **[Data, Tier 2, 2026-06-04]** J.D. Power reports 53% of U.S. auto insurance customers actively shopped in the previous year (down from 57%), an average of 3.5 quotes per shopper, and 48% of new auto policies purchased digitally. This suggests large, recurring shopping activity, but not a new AI-shopping addressable market by itself. Source: [2026 U.S. Insurance Shopping Study](https://www.jdpower.com/business/press-releases/2026-us-insurance-shopping-study/)
- **[Data, Tier 2, 2026-06-09]** J.D. Power reports roughly 32% of auto shoppers had used AI during shopping in its 2026 Auto Insurance Study, while 33% found AI content unhelpful; AI users were >1.3× as likely to switch. Separate denominator/date context matters; AI use isn’t proof of conversion or retention. [Source](https://www.jdpower.com/business/press-releases/2026-us-auto-insurance-study/)
- **[Data, Tier 2, 2026-05-13]** In J.D. Power’s digital study, only 33% encountered comparison pricing tools that include other brands, 28% encountered no price comparison tools, and 11% had used an insurer chatbot/assistant. This is a potential UX gap, not a measured startup opportunity. [Source](https://www.jdpower.com/business/press-releases/2026-us-insurance-digital-experience-study/)
- **[Data, Tier 1 government, 2025-01-16]** U.S. Treasury found nonrenewal rates in highest-risk ZIP codes about 80% higher than in lowest-risk ZIP codes during 2018–2022. Home shopping may be an availability/eligibility problem, not only price comparison. [Source](https://home.treasury.gov/news/press-releases/jy2791)
- **[Data, Tier 1 SEC, FY2025]** EverQuote reported $692.5M revenue, with auto insurance providers representing 91%; the filing describes selling qualified inquiries as clicks, data and calls. This establishes a large existing provider-paid marketplace, not a new company’s SAM or margin. [10-K](https://www.sec.gov/Archives/edgar/data/1640428/000119312526066957/ever-20251231.htm)
- **[Data, Tier 1 SEC, FY2025]** LendingTree reported $711.88M Insurance segment revenue, primarily upfront match/click/call fees; the 2025 10-K notes its insurance agency exited in Q2 2025. This reinforces the distinction between profitable lead distribution and agency placement. [10-K](https://www.sec.gov/Archives/edgar/data/1434621/000162828026016084/tree-20251231.htm)

### Market size and denominator discipline

**TAM/SAM/SOM not yet established.** Annual auto shoppers are not unique lifetime buyers; premiums written are not the startup’s revenue. The eventual addressable revenue must be calculated for a defined model:

- **Lead/referral:** eligible shopping events × legally monetizable qualification/delivery rate × contracted net price per accepted event.
- **Licensed agency:** eligible shoppers × quote completion × bind rate × actual contractual net commission/policy, plus only verified renewals.
- **SaaS/API:** eligible paying agencies/platforms × validated contract value, plus usage/implementation only where contracts permit.
- **SOM:** serviceable eligible events/accounts × demonstrable reach × conversion/retention. Do not double-count repeated events or stack conflicting lead and commission claims.

No public source reviewed supplied startup-specific quote costs, paid lead prices, auto/home commission schedules, startup CAC, or retention. Don’t fabricate them.

## Monetization landscape

| Model | Who pays / trigger | Evidence | Main constraint |
|---|---|---|---|
| Policy commission | Carrier/agency pays licensed agent after policy placement | Insurify, Jerry, The Zebra, Policygenius disclose carrier commissions; public percentages unavailable | Licensing, appointments, authorized sales process, carrier availability; commission and renewal rights unknown |
| Lead/referral | Carrier/agency pays for accepted inquiry/click/call | EverQuote and LendingTree SEC filings describe inquiry monetization; NerdWallet also discloses provider leads | Legal scope and fee contingency vary by state; leads may cause unwanted contact; payer controls quality/eligibility; rates unknown |
| Embedded distribution | Carrier/agency partner economics shared with channel | Insurify partner/white-label, Experian/Gabi, dealer insurance examples | Procurement, consent, attribution, partner share, regulatory review; pricing unknown |
| B2B SaaS/API | Agency/platform subscription, usage or implementation fee | Canopy Connect publishes $100/month and $250/month agency tiers (annual billing); FurtherAI YC profile shows workflow automation category | Adjacent benchmark only; not a price for this hypothetical product; ROI/integration burden untested |
| Consumer subscription | Consumer pays | No convincing willingness-to-pay evidence found; existing comparison is generally free | Poor initial hypothesis unless product serves ongoing distinct value (e.g., claims/coverage management); do not assume |

## Licensing / compliance — issue map, not legal advice

- **[Tier 1 official model]** NAIC Producer Licensing Model Act §§3–4 define selling/soliciting/negotiating and generally require a license; §13 restricts compensation for licensed activity by unlicensed persons. State enactment controls; the model itself is not statute everywhere. [NAIC PLMA](https://content.naic.org/sites/default/files/model-law-218.pdf)
- **[Tier 1 official state guidance]** Washington OIC says a review site that urges consumers to buy a particular type of insurance from a particular insurer is soliciting and may need licensing; it also describes conditions for referral compensation. [TAA 2021-01](https://www.insurance.wa.gov/sites/default/files/2024-09/taa-2021-01.pdf)
- **[Tier 1 official state opinion]** NY DFS’s 2008 opinion says a nonlicensee cannot be compensated contingent on purchase under the facts described, and cannot discuss specific policy terms/conditions. [NY DFS OGC 08-04-25](https://www.dfs.ny.gov/insurance/ogco2008/rg080425.htm)
- **[Tier 1 official CA law]** California Insurance Code §1631 restricts soliciting, negotiating or effecting insurance without the relevant license unless exempt. [Text](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=INS&sectionNum=1631.)
- AI-governance, privacy/consent, state unfair-discrimination, carrier vendor review and telemarketing/contact consent are distinct workstreams; a tool or downstream licensed partner is not a blanket safe harbor.

## GTM channels

1. **Embedded partner at high-intent moment** (lender/servicer, dealer, finance/benefits platform): credible route to audience and contextual event, but slow procurement and complex sharing economics.
2. **Independent agencies** (agency co-pilot): buyer can pay for labor/time or additional binds; requires reliable systems integrations, human review and demonstrated ROI.
3. **AI assistant/MCP**: a distribution interface, not a source of users, legal authority, carrier data, or moat. Insurify already has a ChatGPT quoting channel in 11 states; open third-party integration access and economics are unknown.
4. **SEO/paid acquisition**: incumbents own content and paid economics; EverQuote’s FY2025 ad spend was $500.7M—market presence but also evidence of a difficult acquisition auction. This is not startup CAC.
5. **Direct consumer brand / renewal relationship**: potential long-term value, but insurance shopping is episodic; retention and repeat engagement must be validated.

## Failure / disconfirmation signals

- EverQuote exited its health line/related DTC agency and sold rights to remaining P&C agency commissions in 2025. This is not proof consumer agency cannot work, but warns that agency commissions can be monetized or exited differently from lead marketplace economics. [SEC filing](https://www.sec.gov/Archives/edgar/data/1640428/000119312523204965/d542443dex993.htm)
- LendingTree closed its insurance agency in Q2 2025 while keeping lead/marketplace revenue, reinforcing that intermediary discovery and regulated placement have different operating models. [FY2025 10-K](https://www.sec.gov/Archives/edgar/data/1434621/000162828026016084/tree-20251231.htm)
- Policygenius layoff/acquisition events are evidence of consolidation/financial pressures, not proof of failure. [Reuters, 2023-04-25](https://www.reuters.com/markets/deals/digital-insurance-market-policygenius-be-acquired-by-eldridges-zinnia-2023-04-25/)
- Foresee’s independent launch test found unsupported/offline quote paths and browser-flow issues for some carriers, illustrating reliability and coverage limits. [Coverager, 2026-09-29](https://coverager.com/foresee-launches-in-california/)

## Red Flags
- Direct consumer quoting is saturated by funded, licensed, embedded incumbents; a free UI is not differentiation.
- Legal/contract access gates can constrain the business model, geography and recommendation language.
- Incumbent marketplace revenue and ad budgets do not tell us this startup's economics.

## Yellow Flags
- Customer shopping is cyclical and carriers change acquisition budgets with underwriting conditions.
- Hard-market home risks may be less quotable online and may require agent-led placement.
- User complaints are anecdotal, not prevalence estimates.

## Sources
Primary SEC, government, regulator and J.D. Power sources linked inline. Company data and projections are explicitly labelled as company-reported. Scope remains provisional; source vintage varies.
