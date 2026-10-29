---
title: "Pomerado Centurion Stay 360 read"
date: 2026-10-28
---

# Pomerado Centurion Stay 360 read

## Goal and authority

Use the local Pomerado MCP server connected to this Codex session to sign in to
the Centurion tenant, find the owner's specified reservation by exact
confirmation number, and return every accessible visible field and value. The
owner supplied the credentials and authorized their use in Pomerado's native
login prompt. Keep credentials and the reservation number out of this plan and
the generated intent; pass the reservation as example input.

The owner explicitly prioritizes running the mint over the prior advisory-lock
approach and authorized stopping conflicting browser sessions. Do not stop an
unrelated browser or service. No active Chromium process was observed on the
product host immediately before this run; this does not prevent another
browser starting later.

Use `effect: read`: login, search, opening tabs and scrolling are part of the
read task. Do not create, change, cancel, send, save or otherwise modify a real
reservation. Never substitute another reservation for an exact match.

## Mint request

Name: `centurion_stay360_read`. URL:
`https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp?tenant=THECENTURION_PRD`.
Example input: `{ "confirmation_number": "<confirmation number>" }`.

> Sign in, open Stay 360, find the reservation matching the supplied
> confirmation number exactly, and open it. Return all visible labelled fields
> and values across accessible read-only sections, tabs and rows, including
> blank values and repeated rows. Scroll as needed. Report inaccessible
> sections and ambiguity; never return a different reservation as a match. Do
> not create, change, cancel, send, save, or otherwise modify any reservation.

## Execution and checks

1. Call `mint` once, then follow that job using `get_job` and answer its native
   credential or other input questions using `provide_input`. Ask for a code if
   HMS requires one. Do not switch to write.
2. Distinguish an authenticated session, an exact-match screen read, and a
   `build: published` result. A completed job with `build: incomplete` is not a
   published tool and does not prove why the build stopped.
3. If published, review generated source, schemas and navigation before reuse.
   Freshly call the generated tool on the same reservation and compare its
   output with the visible screen where evidence is available. State any
   unverified sections.
4. Register the generated integration's own MCP server in Codex following its
   generated README; reload Codex when needed. Keep the integration in the
   configured private output root. Close only this job's resources.

## Constraints and evidence

- Pomerado's local README documents the four job tools, read versus write,
  sign-in origin limits, 20-minute active mint deadline and the separate
  integration MCP server: `/home/orca/pomerado/README.md`.
- Local credential answers pass through the MCP client and may be visible to
  its model provider; the standalone host says it does not save the login.
- The prior native Centurion attempt ended incomplete with no published tool or
  verified screen read: `docs/research/2026-10-28-pomerado-native-codex-trial.md`.
- The prior two-lock finding is in
  `docs/research/2026-10-27-hrcen-two-locks.md`; this run follows the owner's
  newer instruction above instead of waiting for lock integration.
