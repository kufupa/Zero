---
title: "Infor A/R auto-add is not a substitute for an A/R lookup"
module: infor-hms
date: 2026-09-24
last_updated: "2026-09-24"
category: workflow-issues
problem_type: wrong_abstraction
component: tooling
severity: high
applies_when:
  - "Building party lookup, quote rateContext, or Guest Stay create fill order"
  - "Docs say linking organization or booking agency auto-adds the A/R account"
  - "Deciding whether A/R is a separate PMS tool or an association side-effect"
root_cause: docs_vs_live_behavior
resolution_type: workflow_improvement
tags:
  - infor-hms
  - party-lookup
  - ar-account
  - native-playwright
  - field-map
related_components:
  - playwright-quote
  - pms-pipeline
---

# Infor A/R auto-add is not a substitute for an A/R lookup

## Context

Party-lookup stage 1 read Infor association docs: organization/agency linked to A/R auto-adds A/R on the stay. That justified `arAccount.inThisTool = false` and treating A/R as `associationEffects.linkedArAccount`.

Stage 3 live New Record hold-select on HRCEN: organization filled `company` only; booking agency filled `ta1` plus commission; `araccountname` stayed blank. Stage 4 Astra map review opened an independent A/R Account lookup with org and agency empty.

## Decision

A/R is a v1 party-lookup kind. Fill A/R after org/agency when mail names it; do not assume the link wrote it.

Consuming `nativeId`: quote `rateContext.organization` takes `{ nativeId }` (org picker filters `ff_companyid`); `rateContext.agency` needs `{ nativeId, name }` because the agency picker has no ID filter (search by name, match `travelagencyid`; some agencies have blank IATA). Create `company` / `ta1` / `araccountname` are name lookups, so create takes the candidate `displayName` there and only accepts `nativeId` for guest `profileId`.

Group stays out: 0/30 keyed stay dumps had `groupname`. Flag `group-name-lookup` as unbuilt; `hms_group_block_read` remains the exact-ref reader.

## Evidence

- `.private/pms-pipeline/party-lookup/03-screen.json` autoFills: org→company; agency→ta1+commission; A/R empty
- `.private/pms-pipeline/party-lookup/04-review.json` blocking finding: independent A/R lookup
- `.private/pms-pipeline/party-lookup/implications.json` `researchDeltas` `ar-independent-lookup` `flagUser: true`

## Trap

Do not drop a search kind because the vendor manual described an auto-fill. Re-prove auto-fill on the live property, then update `implications.json` with `was`/`now`/`evidence` when the call flips.
