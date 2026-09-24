# Infor HMS capability matrix

Fail-closed, docs/corpus-backed surface registry for HMS read foundation.
Autonomous discovery may use **only** `phase: active_read` rows with `autonomousAllowed: true`.

Source of runtime allowlist: `apps/server-pilot/src/hms/contracts.ts` (`CAPABILITY_ROWS`, `activeDiscoveryCapabilities()`).
Eval membership: `apps/server-pilot/evals/hms/denominators.v1.json`.

Official docs primary; docs prove product capability, not tenant entitlement or selectors.

> **Current quote exception (2026-09-17):** This Phase-B matrix predates the client-approved standalone quote workflow. Current quote work uses Front Desk → Availability → **Hotel Availability**, with applied adults/children/ages and read-only Availability Details. The `room-type-rate-availability`/OSRRAV row below is diagnostic/legacy history only and never a quote fallback. CRS Check Availability remains forbidden. The historical Phase-B runtime allowlist is not evidence that the standalone quote has migrated into the production worker.

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

## Active read (autonomous discovery allowed — historical Phase-B baseline)

| id | officialDocs | phase | credentialRequirement | autonomousAllowed | mutationRisk | evidenceNeeded |
| --- | --- | --- | --- | --- | --- | --- |
| `login` | [Starting HMS](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428565917.html) | `active_read` | `documented_read_screen` | `true` | auth session only; no PMS mutation beyond session establish | login URL origin = manifest; tenant/property header verify; redacted gate JSON on unknown request |
| `reservation-search` | [Guest Stay](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html) | `active_read` | `view_only` | `true` | Guest Stay list/search read; must not open New Record or Stay Wizard mutate paths | confirmation/external ref/bounded surname+date search; ambiguity handling; no create/amend controls |
| `room-type-rate-availability` | [Room Type and Rate Availability](https://docs.infor.com/hms/3.8.x/en-us/useradminlist/HMS%203.8.4%20User%20Guide_70179.pdf) | `active_read` | `view_only` | `true` | one exact read-only search; never CRS Check Availability | complete contiguous nightly schedule; exact inventory/rate/currency/basis/restrictions; `bookable:false`, `stayTotal:null`, `occupancyPriced:false` |

`activeDiscoveryCapabilities()` must equal:

```text
login, reservation-search, room-type-rate-availability
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

Phase B portfolio baseline case file: `apps/server-pilot/evals/hms/portfolio-cases.v3.json` (56 opaque thread IDs; placeholder labels do not score). Ablation via `portfolioAblationReplay` in `read-tools.ts` — report raw eligible/attempted/exact/partial/manual and `ΔFull`; never sum overlapping keyword percentages.

## Phase B read-tool portfolio (`READ_TOOLS`)

Runtime SoT: `apps/server-pilot/src/hms/read-tools.ts`.

Capability state ladder (contiguous evidence refs only):

`planned → fixture_verified → discovery_verified → live_verified → shadow_enabled`

| tool id | target version | production active-read (Task 1 freeze) | notes |
| --- | --- | --- | --- |
| `hms_find_reservation` | `1.1.0` → `1.2.0` in Task 2 | yes (`live_verified`) | Phase A proven; list-row enrich next |
| `mail_read_artifact` | `1` → `2` in Task 3 | no | fixture only until chain proof |
| `hms_quote_stay` | `2.0.0` | no | planned; single Room Type and Rate Availability surface |
| `hms_list_documents` | `1.0.0` | no | planned; Tax Invoice + sent metadata |
| `hms_sent_email_audit` | `1.0.0` | no | planned |
| `hms_read_folio` | `1.0.0` | no | planned; Infor Folio + Deposit Ledger only |
| `hms_company_account_read` | `1.0.0` | no | blocked until tenant view-only fields proven |
| `hms_group_block_read` | `1.0.0` | no | planned |
| `hms_event_read` | `1.0.0` | no | planned |

Only `shadow_enabled` tools enter the active shadow registry. Unproven tools stay out of production `activeToolIds`.

## Discovery rules

1. Live HMS: docs/Exa research only until orchestrator-approved canary. No chromium login in Task 0.
2. Autonomous discovery surfaces **only**: `login`, `reservation-search`, `room-type-rate-availability`.
3. Forbidden: `write-forms`, `crs-check-availability`, any mutation (submit, save, create, amend, cancel, assign, post, settle, refund, send, print, export, open write-form screens).
4. Quote v2 uses only Room Type and Rate Availability. It never visits CRS Check Availability and never claims a guaranteed or bookable offer.
5. Folio/deposit facts live inside Infor HMS (Working with Folios + Deposit Ledger). Not a separate PMS.
