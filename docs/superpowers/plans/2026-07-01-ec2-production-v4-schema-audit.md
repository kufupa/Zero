# V4 Schema Audit

## Current Tables

- user
- session
- account
- userHotkeys
- verification
- earlyAccess
- connection
- summary
- note
- userSettings
- writingStyleMatrix
- jwks
- oauthApplication
- oauthAccessToken
- oauthConsent
- emailTemplate

## Target Mail Tables To Add

- mailIngestMailbox
- mailIngestQuarantine
- mailboxTransport
- mailboxAccess
- mailLabel
- mailThread
- message
- attachment
- mailDraft

## Tables To Keep For Frontend Compatibility

- user
- session
- account
- verification
- note
- userSettings
- emailTemplate

## Tables Not Part Of Mail-Core Pilot

- summary
- writingStyleMatrix
- oauthApplication
- oauthAccessToken
- oauthConsent
- earlyAccess
- userHotkeys

## Decision

Build `apps/server-pilot/` as the runtime backend for this branch. Keep `apps/server/` on disk only as reference unless package/workspace resolution conflicts, in which case de-scope or rename the old backend package so `apps/mail` resolves to `apps/server-pilot`. Frontend callers may be rewritten to mailbox-native routes instead of preserving old backend API shapes.
