# Booking-completeness plan review — 2026-10-27

**Document review complete. Required Argon review blocked by quota.**
All seven independent Sonnet-slot max document reviewers returned.
They reviewed bounded plan sections and did not run product tests, inspect HMS, or edit product code.

Target: `docs/plans/2026-10-27-001-booking-completeness-plan.md`.
The initial review returned nine issues, with two concerning the same shared-file ownership gap.
The caller resolved them through eight substantive plan corrections under the original planning request.
No user approval, live correctness, or passing Argon gate is inferred.

| Reviewer | Reported issues | Resolution |
|---|---:|---|
| Coherence | 0 | No internal contradiction found |
| Feasibility | 1 | Explicit serialized booking integration ownership |
| Product | 2 | Used fields must be wired/saved; prepared rates must persist and hydrate |
| Design | 3 | Current child-age contract; rendered Add-On states; rendered availability states |
| Security | 1 | Preview/commit authenticate and re-authorize the approver using existing staff write permissions |
| Scope | 1 | Same explicit shared-file ownership correction as feasibility |
| Adversarial | 1 | Staff-load gate cannot be substituted by owner/test bundle loads |

## Applied corrections

1. One owner serializes every overlapping booking UI/bind/create edit. Independent native Add-On files retain a separate lane.
2. A field inventory cannot pass booking completeness while staff still manually enter required/routine fields in HMS.
3. Prepared rate results explicitly persist and hydrate the matching editable pane state, preserving staff edits.
4. Child ages use the existing canonical whole-years 0–17, at most nine per room row, verified in `apps/server-pilot/src/ai/work-items.ts:386-387`. Invalid/unknown values block without truncation. Wider native technical input limits are not child-pricing policy.
5. Add-On loading, empty, setup/read error, lock-busy, partial and uncertain states have staff-visible outcomes and safe actions.
6. Availability pending, absent, failed, stale and partial states cannot be mistaken for complete availability.
7. Add-On authorization binds and re-authorizes the authenticated approver, not only booking/row inputs.
8. Both-surface viewer proof remains separate from the product's staff-bundle-load gate and from adoption.

These edits resolve the reported document omissions.
They are not an implementation verification or another full review round.

## Remaining holds

- [Argon attempt](plan-argon-review.md): subscription quota exhausted before any review result. No bypass endpoint/account was used.
- Pomerado native row, provider-role routing and existing property-lock readiness remain execution-time gates.
- Full manual-field parity still requires native/staff evidence and field-sized follow-up slices. No unsupported fee, optional-field or real-guest write policy was invented.
- Phase 1 retains its pending multi-room and HMS confirmation proof ownership. The later handoff reports #654 deployed, not email delivered.

## Lane close

Research results and the proposed plan were indexed in `docs/research/README.md`.
Original ask 275 remains preserved verbatim in its intake file and linked from `PRODUCT.md` and `OWNER-ASKS.md`.
The existing bounded-subagent memory was updated rather than duplicated.
The evidence-backed-number memory now distinguishes PR counts from accepted completeness.

The compound lane-close check found no implemented, verified fix in this assessment.
A new solved-bug solution document was therefore skipped rather than presenting a diagnosis as a working fix.
No new vocabulary or instruction framework was introduced.

The local plan's required sections, unique requirement/unit identifiers, portable paths, and whitespace checks passed.
Artifact publication was attempted but refused because this session authenticates with an API key rather than a claude.ai account.
No artifact URL was created. The local repo plan remains the delivered document.
No authentication settings were changed to bypass that refusal.

No product code, install, runtime configuration, flag, deployment, HMS write, email send, commit, or push was performed by this planning lane.
