# Urgent separate follow-up: web-mail HTML boundary

Status: OPEN — owner and date must be assigned before a pilot security sign-off.
This is **not** part of the one-time Outlook add-in v4 upgrade and must not
remove legitimate server-side web-mail Send/Delete functionality.

## Why this needs a separate decision

- `apps/mail/components/mail/mail-content.tsx` currently disables the server
  `processEmailContent` gate for reliability and writes fallback HTML into a
  ShadowRoot using `innerHTML`. `apps/mail/lib/mail/resolve-mail-html.ts`
  removes `<script>` tags with a regex, but does not independently sanitize
  arbitrary HTML attributes or URLs on that fallback path.
- Incoming mail is normally sanitized when stored by the server. The fallback
  can still receive other, older, test, or differently sourced HTML; the
  renderer should be safe **independently** of where content came from.
  The generic web-mail Nginx policy still allows `script-src 'unsafe-inline'`.
- A same-origin script running under an authenticated web-mail staff session
  could call the existing web-mail `mail.send`/`mail.delete` APIs. The new
  pane-only CSP and native command restrictions do not protect those routes.
  This is a **conditional exposure**, not a claim that an exploit has occurred.

## Acceptance criteria for the separately scoped fix

1. Define and enforce one defensible HTML sanitization boundary on **every**
   web-mail rendering path, including fallback/quoted history and historical
   records, without dropping CID images, safe links or required Outlook-like
   email formatting. Treat sanitizer failure as plain text or a safe placeholder.
2. Test real browser behavior against event-handler, SVG, protocol and malformed
   markup vectors; demonstrate that mail content cannot execute JS or call a
   session-authenticated Send/Delete API. Also cover message import and editor
   history paths, not just a simple `<script>` tag.
3. Evaluate a build-compatible, route-scoped script CSP for web mail without
   breaking sign-in/hydration/buttons. Keep staff Send/Delete APIs and the
   installed `/outlook-pane` bridge contract unchanged. Run release smoke tests
   under a named operator and rollback owner before shipping.

Assign an owner and target date during the v4 release review. Do not present
the native v4 rollout as remediation of this independent same-origin risk.
