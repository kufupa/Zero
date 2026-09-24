---
title: Centurion Outlook Sent-Mail Forward VBA Broke RFC Threading — Auto-BCC Ingest Fix
date: 2026-09-09
last_updated: 2026-09-10
category: integration-issues
module: server-pilot / Centurion Outlook workstation sent-mail ingest
problem_type: integration_issue
component: email_processing
severity: high
symptoms:
  - "Centurion Outlook SentItems ItemAdd VBA used Item.Forward to navaai@legacyhotels.co.za, producing Nava-mailbox inbound rows with FW: subjects"
  - Forwarded clones received new Message-IDs, breaking parent thread joins against existing Centurion threads
  - "In-Reply-To headers mangled — often literally \"Subject: FW:…\" instead of the parent Message-ID"
  - Duplicate inbound ingest rows appeared detached from hotel-sent outbound direction until routing and isHotelSent could classify a real BCC copy
root_cause: wrong_api
resolution_type: config_change
related_components:
  - database
  - tooling
tags:
  - centurion
  - outlook-vba
  - sent-mail-ingest
  - auto-bcc
  - message-id
  - in-reply-to
  - rfc-threading
  - server-pilot
  - sent-folder-parity
---

# Centurion Outlook Sent-Mail Forward VBA Broke RFC Threading — Auto-BCC Ingest Fix

## Problem

Centurion hotel staff use Classic Outlook with a VBA macro to shadow-copy Sent mail into the Zero ingest mailbox (`navaai@legacyhotels.co.za`). The original implementation listened on `SentItems_ItemAdd` and called `Item.Forward`, which created a second SMTP send with a new Message-ID, `FW:` subject prefix, mangled In-Reply-To, and To=navaai only. Zero could not match those clones to existing Centurion threads by Message-ID, and they landed on `transport-nava` as inbound mail instead of Centurion hotel-sent outbound.

## Symptoms

- Duplicate SMTP messages in ingest: original guest send plus a separate Forward clone seconds later
- Forward clones carried `FW:` subject prefix and a new Message-ID unrelated to the hotel's original send
- In-Reply-To on clones often mangled (e.g. literally `Subject: FW:…`) instead of a parent Message-ID
- To header on clones was only `navaai@legacyhotels.co.za`; From remained `centurion@legacyhotels.co.za`
- Ingest routed clones to `transport-nava` (direct-To match on navaai) instead of `transport-centurion`
- Clones stored as **inbound** on the wrong transport; Centurion Sent stayed thin or threads split
- Pilot RDS 2026-09-09: morning still showed Forward clones; after ~09:56 UTC ItemSend BCC cutover, `RE: bcc vbscript` to the external recipient appeared with `receivedFor` navaai, Centurion outbound, and later replies joined existing inbound parents (~18/22 sampled outbounds joined via IRT; 0 new Forward clones)

## What Didn't Work

- **Treating Forward clones as Sent-folder ingest.** Forward is a new send, not a Sent-folder snapshot. Ingest sees a separate inbound message with its own Message-ID. `resolveThreadId` walks `buildReferenceChain` (IRT preferred), but a clone whose Message-ID never existed on the guest thread cannot attach as the hotel's outbound row.

- **`.Copy` + rewrite To + `.Send`.** Same second-send problem as Forward. Copy-then-send still emits a new SMTP transaction with a new Message-ID. A common misdiagnosis blamed `.Copy` for the `FW:` prefix; **Forward** adds `FW:` — Copy alone does not.

- **Early Cursor VBA using `GetExchangeUser.PrimarySmtpAddress` without null-safe short-circuit.** VBA does not short-circuit `And`/`Or`. Evaluating `.PrimarySmtpAddress` on a null `ExchangeUser` (external recipients) raised Runtime error 91 and hit `SafeExit` before BCC ran, so some sends never shadow-copied at all.

- **Zimbra hidden forward alone (session history).** `zimbraMailForwardingAddress` copies mail when Centurion is an envelope recipient. External-only Outlook SMTP (Rocketseed/Exim) never “arrives” in Centurion as recipient, so hidden forward cannot journal those Sent items. (session history)

- **Assuming server-side outbound BCC was already live (session history).** Partial capture (Penny on To/Cc, CMS confirms) looked like a policy flip; it was path-specific local delivery, not universal Sent journal. (session history)

- **Outlook send-rules for silent BCC (session history).** Classic Outlook “apply on messages I send” exposes CC, not BCC — CC would leak the sink address to guests. (session history)

