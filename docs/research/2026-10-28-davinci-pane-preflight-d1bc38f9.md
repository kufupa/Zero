# Da Vinci first-pane checkpoint: preflight

Date: 2026-10-28 UTC. Session: d1bc38f9. Scope: owner-authorized first single-room Labtest pane result only. This is a partial preflight, not a pane or booking proof.

## Observed

- Worktree and local `origin/main` were `00d814ca3`. The Product EC2 canonical checkout also reported `00d814ca3`. Both HTTP processes reported `NAVA_BUILD_COMMIT=30b84b445`; their compiled save file was newer than that Git commit and both processes started after the file's modification time. The running build and the loaded staff bundle are therefore **not independently established** by checkout HEAD or the stale-looking environment marker.
- `http` and `remote-http` were online. Their actual process environments had `PANE_WRITE_CREATE=lab`, `HMS_DAVINCI_CREATE=on`, and the duplicate reader enabled by default or explicit configuration. They shared the same database identity and configured Da Vinci browser endpoint. Credentials and connection values were not printed.
- The Da Vinci slot systemd unit was inactive, but the configured loopback debugging endpoint accepted a TCP connection. Two debugging browsers had distinct profile hashes. A TCP listener and distinct profile do not prove the Da Vinci page is authenticated or on the correct property.
- Live environment and installed quote descriptors show **three distinct HRDAV advisory-lock identities** for this same endpoint and database: `THECENTURION_PRD` for `http`, `legacy` for `remote-http`, and `HMS_DAVINCI` for staff quotes. The three corresponding locks were free at the query instant. A snapshot is not ownership or future exclusion. The independent sessions contacted reported no current HMS operation, but did not establish all other ownership.
- A previously authorized Labtest message exists on the HRDAV-bound Faith transport. It is inbound, mentions Labtest and a 2027 date, and has one `booking` work item in `needs_you`. A limited structural scan did not find a stored confirmation number or booked/unknown status. This does not prove a fresh HMS booking does not already exist. Prior notes document saves for the original dates. Use fresh eligible dates and reconcile identity before any save.
- The pilot account has mailbox access. No usable staff-domain cookie appeared in the one matching saved-browser-state file found under the checked private directory. This does not prove that no other session or sign-in method exists.
- The actual staff webmail pane contains individual-room Preview and Book controls. The existing `/nava-preview` runner blocks writes and is not a booking proof. Source shows no normal automatic commit retry and a one-use preview grant; it hides the retry control after an uncertain outcome. The source-level persisted-unknown and post-save record gaps remain as documented in the reviewed plan.

## Outcome and holds

No staff pane, HMS page, preview, save, booking, outbound email, flag change, service restart, deploy or Pomerado run was performed. No created reservation needs reconciliation for this session. The checkpoint is **not passed**. The paused Pomerado boundary also prevented invoking the website tooling needed before browser use in this session.

A future attempt must establish real pane access and a protected property-wide lease across the actual identities, without acquiring the pane's own key in a separate holder and deadlocking its save. Guard loss and arbitrary tenant overrides need consideration. Confirm the loaded bundle, property, fake guest and fresh dates; uncheck Send Mail and verify no recipient; Preview and Book once; then independently read the saved HMS record. If submit may have happened, reconcile without retry. No new send or deploy is implied by this preflight.

## Sources

- `docs/plans/2026-10-28-007-feat-davinci-booking-parallel-d1bc38f9-plan.md`
- `apps/server-pilot/src/ai/pane-stay-save.ts` and `apps/server-pilot/src/ai/staff-quote-run.ts`
- `apps/server-pilot/src/hms/property-read-lock.ts` and `apps/server-pilot/src/ai/pane-stay-spawn-env.ts`
- `apps/mail/components/quote-workflow/booking-card.tsx` and `apps/server-pilot/scripts/nava-preview-run.ts`
- Read-only Product EC2 process, systemd, TCP, descriptor and database metadata probes, 20:12–20:20 UTC.
- Prior Labtest injection and runner notes: `/home/orca/tmp/hrdav-ops/morning-notes.md`.
