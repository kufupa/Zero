# Feature disable/removal scope: frontend-only demo mode

## 1) Full email alias (general settings)
- Current touchpoints:
  - `apps/mail/app/(routes)/settings/general/page.tsx`
    - General form currently renders `defaultEmailAlias` Select bound to `useEmailAliases`.
    - Form defaults include `defaultEmailAlias`.
  - `apps/mail/components/create/email-composer.tsx`
    - `fromEmail` currently comes from settings/aliases and renders a selectable `<Select>` when aliases > 1.
  - `apps/mail/components/create/create-email.tsx`
    - Builds sender email from `data.fromEmail || aliases?.[0]?.email || session`.
  - `apps/mail/components/mail/reply-composer.tsx`
    - Contains alias-aware sender resolution (`useEmailAliases`) for reply sender selection.
  - `apps/server/src/lib/schemas.ts`, `apps/mail/hooks/use-settings.ts`, `apps/mail/lib/demo/local-store.ts`, `apps/mail/lib/demo/local-actions.ts`
    - Settings defaults and demo fallback currently expose/seed alias data.

## 2) Zero signature
- Current touchpoints:
  - `apps/mail/app/(routes)/settings/general/page.tsx`
    - `zeroSignature` toggle.
  - `apps/mail/components/create/create-email.tsx`
    - Appends `zeroSignature` HTML when enabled.
  - `apps/mail/components/mail/reply-composer.tsx`
    - Appends `zeroSignature` HTML to reply/forward bodies.
  - `apps/mail/components/create/email-composer.tsx`
    - `fromEmail` selection field appears only when multiple aliases exist and is part of the same sender flow.
  - `apps/server/src/lib/schemas.ts`
    - `zeroSignature` in user settings schema/defaults.
  - Demo defaults in:
    - `apps/mail/hooks/use-settings.ts`
    - `apps/mail/lib/demo/local-store.ts`
    - `apps/mail/lib/demo/local-actions.ts`

## 3) Undo send default
- Current touchpoints:
  - `apps/mail/app/(routes)/settings/general/page.tsx`
    - Toggle + description for `undoSendEnabled`.
  - `apps/server/src/lib/schemas.ts`
    - Default for `undoSendEnabled`.
  - `apps/mail/hooks/use-settings.ts`
    - Demo settings fallback default.
  - `apps/mail/lib/demo/local-store.ts` and `apps/mail/lib/demo/local-actions.ts`
    - Demo fallback defaults.

## 4) Connections (UI + backend contact surface)
- Current touchpoints:
  - `apps/mail/config/navigation.ts`
    - Settings sidebar includes Connections item.
  - `apps/mail/app/routes.ts`
    - Registers `/settings/connections`.
  - `apps/mail/app/(routes)/settings/[...settings]/page.tsx`
    - Settings route resolver includes `connections`.
  - `apps/mail/app/(routes)/settings/connections/page.tsx`
    - Full connections management page.
  - `apps/mail/components/ui/nav-user.tsx`
    - Account switching + add/remove/force sync connection actions.
  - `apps/mail/components/connection/add.tsx`
    - Add connection dialog.
  - `apps/mail/useConnec­tions` hooks and server routes used when non-demo environment allows connection operations.
  - `apps/server/src/trpc/routes/connections.ts` (backend module entry).

## 5) Shortcuts (navigation group)
- Current touchpoints:
  - `apps/mail/config/shortcuts.ts`
    - `navigation` shortcut definitions (`g,d`, `g,i`, `g,t`, `g+s`, `g+a`, `g+b`, `? + shift`).
  - `apps/mail/lib/hotkeys/navigation-hotkeys.tsx`
    - Registers handlers for navigation actions.
  - `apps/mail/components/providers/hotkey-provider-wrapper.tsx`
    - Enables `navigation` hotkey scope.
  - `apps/mail/app/(routes)/settings/shortcuts/page.tsx`
    - Renders navigation shortcuts as read-only list entries.

## Planned implementation strategy
- Full email alias:
  - Always resolve from session/active account email, hide user editing of alias.
  - Render a non-editable email address field with label **"Your email address"**.
  - Use this value for compose/reply sender defaults.
- Zero signature:
  - Remove UI toggle.
  - Remove HTML append path from compose and reply flows.
  - Set defaults to disabled where explicitly persisted.
- Undo send:
  - Keep setting UI.
  - Change defaults to enabled in schema and demo fallbacks.
- Connections:
  - Remove user-facing routes/menu entries and page access path.
  - Remove account-switch/add/remove/force-sync controls from nav-user.
  - In demo mode keep backend TRPC client hard-disabled so no live connection network path is used.
- Navigation shortcuts:
  - Remove navigation shortcut definitions and no-op navigation hotkey registration.
  - Keep other shortcut groups intact.
