---
title: Rocketseed Banner Injection Keys Off From/Sender Provisioning, Not Relay Traversal or SMTP AUTH
date: 2026-07-31
last_updated: 2026-08-01
category: architecture-patterns
module: hotel outbound / Rocketseed branding relay
problem_type: architecture_pattern
component: email_processing
severity: high
applies_when:
  - Diagnosing missing or unexpected Rocketseed signature/banner on hotel outbound mail
  - Comparing branded vs unbranded senders that share the same IP-trusted pilot relay path
  - Provisioning or excluding mailboxes (e.g. internal test/BCC sinks) in the Rocketseed tenant
  - Ruling out SMTP AUTH or pilot-IP exclusion as the branding gate
  - Configuring or activating MAIL_TRANSPORT_MODE=real outbound SMTP
  - Tempted to set SMTP_HOST to Zimbra 172.24.0.10 or any non-Rocketseed host
  - Leftover SMTP_PASSWORD or secret still present and risk of AUTH 535 on Rocketseed
related_components:
  - tooling
  - testing_framework
tags:
  - rocketseed
  - banner-injection
  - from-sender-provisioning
  - smtp-relay
  - ip-trusted
  - sole-smtp-hop
  - no-smtp-auth
  - zimbra-pop3-only
  - centurion
  - navaai
  - hotel-outbound
---

# Rocketseed Banner Injection Keys Off From/Sender Provisioning, Not Relay Traversal or SMTP AUTH

## Context

