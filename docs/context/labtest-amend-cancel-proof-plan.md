# Labtest amend / cancel proof (plan only — do not run)

Hold until the main driver says yes. Driver B owns the Centurion browser from 19:20. One browser per HMS account. Live HRCEN only. Guest last name **Labtest** (display "Proof Labtest"). Arrival **2027-01-01 or later**. One email at a time. Never `--allow-real-guest`. Never click a penalty/charge/rate dialog.

## Prep

1. CDP on the HRCEN Labtest browser. `RESERVATIONIST_PANE_SAVE=lab` for commit; preview needs no save flag.
2. Create one Labtest stay (2027+). Note confirmation `NNNNNN-N` and arrival ISO.
3. From `apps/server-pilot`, import `buildAmendCancelPayload` in `src/ai/aop/amend-cancel-payload.ts`. Do not spawn from that module; pass its `args` to the scripts below.

## Amend preview

Input: `{ kind: 'amend', confirmationNumber, lastName: 'Labtest', changes: [{ field, to }] }` with `field` in `arrival|departure|adults|children|roomType`.

Write `amend-request.json` (the `--request` value):

```json
{ "confirmation": "<conf>", "expectedLastName": "Labtest", "fields": { "<field>": "<to>" } }
```

Run, cwd `apps/server-pilot/tooling/playwright-quote`:

`node amend-stay.mjs` + payload `args` (`--request amend-request.json --mode preview --out amend-out`).

Pass: `outcome=previewed`, `before.png`, no Save. Staff review screenshots. Commit (later, same driver): `--mode commit --digest <previewDigest>` only after approval. Refuse rate/penalty/charge windows.

## Cancel preview

Input: `{ kind: 'cancel', confirmationNumber, lastName: 'Labtest', changes: [{ field: 'arrival', to: '<ISO>' }] }`.

`node cancel-stay.mjs` + payload `args` (`--confirmation … --arrival … --mode preview --out cancel-out --reason "Test Reservations" --last-name Labtest`).

Pass: `preview_ok`, reason list read, dialog dismissed unconfirmed. `refused_penalty` = stop, leave the dialog. Commit only after screenshot approval, still Labtest / 2027+.

## Mail (optional, still one at a time)

Send one inbound to Centurion: existing conf + one clear change, or one cancel, guest Proof Labtest. Do not overlap with a live script run.

## Out

`amend-out/result.json` or `cancel-out/result.json` plus screenshots. No real-guest save.
