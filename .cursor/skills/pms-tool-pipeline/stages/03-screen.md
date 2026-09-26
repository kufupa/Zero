# 3 Screen

Checks: `screen.png`, `screen.options.opened`

Load: `building-hms-playwright-tools` rails + `references/traps.md`.

Driver: Astra xhigh, one session, resumed. Brief ≤1500 chars: tool, screens, output path, stop rule. Pass `01-docs.json` path, not contents.

Walk every screen/dialog the docs name. Per control record:
- `label`, `domKey` (name/id attr), `required` (asterisk / validation), `type` (text|select|lookup|checkbox|date|number|button|grid)
- select: open it, copy **every** option verbatim → `options`, `optionsOpened: true`
- disabled/gray: do the click the docs name (e.g. set count → child ages appear), recheck, record both states
- lookup dialog: search fields, result grid columns, paging, empty-result text
- `hold` actions on an unsaved form: do, png what auto-filled, close without Save
- png per control or group → `png/<id>.png`

Output `03-screen.json`:

```json
{
  "controls": [
    { "id": "scr.org.name", "label": "Organization Name", "domKey": "orgname", "required": false, "type": "text", "png": "png/org-dialog.png" }
  ],
  "autoFills": [ { "trigger": "scr.org.select", "changed": ["araccountname"], "png": "png/org-linked.png" } ]
}
```

Stop: any `write` click → `STOP.md reason: dangerous_click`.