- **Treating the Sent gap as an ingest drop (session history).** Sept-1 census ruled out spam, quarantine, duplicate Message-ID skips, and POP lag for the missing Outlook Sent population; mail that reached `navaai@` was stored. (session history)

## Solution

Replace `ThisOutlookSession` SentItems Forward handling with **`Application_ItemSend` Auto-BCC**. Remove the `SentItems_ItemAdd` handler entirely. On send, if the item is a `MailItem` and the ingest address is not already among recipients, add `navaai@legacyhotels.co.za` as `olBCC`, then resolve recipients.

Use a null-safe email resolver (`GetRecipientEmail`) that reads `PR_SMTP_ADDRESS` via `PropertyAccessor` with `On Error Resume Next` — never assume Exchange resolution for external addresses.

### Before (broken — SentItems Forward)

```vba
' In ThisOutlookSession — DO NOT USE
Private Sub SentItems_ItemAdd(ByVal Item As Object)
    On Error GoTo SafeExit
    If TypeName(Item) <> "MailItem" Then GoTo SafeExit

    Dim fwd As MailItem
    Set fwd = Item.Forward
    With fwd.Recipients
        .RemoveAll
        .Add "navaai@legacyhotels.co.za"
        .ResolveAll
    End With
    fwd.Send                            ' second SMTP — new Message-ID, FW: subject
SafeExit:
End Sub
```

### After (working — ItemSend Auto-BCC)

```vba
' ThisOutlookSession
Private Const INGEST_ADDRESS As String = "navaai@legacyhotels.co.za"

Private Sub Application_ItemSend(ByVal Item As Object, Cancel As Boolean)
    On Error GoTo SafeExit
    If TypeName(Item) <> "MailItem" Then GoTo SafeExit

    Dim mail As MailItem
    Set mail = Item

    If RecipientAlreadyPresent(mail, INGEST_ADDRESS) Then GoTo SafeExit

    Dim r As Recipient
    Set r = mail.Recipients.Add(INGEST_ADDRESS)
    r.Type = olBCC
    r.Resolve

SafeExit:
End Sub

Private Function RecipientAlreadyPresent(mail As MailItem, addr As String) As Boolean
    Dim i As Long
    Dim e As String
    For i = 1 To mail.Recipients.Count
        e = GetRecipientEmail(mail.Recipients(i))
        If LCase$(e) = LCase$(addr) Then
            RecipientAlreadyPresent = True
            Exit Function
        End If
    Next i
End Function

Private Function GetRecipientEmail(r As Recipient) As String
    On Error Resume Next
    Dim smtp As String
    smtp = r.PropertyAccessor.GetProperty( _
        "http://schemas.microsoft.com/mapi/proptag/0x39FE001E")
    If Len(smtp) > 0 Then
        GetRecipientEmail = smtp
        Exit Function
    End If
    If Not r.AddressEntry Is Nothing Then
        GetRecipientEmail = r.AddressEntry.Address
    End If
End Function
```

**Deployment notes:** Classic Outlook only (not New Outlook / Mac / OWA). Macros signed and enabled. `ThisOutlookSession` must live in the VBA project for the Centurion mailbox profile. After cutover, confirm no `SentItems_ItemAdd` Forward handler remains.

## Why This Works

Auto-BCC hooks **before** the single SMTP send completes. Ingest receives one message — the same Message-ID, Subject, To/Cc, and References/In-Reply-To the hotel composed — with navaai only on Bcc. No second send, no `FW:` prefix, no orphan clone.

**Routing (no `X-Zero-Mailbox`):** When the owner header is absent, ingest tries `findDirectToTransport` on To addresses first, then `findCenturionEquatedTransport` (From/To/Cc/Bcc vs Centurion identities and aliases). A BCC-only navaai copy keeps To=external guest, so equated Centurion From wins → `transport-centurion`. A Forward clone with To=navaai only matched `transport-nava` via direct-To — wrong transport.

**Direction (hotel-sent):** After routing to Centurion, ingest sets outbound when From is in that transport's identity set and recipients are not a self-loopback into those same identities (`isSelfIngestLoopback`). BCC to the ingest sink is not a Centurion identity → **outbound**. Forward clones on `transport-nava` had From=centurion (not a Nava identity) → **inbound**.

**Threading (`resolveThreadId` / `buildReferenceChain`):** Reference chain merges References oldest→newest with In-Reply-To last; resolve walks from the end so IRT is preferred. One send preserves the hotel's Message-ID and reply headers. Forward clones carried a **new** Message-ID — no match to the Sent the staff actually sent. Noisy multi-hop `References` (e.g. RateTiger) can look like orphans in crude audits even when IRT joined correctly — prefer IRT before declaring an orphan.

