# Seed: party-lookup

Why: `.private/cli-coverage/COVERAGE.md` find_party gap in 195/355 inbounds. By field: rateContext.organization 73, rateContext.agency 68, profileId 57, organization 45, agency 41, rateContext.group 11, arAccount 8.

## Docs (stage 1)

Base `https://docs.infor.com/hms/2026.08/en-us/hmsolh/`:

| Page | Says |
|---|---|
| `s_t1424428573093.html` | Associations: org search by Organization Name or External Organization ID; org/agency linked to A/R auto-adds A/R; Primary Booking Agency fills Contract, IATA, Commission; Group sets arrival to group start |
| `s_t1424428655778.html`, `s_t1424428665060.html` | Guest search: last, first, phone, email, loyalty |
| `s_t1424428583967.html` | CRS search icon: guest/org/group/agency |
| `s_t1424428592501.html` | Profile Link: Guest / Organization / Booking Agency |
| `s_t1424428594202.html` | Market fields copy order Group > Agency > Org |

Public API: none. Stage 1 **must** run Exa Agent (`agent_run` effort high) then fetch cited URLs. HTNG "No APIs"; gateway is generic proxy; Databridge is partner-gated with no profile-search payload. OHIP `searchProfiles` / OTA `ProfileReadRequest` = vocabulary only.

## Screen (stage 3)

`.private/create-screen/new-record.md`: Primary Booking Agency `ta1`, Organization `company`, A/R `araccountname`, Group `groupname`, Booking Agency Contract `bacontract` (read-only). Booking Agency Search button-1765, Organization Search button-1770 (never clicked yet). Also walk standalone profile search screens; pick the cleaner read-only surface for the CLI.

## Answer key (stage 2)

Joined real stay → read `ta1`, `company`, `araccountname`, `groupname` (+ guest profile id). Read-only.

## Hit rule (stage 7)

Hit = answer-key native id in `candidates`. Report hit@1 and hit@k. `ambiguous` with the right id inside = hit@k.

## Draft schema (stage 4 finalizes)

- Request: `{ kind: guest|organization|bookingAgency|group|arAccount, query: {<dialog fields>}, maxCandidates }`
- Result: `{ outcome: resolved|ambiguous|no_match|input_gap|execution_failure, candidates: [{ nativeId, kind, displayName, <grid columns>, matchedOn }], associationEffects?, screenshots: { criteria, results } }`
- Never auto-links. >1 candidate → `ambiguous`.

## Consumers (stage 9)

- `tooling/playwright-quote/quote-tool.schema.json` `rateContext.agency` / `rateContext.organization`
- `tooling/playwright-quote/create-tool.schema.json` `agency` / `organization` / `arAccount` / `profileId`
- Link on unsaved New Record → record auto-fills (A/R, contract, IATA, commission, market fields) → create fill order.
