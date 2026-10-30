# Centurion HMS and memory experiments

These 30 October 2026 reports record the evidence behind the cloud HMS tool and
agent-memory design. They describe the tools as observed at the time; check the
current code for implementation status.

- [Source cohort and cloud tool design](2026-10-30-source-cohort-and-cloud-tool-design.md): 612 E-Mail, Voice Call and Call Center stays, live lookup controls, and Hotel Availability observations.
- [Party memory and live lookups](2026-10-30-party-memory-and-lookups.md): historical agency, organization and A/R combinations, sender/recipient limitations, and live picker observations.
- [Reservation notes and billing instructions](2026-10-30-email-reservation-note-patterns.md): recurring text patterns and their limits.
- [Guest forms, Refund Account and next tools](2026-10-30-guest-forms-refund-and-next-tools.md): 30-stay guest form read, refund-account observations and reader choices.
- [Associated reservation search](2026-10-30-associated-reservation-search.md): 60 targeted reads, none showing another linked Centurion reservation.
- [Independent design review](2026-10-30-grok-cloud-tools-design-review.md): Grok's review and the checked findings and corrections.

The source data contains guest and business information and is not in Git. On
the research VPS, the shared private inputs are under
`/home/orca/.local/share/zero/research/halloween/raw-data/`. A PMS snapshot is an
observation at capture time, and an outbound recipient is not proof of the
original inbound sender. Counts are not production accuracy claims.