**Sent folder in UI:** Sent requires an outbound message on the thread. Hotel-sent outbounds populate Sent; misclassified inbound Forward clones on `transport-nava` do not populate Centurion Sent.

**RDS verification signals (2026-09-09):**

| Signal | Before cutover (Forward) | After cutover (ItemSend BCC) |
|--------|--------------------------|------------------------------|
| Message count per hotel send | 2 SMTP (original + clone) | 1 SMTP |
| Subject | Clone often `FW: …` | Same as composed (no `FW:`) |
| Transport | Clone → `transport-nava` | Copy → `transport-centurion` |
| Direction | Clone inbound | Outbound (hotel-sent) |
| Thread join | Split / new thread on clone | Replies joined inbound parents via IRT |

## Prevention

- Keep **Classic Outlook** on Centurion workstations; New Outlook does not support the same VBA `Application_ItemSend` model reliably.
- Keep macros **enabled and signed**; document the macro name and publisher so IT does not strip it on update.
- **Never reintroduce** `SentItems_ItemAdd` + `Forward` or Copy-then-Send shadow patterns — any second `.Send` breaks Message-ID threading.
- Prefer **server-side silent copy** long-term on the path Outlook already uses (Rocketseed/Exim envelope BCC / journal) for OWA, mobile, other PCs, and HMS-sent mail that never touches desktop ItemSend. (session history)
- Rollout order: VBA bridge now → server copy ticket in parallel → deprecate per-PC macros once server copy is verified. Do not lead with visible CC rules or Zimbra SMTP repoint. (session history)
- Code review VBA for **null-safe recipient resolution**; never chain `And` across `ExchangeUser` without guarding null `AddressEntry`.
- Historical Forward junk and pre-BCC Sent gaps remain in RDS; do not treat them as live regression after cutover.
- **Residue (2026-09-10):** Pre-cutover Nava `FW:` clones from centurion@ are wrong-transport inbound with new Message-IDs. They do **not** pollute Centurion Sent. Do **not** Message-ID-rewrite them into Centurion outbound. Honest history densification = original Sent Items `.eml` catch-up only.
- **Ops checklist:** Keep ItemSend Auto-BCC (no `SentItems_ItemAdd` Forward). Keep `INGEST_REQUIRE_OWNER_HEADER=false` on EC2. Weekly SSM run: `npx tsx scripts/audit-centurion-sent-parity.ts` (hard-fails on post-cutover Nava-from-centurion or owner-header true).
- **Characterization lock (2026-09-10):** AE3 asserts empty `bccAddresses` still outbound; R6 PMBobo→Centurion stays inbound; R3 mixed thread appears in Inbox and Sent (`tests/folder-semantics.test.ts`, `tests/ingest-store.test.ts`). Do not extract a new hotel-sent classifier module — inline `isHotelSent` in `store.ts` is the source of truth.
- **Deferred follow-on:** `Centurion server-side sent journal (Rocketseed/Exim) for OWA/mobile/non-VBA` — same hotel-sent ingest contract without desktop macro. Prefer envelope journaling / SMTP silent copy that preserves Message-ID over transport-rule BCC-to-inbox (archive RCPT looks inbound).
- Plan: `docs/superpowers/plans/2026-09-10-centurion-sent-received-parity.md`

## Related Issues

- Ingest routing / hotel-sent / resolveThreadId: `apps/server-pilot/src/mail/ingest/store.ts`
- Reference chain: `apps/server-pilot/src/mail/ingest/message-id.ts` — `buildReferenceChain`
- Sent folder semantics: `apps/server-pilot/src/mail/folder-semantics.ts`
- Related learnings:
  - [Shared inbox replied ≠ read — auto-read on outbound](../logic-errors/shared-inbox-replied-vs-read-auto-read-outbound.md) — downstream UX of hotel-sent on the right thread
  - [Centurion responded detection and conversation-link precision](../logic-errors/centurion-responded-detection-conversation-link-precision.md) — assumes preserved Message-ID / In-Reply-To
  - [Rocketseed banner injection / audit self-BCC](../architecture-patterns/rocketseed-banner-injection-from-sender-provisioning.md) — Nava `mail.send` self-BCC ≠ Centurion Outlook ItemSend Auto-BCC
  - [Outlook calendar forward sender attribution](../logic-errors/outlook-calendar-forward-sender-attribution.md) — related Forward anti-pattern, different surface
