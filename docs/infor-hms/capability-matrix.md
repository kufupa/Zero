# Infor HMS capability matrix

Fail-closed, docs/corpus-backed surface registry for HMS read foundation.
Autonomous discovery may use **only** `phase: active_read` rows with `autonomousAllowed: true`.

Source of runtime allowlist: `apps/server-pilot/src/hms/contracts.ts` (`CAPABILITY_ROWS`, `activeDiscoveryCapabilities()`).
Eval membership: `apps/server-pilot/evals/hms/denominators.v1.json`.

Official docs primary; docs prove product capability, not tenant entitlement or selectors.

## Row schema

```typescript
type CapabilityRow = {
  id: string;
  officialDocs: string[];
  corpusThreadIds: number[];
  phase: 'active_read' | 'roadmap_read' | 'future_write';
  credentialRequirement: 'documented_read_screen' | 'view_only' | 'human_supervised';
  autonomousAllowed: boolean;
  mutationRisk: string;
  evidenceNeeded: string[];
};
```

## Active read (autonomous discovery allowed)

| id | officialDocs | phase | credentialRequirement | autonomousAllowed | mutationRisk | evidenceNeeded |
| --- | --- | --- | --- | --- | --- | --- |
| `login` | [Starting HMS](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428565917.html) | `active_read` | `documented_read_screen` | `true` | auth session only; no PMS mutation beyond session establish | login URL origin = manifest; tenant/property header verify; redacted gate JSON on unknown request |
| `reservation-search` | [Guest Stay](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html) | `active_read` | `view_only` | `true` | Guest Stay list/search read; must not open New Record or Stay Wizard mutate paths | confirmation/external ref/bounded surname+date search; ambiguity handling; no create/amend controls |
| `room-availability` | [Room Availability](https://docs.infor.com/hms/3.8.x/en-us/hmsolh/s_t1424428570987.html) | `active_read` | `view_only` | `true` | Front Desk > Availability > Room Availability inventory view only; never CRS Check Availability | start date + room type observation; inventory counts only; separate from Display Rates |
| `display-rates` | [Display Rates](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428571268.html) | `active_read` | `view_only` | `true` | calculates prices; does not bind inventory or create reservation | rate plan + room cost; unresolved amount basis/currency/inclusions; `bookable` stays false |

`activeDiscoveryCapabilities()` must equal:

```text
login, reservation-search, room-availability, display-rates
```

## Explicit discovery prohibitions

| id | officialDocs | phase | credentialRequirement | autonomousAllowed | mutationRisk |
| --- | --- | --- | --- | --- | --- |
| `crs-check-availability` | [CRS reservation](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428583967.html) | `future_write` | `human_supervised` | `false` | Official docs: Check Availability creates a new reservation record — forbidden for autonomous discovery |
| `write-forms` | [Property Forms](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428600707.html) | `future_write` | `human_supervised` | `false` | any submit/save/create/amend/cancel path; mutation prohibited in Wave 1A |

## Roadmap reads (not autonomous discovery)

| id | officialDocs | phase | autonomousAllowed | notes |
| --- | --- | --- | --- | --- |
| `sent-email-audit` | [Sent Email](https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html) | `roadmap_read` | `false` | Wave 1B |
| `folio-read` | [Working with Folios](https://docs.infor.com/hms/2024.x/en-us/hmsolh/s_t1424428571861-2.html) | `roadmap_read` | `false` | Wave 2; never post/settle/refund |

## Corpus thread IDs

`corpusThreadIds` on rows start empty. Denominator membership lives in `denominators.v1.json` (`draftEligible` = 56, `operationalPortfolio` = 116). Reference-only counts (`toolDependentHistorical` 61, `historicalWorkflow` 68, `replyWorthy` 97) are not executable membership until a later reconciliation artifact supplies thread IDs.

## Discovery rules

1. Live HMS: docs/Exa research only until orchestrator-approved canary. No chromium login in Task 0.
2. Autonomous discovery surfaces **only**: `login`, `reservation-search`, `room-availability`, `display-rates`.
3. Forbidden: `write-forms`, `crs-check-availability`, any mutation (submit, save, create, amend, cancel, assign, post, settle, refund, send, print, export, open write-form screens).
4. Room Availability and Display Rates stay separate observations — never merge into a guaranteed offer.