Hotel outbound branding on the Legacy Hotels path is performed by Rocketseed (`172.24.0.8` / `branding.legacyhotels.co.za`), then handed to Zimbra (`172.24.0.10`) for delivery and POP3 ingest. As of the 2026-07-31 sole-hop cutover, **Zero enforces** that topology for `MAIL_TRANSPORT_MODE=real` (see [Mandatory sole SMTP hop](#mandatory-sole-smtp-hop)):

**Zero (EC2 pilot) → Rocketseed `.8:587` (STARTTLS, no AUTH) → Zimbra `.10` → recipient**

During Rocketseed first-class work (`docs/superpowers/plans/2026-07-30-rocketseed-banner-first-class.md`), live canaries showed a confusing split: mail clearly traversed Rocketseed (Received hops through `.8`, Rocketseed-stamped headers present) yet arrived **without** signature/top/footer banners when the Header From was Nava (`navaai@...`). Historical store counts reinforced that: `navaai` had **0/11** branded messages; provisioned hotel senders (including Centurion) had branded samples.

Two competing root-cause hypotheses survived after Nava self and Nava→Gmail canaries:

- **RCA A -- From/sender provisioning:** Rocketseed injects banners only when the RFC5322 From (or equivalent provisioned sender identity) is mapped in the Rocketseed tenant. Nava is an internal test / BCC sink and is not provisioned → unbranded is expected.
- **RCA B -- Pilot IP / routing group:** The pilot relay source is excluded from branding policy, so any From on that path would stay unbranded.

Discriminator: send **Centurion From** through the **same** pilot IP-trusted path to Rocketseed. Branded → RCA A. Unbranded → RCA B.

(session history) Centurion From on that same path produced human-confirmed Centurion top banner + signature + footer (canary subject prefix `ZERO-RS-CENT-GMAIL-20260731T135324`, correlation suffix omitted here to avoid SHA false-positives; full subjects in the table below). Nava on the same path stayed unbranded (`ZERO-RS-NAVA-SELF-20260731T003451`, `ZERO-RS-NAVA-GMAIL-20260731T120510`). **RCA B is disproved; RCA A stands.** Nava remaining unbranded is correct for an internal test/BCC sink. Centurion client banner path is proven. Testing for this selector question is complete.

Secondary friction that muddied diagnosis (not the branding selector):

- Zimbra SMTP credentials offered to Rocketseed returned **AUTH 535** before `MAIL FROM` (no message sent).
- The same Rocketseed endpoint accepted **trusted-IP relay without SMTP AUTH** (`250`) for Nava and Centurion canaries.
- Rocketseed stamps `X-ExSBR-Direction: Incoming` and `X-BypassBranding: Yes` on **both** branded and unbranded relayed copies -- those headers prove traversal/policy stamps, **not** whether banners were injected.
- Original plan assumed one shared **authenticated** STARTTLS credential; live proof used IP-trusted unauthenticated submission. Do not equate "AUTH required in some code paths" with "AUTH is how Rocketseed selects branding."

## Guidance

### Branding gate (ops truth)

Treat Rocketseed banner/signature injection as **From/sender tenant provisioning**, not as a side effect of:

1. Merely traversing Rocketseed `.8`, or
2. SMTP AUTH succeeding, or
3. Recipient being internal vs external (Nava→Gmail was also unbranded), or
4. Presence of `X-BypassBranding` / `X-ExSBR-Direction` headers.

**Provisioned sender (Centurion) + pilot path → banners. Unprovisioned sender (Nava) + same path → no banners.**

When diagnosing "no banner," first ask: *is this From address (or its Rocketseed account/campaign mapping) provisioned?* Only after that, inspect relay path, TLS, and MIME.

### What Zero controls vs what Rocketseed controls

Zero's outbound `mail.send` forces SMTP `from` (and the audit self-BCC address when enabled) from the **active mailbox transport**, not from a free-form client From:

```1157:1160:apps/server-pilot/src/trpc/routes/mail.ts
      const bcc = withTransportSelfBcc(input.bcc ?? [], ctx.transportEmail);

      const smtpPayload = {
        from: ctx.transportEmail,
```

So the branding selector Zero can change without Rocketseed admin work is **which mailbox is active** (`ctx.transportEmail`). Banner proof for Centurion requires sending as the Centurion transport (or equivalent provisioned identity), not hoping Rocketseed brands any envelope that touched `.8`.

### Self-BCC is not branding

Audit self-BCC exists so Zimbra/Outlook can file a Sent copy; it is orthogonal to Rocketseed injection. `MAIL_SELF_BCC` defaults on unless explicitly `false` / `0` / `off` (`isSelfBccEnabled` in `apps/server-pilot/src/trpc/routes/mail.ts`).

```99:120:apps/server-pilot/src/trpc/routes/mail.ts
/** Audit self-BCC is on unless MAIL_SELF_BCC is explicitly disabled. */
export function isSelfBccEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.MAIL_SELF_BCC?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

/** Deduped BCC list that always includes the active mailbox address. */
export function withTransportSelfBcc(
  bcc: string[],
  transportEmail: string,
): string[] {
  if (!isSelfBccEnabled()) return [...bcc];
  const self = transportEmail.trim();
  // ... dedupe + push self ...
}
```

Self-BCC proves the mailbox received a copy for reconciliation/ingest; **it does not cause banners**. Testing canaries that must not pollute Centurion with audit copies should omit self-BCC (set `MAIL_SELF_BCC=false` once the gate is deployed, or use a direct probe with an explicit recipient-only envelope).

### SMTP AUTH vs IP-trusted relay

Do **not** claim live Rocketseed branding (or delivery) requires SMTP AUTH.

- **Live observation (session, not in-repo MIME fixtures):** Rocketseed rejected Zimbra creds with **535**; trusted-IP submission **without AUTH** accepted with **250** and relayed into Zimbra. Historical branded and unbranded samples were also unauthenticated (`esmtp`/`esmtps`, not `esmtpa`).
- **App contract (post sole-hop cutover):** On Rocketseed host `.8`, nodemailer `auth` is **always** `undefined` — even when leftover `SMTP_PASSWORD` / secret ARN remains in env. `buildRealSmtpNodemailerOptions` and `RealSmtpTransport.send` both force that omit (`apps/server-pilot/src/mail/send/smtp.ts`). Wire/Mailpit may still AUTH; real Rocketseed must not.

Transport hop contract ≠ From provisioning (tenant) contract. Keep them separate. (session history) Earlier first-class plans assumed shared authenticated STARTTLS — that assumption is stale against live IP-trust proof.

### Headers that do not mean "branded"

| Signal | Means |
|--------|--------|
| Received / peer involving `.8` or `branding.legacyhotels.co.za` | Traversed Rocketseed |
| `X-ExSBR-Direction: Incoming` | Rocketseed stamp (seen on branded **and** unbranded) |
| `X-BypassBranding: Yes` | Rocketseed stamp (seen on branded **and** unbranded) -- **not** "banners applied" |
| `rocketseed-strip`, branding-domain image parts, human-visible top/footer/signature | Actual branding |

### Discriminator pattern (repeatable)

1. Fix path: IP-trusted STARTTLS to Rocketseed `.8:587` (no AUTH if that is how the pilot is allowed).
2. Send A: unprovisioned / test From (Nava) → expect SMTP 250 + no banners (self and/or external).
3. Send B: known-provisioned From (Centurion) from the **same** source IP → expect banners.
4. If B brands and A does not → provisioning gap for A. If neither brands → path/policy problem (not From).

Subject tokens used in this wrap-up (correlation ids in subjects — **not** git SHAs; human-confirmed outcomes, not in-repo MIME fixtures; no bodies):

| Subject token | Role | Branding outcome |
|-------|------|------------------|
| `ZERO-RS-NAVA-SELF-20260731T003451` (+ uuid suffix) | Nava self via `.8` | No branding; headers prove traversal |
| `ZERO-RS-NAVA-GMAIL-20260731T120510` (+ uuid suffix) | Nava → Gmail via `.8` | No banner (human) |
| `ZERO-RS-CENT-GMAIL-20260731T135324` (+ uuid suffix) | Centurion → Gmail, same pilot IP | Centurion banners confirmed (human) |

## Why This Matters

Wrong gate → wasted work. Teams that treat "no banner" as "Rocketseed relay broken," "pilot IP blocked," "need SMTP AUTH," or "internal recipient skips branding" will keep debugging the wrong layer while Nava correctly stays unbranded as a test/BCC sink.

Right gate → clear product split:

- **Centurion (and other provisioned hotel senders):** Rocketseed path is the client-visible branding path; proven on the pilot IP with Centurion From.
- **Nava:** Internal harness / self-BCC sink; unbranded through Rocketseed is **success** for the sink role, not a failed banner deploy. Branding Nava requires an explicit Rocketseed tenant mapping (or stopping use of Nava as the branding canary).

Cutover plans that require "autonomous Nava proof of branding" before believing Centurion will never go green if Nava is intentionally unprovisioned. Prove Centurion (or another provisioned From) for banner injection; use Nava for relay/reconcile/ingest proofs.

## When to Apply

- Diagnosing missing or unexpected Rocketseed signature/banner on hotel outbound mail.
- Comparing branded vs unbranded senders that share the same IP-trusted pilot relay path.
- Deciding whether to provision or explicitly exclude mailboxes (internal test / BCC sinks) in the Rocketseed tenant.
- Ruling out SMTP AUTH or pilot-IP exclusion as the branding gate.
- Writing or reviewing cutover plans that currently demand "Nava branded E2E" as the sole production-proof of banners.
- Reading MIME for `X-BypassBranding` / `X-ExSBR-Direction` without treating them as banner success.
- Asserting SMTP AUTH requirements -- read `mail.send` From authority and the active tree's Rocketseed AUTH-omit path first; compare to live 535 vs trusted-IP 250 observations.
- Configuring `MAIL_TRANSPORT_MODE=real` SMTP host/port or re-running `activate-real-mail.sh` / `write-ec2-env.sh`.
- Tempted to fall back to Zimbra `.10` SMTP when Rocketseed is down (must fail closed instead).

## Examples

### Example 1 -- Same path, different From (selector)

**Before (false conclusion):** "Pilot relay IP cannot brand; move EC2 or open a different Rocketseed routing group."

**After (verified pattern):** Nava From on pilot IP → unbranded (`ZERO-RS-NAVA-*`). Centurion From on same pilot IP → banners (`ZERO-RS-CENT-GMAIL-20260731T135324`). Fix or accept Nava's unprovisioned tenant state; do not redesign IP policy for banner injection.

### Example 2 -- Headers ≠ branding

**Before:** MIME shows `X-BypassBranding: Yes` after `.8` hop → assume branding applied.

**After:** Treat those stamps as Rocketseed presence markers. Confirm branding only via `rocketseed-strip` / branding image parts / human-visible top+footer+signature. Nava self token prefix `ZERO-RS-NAVA-SELF-20260731T003451` is the reference unbranded-but-stamped case.

### Example 3 -- AUTH 535 is not "branding off"

**Before:** "Rocketseed AUTH failed (535) → branding cannot work until shared credentials exist."

**After:** AUTH 535 blocked send entirely. Separate canaries without AUTH got `250` and still showed From-keyed branding differences. Branding selector ≠ AUTH.

### Example 4 -- Zero From authority

Active Centurion mailbox → `ctx.transportEmail` is Centurion → SMTP `from` is Centurion → Rocketseed can match a Centurion campaign.

Active Nava mailbox → From is Nava → even on a perfect Rocketseed path, expect no banners until Nava is provisioned.

## Mandatory sole SMTP hop

**App contract (cutover 2026-07-31, docs refreshed 2026-08-01):** `MAIL_TRANSPORT_MODE=real` must submit only to Rocketseed `172.24.0.8:587` STARTTLS with SNI `branding.legacyhotels.co.za`. Zimbra `172.24.0.10` remains **POP3 only** — never an allowed real SMTP connect host. There is no Zimbra-direct SMTP fallback on Rocketseed failure (fail closed / queue errors).

### Sole hop pin

1. `SMTP_HOST` must be exactly `172.24.0.8` (`ROCKETSEED_SMTP_HOST` in `apps/server-pilot/src/mail/send/smtp.ts`).
2. `createSmtpTransport` calls `assertRealSmtpHop(host)` when mode is `real` — any other host throws.
3. `activate-real-mail.sh` and `write-ec2-env.sh` default and fail closed on the same host; SMTP port is **587 only** (no 25 fallback).
4. `fixture` / `wire` are carve-outs: fake or Mailpit localhost; hop pin does **not** apply. Do not "fix" wire by pointing it at `.8`.

### AUTH never on Rocketseed (leftover-password footgun)

Rocketseed pilot submission is **IP-trusted**. For host `.8`, `buildRealSmtpNodemailerOptions` always sets `auth: undefined`, and `RealSmtpTransport.send` skips password resolution entirely — even when leftover `SMTP_PASSWORD` / `SMTP_SECRET_ARN` remains in `.env.production`. Sending Zimbra creds to Rocketseed yields **535** before `MAIL FROM` and looks like an outage. Activate smoke verifies STARTTLS with `auth: undefined`, not AUTH `verify()`.

### TLS split

| Path | Host | TLS posture |
|------|------|-------------|
| Real SMTP (Rocketseed) | `.8:587` STARTTLS | `requireTLS` + `rejectUnauthorized: true` + SNI `branding.legacyhotels.co.za` |
| Real POP3 (Zimbra) | `.10` | May keep `MAIL_TLS_REJECT_UNAUTHORIZED=false` for expired hotel certs |
| Wire SMTP | Mailpit | Shared loose/strict knob OK |

Never loosen Rocketseed SMTP verify because POP3 needs a loose cert.

### Branding vs hop

Traversing `.8` is **mandatory** for real outbound. Whether banners appear is still From/sender tenant provisioning (Centurion yes / Nava often no). Do not treat Nava unbranded mail as a hop failure.

Hop canaries (correlation ids in subjects — **not** git SHAs):

| Subject prefix | Role |
|----------------|------|
| `ZERO-RS-HOP-2026-07-31T21-09-18` | Nava self sole-hop canary (SMTP accepted on `.8`) |
| `ZERO-RS-CENT-HOP-2026-07-31T21-09-49` | Centurion→Gmail on same hop |

Handoff: [2026-07-31-rocketseed-sole-smtp-hop.md](../../superpowers/plans/handoff-reports/2026-07-31-rocketseed-sole-smtp-hop.md). Plan: [2026-07-31-rocketseed-sole-smtp-hop.md](../../superpowers/plans/2026-07-31-rocketseed-sole-smtp-hop.md).

## Related

- Plan (hop cutover): [2026-07-31-rocketseed-sole-smtp-hop.md](../../superpowers/plans/2026-07-31-rocketseed-sole-smtp-hop.md)
- Handoff (cutover evidence): [2026-07-31-rocketseed-sole-smtp-hop.md](../../superpowers/plans/handoff-reports/2026-07-31-rocketseed-sole-smtp-hop.md)
- Plan (earlier first-class wave): [2026-07-30-rocketseed-banner-first-class.md](../../superpowers/plans/2026-07-30-rocketseed-banner-first-class.md) -- original "shared authenticated STARTTLS" assumption is stale.
- Architecture sibling: [mail-transport-mode-fixture-vs-real.md](./mail-transport-mode-fixture-vs-real.md) -- fixture/wire/real matrix; **real SMTP row may still say Zimbra** until refreshed — treat Rocketseed sole hop here as source of truth for SMTP host.
- Live pilot parity: [live-pilot-production-parity-real-mail.md](./live-pilot-production-parity-real-mail.md).
- UI sibling (CID banners once MIME has parts): [email-html-images-cid-rewrite-and-trusted-sender-domains.md](../ui-bugs/email-html-images-cid-rewrite-and-trusted-sender-domains.md) -- render path after branding attachments exist; does not select whether Rocketseed injects them.
- Reachability only: [ec2-pilot-nava-openvpn-always-on-health.md](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md) -- `172.24.0.8` probe ≠ branding or hop pin.
