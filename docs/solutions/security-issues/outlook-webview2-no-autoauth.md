---
title: Outlook task pane must not mint Better Auth sessions from a self-reported workstation email
date: 2026-09-17
category: security-issues
module: server-pilot / Outlook VSTO WebView2 task pane
problem_type: security_issue
component: authentication
severity: critical
symptoms:
  - "A workstation.autoAuth mutation that accepted a client-supplied Outlook address would mint a Better Auth session without a password"
  - "That path would bypass mailboxProcedure ACLs and treat any guessed hotel mailbox as the caller"
root_cause: missing_permission
resolution_type: code_fix
related_components:
  - tooling
  - email_processing
tags:
  - outlook
  - vsto
  - webview2
  - better-auth
  - workstation
  - sidepane
---

# Outlook task pane must not mint Better Auth sessions from a self-reported workstation email

## Problem

An Outlook 2016 VSTO pane cannot use Office.js on POP3. The first design minted a Better Auth session from a C# self-reported mailbox address. That is an unauthenticated backdoor into the pilot API.

## Symptoms

- Any process that can POST `workstation.autoAuth` with an email would impersonate that staff user
- Password check and mailbox ACLs would never run for pane traffic

## What Didn't Work

- Passing `outlookEmail` / `workstationUser` on the WebView2 URL as a substitute for login — still client-controlled identity, not a session
- Leaving `workstation.ping` as `publicProcedure` — even telemetry should not be an unauthenticated write surface next to mail APIs

## Solution

Staff sign in once through the existing Better Auth email/password form inside `/outlook-pane`. WebView2 stores cookies in `%LOCALAPPDATA%\NavaOutlookAddin\WebView2Profile`. Subsequent Outlook launches reuse that profile. `workstation.ping` is `privateProcedure`. The C# host loads `https://nava.legacyhotels.co.za/outlook-pane` with no identity query string.

## Prevention

Never add a tRPC mutation that creates a session from a COM-reported address. Pane identity is the Better Auth cookie only. Contract tests must reject anonymous `workstation.ping`.
