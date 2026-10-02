# Web-mail HTML security follow-up

Status: Rendering mitigation implemented; real-browser verification remains open.
This does **not** remove legitimate server-side web-mail Send/Delete
functionality and is separate from the one-time Outlook add-in installer.

## What changed

- `MailContent` still uses the client fallback while server `processEmailContent`
  remains disabled for reliability. That fallback now uses a mail-specific
  allowlist sanitizer with the same external-image policy as the server, then
  DOMPurify sanitizes again immediately before Shadow DOM insertion.
- The allowlist drops scripts, event-handler attributes, unsafe URL schemes,
  SVG/embedded content and sender CSS. Remote images are blocked unless staff
  enabled them or trusted the sender; the explicit image opt-in still works.
- The `MailContent` tests cover event handlers, `javascript:` links, blocked
  tracking images and the explicit image opt-in. Other message-body renderers
  (`mail-display`, `thread-display`, quoted history) already use `cleanHtml`.
- The client fallback sanitizer mirrors
  `apps/server-pilot/src/mail/sanitize-email-html.ts`; keep their allowlists and
  image rules in sync when either changes.

## Remaining before pilot sign-off

1. Run event-handler, SVG, protocol and malformed-markup payloads in real
   Chromium and Outlook WebView2. Verify they cannot execute script or invoke
   session-authenticated Send/Delete, including through editor/history views.
2. Review a build-compatible CSP for the full web-mail app separately. Its
   current policy allows inline scripts for the app; do not apply the pane-only
   CSP to the Next.js app without validating sign-in, hydration and controls.
3. Keep the web-mail Send/Delete APIs and `/outlook-pane` bridge contract
   unchanged. The mitigation is not a claim that all same-origin XSS paths or
   historical data have been browser-tested, and no exploit is known to have
   occurred.
