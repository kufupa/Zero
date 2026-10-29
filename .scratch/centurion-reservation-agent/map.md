---
title: Centurion end-to-end reservation agent
labels: [wayfinder:map]
status: open
---

## Destination

An evidence-backed, implementation-ready route to a complete Centurion reservation agent: selected email to prefilled staff review, one approved action that carries out the relevant HMS writes, and independently checked results. Cover price quotes and HMS provisional/new/prepaid bookings, payment work, amendments and cancellations, with the fields and hotel-specific lookups each supported workflow actually needs.

## Notes

- **Owner direction, 2026-10-28:** focus on Centurion first; build the workflows around shared capabilities and parallelize independent work. One staff click should approve the whole visible set of actions for the selected email, including multiple rooms and requested native Add-Ons. A click is not an atomic HMS transaction.
- Staff stay in the existing Outlook pane; the same feature works in webmail. Preserve the V1 experience. The owner previously chose one intake with Make quote and Create provisional booking as distinct outcomes. Nava drafts replies without sending; an HMS-native confirmation and its recipient are a separate possible side effect.
- Support full staff payment work, distinguish an agency voucher from actual evidence of money, and use the real hotel rate and native party/options. Skip automated channel messages, including failed-integration alerts; human travel-agent requests remain in scope.
- Reuse existing owner asks, corpus, staff observations, source code and dated experiment receipts before requesting more input. Do not repeat settled questions or launch another broad corpus study.
- Self-host browser tools; approved Azure AI is acceptable. Mastra is already present. Choosing a tool is evidence-led and must not block the product merely to complete a framework comparison.
- The map may carry scoped implementation forward once its relevant decisions are resolved and current executing-session authority applies. The owner's current direction is to parallelize independent workflow work in this new Centurion effort; do not silently change the scope of another active plan. This charting session does not authorize real-guest writes, sends, deployment or a flag change. Current product safety rules, approvals, Labtest exception, property locks, PR checks and test limits still apply.
- HRCEN SaaS is the first target. Preserve property/tenant identity and avoid new Centurion-only assumptions that prevent later Da Vinci reuse; Da Vinci end-to-end delivery and its 16 November migration are outside this map's acceptance.
- The canonical tracker is now [Centurion end-to-end reservation agent on GitHub](https://github.com/kufupa/Zero/issues/670). This local copy and its `issues/` files are an initial snapshot; do not claim work here or assume their status stays in sync. Existing broader multi-hotel map: [Nava reservation operations](../../docs/wayfinder/2026-10-28-reservation-operations/map.md).
- Consult [PRODUCT.md](../../PRODUCT.md), [product details](../../docs/context/PRODUCT-DETAIL.md), [AGENTS.md](../../AGENTS.md) and [start-here](../../docs/context/START-HERE.md) before execution. Prefer current source and independently observed HMS outcomes over historical status claims.

## Decisions so far

<!-- Index closed decision tickets here by title and a one-line gist. -->

- [Trace the real Centurion payment workflow](issues/03-payment-evidence.md): Voucher, proof, guarantee, attachment and settled money differ; Centurion payment handling and a usable money read still need proof.

- [Assemble representative cases from existing truth](issues/05-truth-cases.md): reuse existing party, quote and linkage evidence; create independently reviewed booking and write-outcome truth for the missing cases.

## Not yet specified

- Property- and payment-specific branches that cannot yet be stated precisely until the existing staff evidence and actual HMS screens are reconciled.
- The smallest property-specific configuration boundary for Centurion's actual fields and options.

## Out of scope

- General guest support outside reservation operations, replacing Outlook, Profitroom automation, and full Da Vinci launch.
- Treating an old experiment, owner approval in another run, listed tool or deployed bundle as proof of current production readiness.
