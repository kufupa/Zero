# Labtest amend / cancel proof (plan only — do not run)

Hold until the main driver says yes. Driver B owns the Centurion browser from 19:20. One browser per HMS account. Live HRCEN only. Guest last name **Labtest** (display "Proof Labtest"). Arrival **2027-01-01 or later**. One email at a time. Never `--allow-real-guest`. Never click a penalty/charge/rate dialog.

## Prep

1. CDP on the HRCEN Labtest browser.
2. Create one Labtest stay (2027+). Note confirmation `NNNNNN-N` and arrival ISO.
3. From `apps/server-pilot`, import `buildAmendCancelPayload` in `src/ai/aop/amend-cancel-payload.ts`. Do not spawn from that module. Write amend `out.request` to the `--request` path, then pass `args` to the scripts below.

## Gates

- **Amend commit** reads `RESERVATIONIST_PANE_SAVE=lab` (`amendCommitAllowed`). Preview needs no save flag.
- **Cancel does not read that env.** Cancel identity: last name Labtest (case-insensitive), arrival ≥ 2027-01-01, confirmation exact, `--allow-real-guest` never set, CDP localhost. Preview treats `--arrival` as a hint (`arrivalHint`); commit requires arrival match.

## Amend preview

Input: `{ kind: 'amend', confirmationNumber, lastName: 'Labtest', changes: [{ field, to }] }` with `field` in `arrival|departure|adults|children|roomType`.

Write payload `request` to `amend-request.json` (the `--request` value):

```json
{ "confirmation": "<conf>", "expectedLastName": "Labtest", "fields": { "<field>": "<to>" } }
```

Run, cwd `apps/server-pilot/tooling/playwright-quote`:

`node amend-stay.mjs` + payload `args` (`--request amend-request.json --mode preview --out amend-out`).

Pass: `outcome=previewed`, `before.png`, no Save. Staff review screenshots. Commit (later, same driver): `--mode commit --digest <previewDigest>` only after approval and `RESERVATIONIST_PANE_SAVE=lab`. Refuse rate/penalty/charge windows.

## Cancel preview

Input: `{ kind: 'cancel', confirmationNumber, lastName: 'Labtest', changes: [{ field: 'arrival', to: '<ISO>' }] }`.

`node cancel-stay.mjs` + payload `args` (`--confirmation … --arrival … --mode preview --out cancel-out --reason "Test Reservations" --last-name Labtest`).

Pass: `preview_ok`, `arrivalMismatch=false` (requested arrival equals HMS arrival; a matching conf with a wrong arrival can still be `preview_ok` with `arrivalMismatch=true` — that is not proof), reason list read, dialog dismissed unconfirmed. `refused_penalty` = stop, leave the dialog. Commit only after screenshot approval, still Labtest / 2027+, arrival match required.

## Mail (optional, still one at a time)

Send one inbound to Centurion: existing conf + one clear change, or one cancel, guest Proof Labtest. Do not overlap with a live script run.

## Out

`amend-out/result.json` or `cancel-out/result.json` plus screenshots. No real-guest save.
