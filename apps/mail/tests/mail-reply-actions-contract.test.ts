import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../components/mail/mail-display.tsx', import.meta.url), 'utf8');
const threadSource = readFileSync(new URL('../components/mail/thread-display.tsx', import.meta.url), 'utf8');
const threadContextSource = readFileSync(
  new URL('../components/context/thread-context.tsx', import.meta.url),
  'utf8',
);
const shortcutsSource = readFileSync(new URL('../config/shortcuts.ts', import.meta.url), 'utf8');
const hotkeysSource = readFileSync(
  new URL('../lib/hotkeys/thread-display-hotkeys.tsx', import.meta.url),
  'utf8',
);
const mailBodyAnchor = '{/* mail main body */}';
const actionGroupPattern = /role="group"\s+aria-label="Message reply actions"/g;
const threadToolbarActionGroupPattern = /role="group"\s+aria-label="Thread reply actions"/g;

const actionGroupIndexes = () =>
  [...source.matchAll(actionGroupPattern)].map((match) => match.index ?? -1);

const actionGroupSource = () => {
  const [actionGroupIndex] = actionGroupIndexes();
  const actionGroupStart = source.lastIndexOf('<div', actionGroupIndex);
  const actionGroupEnd = source.indexOf('</div>', actionGroupIndex);

  return source.slice(actionGroupStart, actionGroupEnd + '</div>'.length);
};

const actionButtonSource = () => {
  const actionButtonStart = source.indexOf('const ActionButton =');
  const actionButtonEnd = source.indexOf('const downloadAttachment', actionButtonStart);

  if (actionButtonStart < 0 || actionButtonEnd <= actionButtonStart) {
    throw new Error('Could not bound per-message ActionButton');
  }

  return source.slice(actionButtonStart, actionButtonEnd);
};

const threadToolbarActionGroupIndexes = () =>
  [...threadSource.matchAll(threadToolbarActionGroupPattern)].map((match) => match.index ?? -1);

const threadToolbarActionGroupSource = () => {
  const [actionGroupIndex] = threadToolbarActionGroupIndexes();
  if (actionGroupIndex < 0) return '';

  const actionGroupStart = threadSource.lastIndexOf('<div', actionGroupIndex);
  const actionGroupEnd = threadSource.indexOf('</div>', actionGroupIndex);

  return threadSource.slice(actionGroupStart, actionGroupEnd + '</div>'.length);
};

const listContextPrimaryActionsSource = () => {
  const primaryActionsStart = threadContextSource.indexOf(
    'const primaryActions: EmailAction[] = useMemo(',
  );
  const primaryActionsEnd = threadContextSource.indexOf('  const handleDelete', primaryActionsStart);

  return threadContextSource.slice(primaryActionsStart, primaryActionsEnd);
};

const listContextActionSource = (id: string) => {
  const primaryActions = listContextPrimaryActionsSource();
  const actionStart = primaryActions.indexOf(`id: '${id}'`);
  const actionEnd = primaryActions.indexOf('\n      },', actionStart);

  return primaryActions.slice(actionStart, actionEnd + '\n      },'.length);
};

const listContextReplyHandlerSource = (handlerName: string) => {
  const handlerStart = threadContextSource.indexOf(`  const ${handlerName} = () => {`);
  const handlerEnd = threadContextSource.indexOf('\n\n  const ', handlerStart + 1);

  return threadContextSource.slice(handlerStart, handlerEnd);
};

const listContextMenuContentSource = () => {
  const primaryActionsStart = threadContextSource.indexOf(
    'const primaryActions: EmailAction[] = useMemo(',
  );
  const contentStart = threadContextSource.indexOf('<ContextMenuContent', primaryActionsStart);
  const contentEnd = threadContextSource.indexOf('</ContextMenuContent>', contentStart);

  if (primaryActionsStart < 0 || contentStart < 0 || contentEnd <= contentStart) {
    throw new Error('Could not bound list context menu content');
  }

  return threadContextSource.slice(contentStart, contentEnd + '</ContextMenuContent>'.length);
};

const threadDisplayShortcutsSource = () => {
  const shortcutStart = shortcutsSource.indexOf('const threadDisplayShortcuts: Shortcut[] = [');
  const shortcutEnd = shortcutsSource.indexOf('const navigation', shortcutStart);

  return shortcutsSource.slice(shortcutStart, shortcutEnd);
};

const threadDisplayShortcutSource = (key: string) => {
  const shortcuts = threadDisplayShortcutsSource();
  const shortcutStart = shortcuts.indexOf(`keys: ['${key}'],`);
  const shortcutEnd = shortcuts.indexOf('\n  },', shortcutStart);

  if (shortcutStart < 0 || shortcutEnd <= shortcutStart) {
    throw new Error(`Could not bound thread-display ${key} shortcut`);
  }

  return shortcuts.slice(shortcutStart, shortcutEnd + '\n  },'.length);
};

const threadDisplayHotkeyHandlerSource = (action: string) => {
  const handlerStart = hotkeysSource.indexOf(`    ${action}: () => {`);
  const handlerEnd = hotkeysSource.indexOf('\n    },', handlerStart);

  if (handlerStart < 0 || handlerEnd <= handlerStart) {
    throw new Error(`Could not bound thread-display ${action} hotkey handler`);
  }

  return hotkeysSource.slice(handlerStart, handlerEnd + '\n    },'.length);
};

const messageEllipsisMenuSource = () => {
  const menuAnchor = source.indexOf('{/* options menu */}');
  const menuStart = source.indexOf('<DropdownMenu>', menuAnchor);
  const menuEnd = source.indexOf('</DropdownMenu>', menuStart);

  if (menuAnchor < 0 || menuStart <= menuAnchor || menuEnd <= menuStart) {
    throw new Error('Could not bound message ellipsis menu');
  }

  return source.slice(menuStart, menuEnd + '</DropdownMenu>'.length);
};

const threadEllipsisMenuSource = () => {
  const menuAnchor = threadSource.indexOf('aria-label="Thread actions"');
  const menuStart = threadSource.lastIndexOf('<DropdownMenu>', menuAnchor);
  const menuEnd = threadSource.indexOf('</DropdownMenu>', menuStart);

  if (
    menuAnchor < 0 ||
    menuStart < 0 ||
    menuEnd < 0 ||
    menuStart >= menuAnchor ||
    menuEnd <= menuAnchor
  ) {
    throw new Error('Could not bound thread ellipsis menu');
  }

  return threadSource.slice(menuStart, menuEnd + '</DropdownMenu>'.length);
};

describe('per-message reply actions', () => {
  it('places one named action group in the recipient header before the mail body', () => {
    const [actionGroupIndex] = actionGroupIndexes();
    const mailBodyIndex = source.indexOf(mailBodyAnchor);

    expect(actionGroupIndexes()).toHaveLength(1);
    expect(actionGroupIndex).toBeLessThan(mailBodyIndex);
  });

  it('keeps each compose handler and stop-propagation behavior in that group', () => {
    const actionGroup = actionGroupSource();

    for (const mode of ['reply', 'replyAll', 'forward']) {
      expect(actionGroup).toMatch(
        new RegExp(
          `onClick=\\{\\(e\\) => \\{\\s*e\\.stopPropagation\\(\\);\\s*openComposeForMessage\\('${mode}'\\);\\s*\\}\\}`,
        ),
      );
    }
  });

  it('removes the body-bottom reply action row', () => {
    expect(source).not.toContain('<div className="my-2.5 flex gap-2 px-4">');
  });

  it('keeps recipient content shrinkable and action controls native and labelled', () => {
    const recipientHeaderIndex = source.indexOf('className={MAIL_RECIPIENT_HEADER_CLASS}');
    const mailBodyIndex = source.indexOf(mailBodyAnchor);
    const recipientHeader = source.slice(recipientHeaderIndex, mailBodyIndex);
    const actionGroup = actionGroupSource();

    expect(recipientHeader).toContain('MAIL_RECIPIENT_FIELDS_CLASS');
    expect(recipientHeader).toMatch(actionGroupPattern);
    expect(actionGroup.match(/<ActionButton\b/g)).toHaveLength(3);
    expect(actionGroup).toContain("text={m['common.mail.reply']()}");
    expect(actionGroup).toContain("text={m['common.mail.replyAll']()}");
    expect(actionGroup).toContain("text={m['common.mail.forward']()}");
    expect(source).toMatch(
      /const ActionButton =[\s\S]*?<button\s+[\s\S]*?type="button"[\s\S]*?\{text\}/,
    );
  });

  it('keeps recipient summaries and action controls pane-contained without visual hotkey badges', () => {
    const recipientHeaderIndex = source.indexOf('className={MAIL_RECIPIENT_HEADER_CLASS}');
    const mailBodyIndex = source.indexOf(mailBodyAnchor);
    const recipientHeader = source.slice(recipientHeaderIndex, mailBodyIndex);
    const actionGroup = actionGroupSource();
    const actionButton = actionButtonSource();

    expect(recipientHeader.match(/MAIL_RECIPIENT_LINE_CLASS/g) ?? []).toHaveLength(3);
    expect(recipientHeader).toContain('MAIL_RECIPIENT_FIELDS_CLASS');
    expect(actionGroup).toContain('flex w-full max-w-full flex-wrap');
    expect(actionGroup).not.toContain('sm:w-auto');
    // Compact pane: drop outer shrink-0; labels show from md up only.
    expect(actionButton).not.toMatch(/<button[\s\S]*?className="[^"]*\bshrink-0\b/);
    expect(actionButton).toMatch(/hidden[^"]*md:inline|md:inline[^"]*hidden/);
    expect(actionButton).toContain('whitespace-nowrap');
    expect(actionButton).toMatch(/aria-label=\{(?:ariaLabelProp\s*\?\?\s*ariaLabel\s*\?\?\s*)?text\}/);
    expect(actionButton).not.toContain('shortcut?: string');
    expect(actionButton).not.toContain('shortcut &&');
    expect(actionButton).not.toContain('<kbd');
    expect(actionGroup).not.toContain('shortcut={');
  });

  it('keeps message header flex ancestor chain shrinkable with min-w-0', () => {
    expect(source).toContain('className="mt-3 flex w-full min-w-0 items-start justify-between gap-4 px-4"');
    expect(source).toContain('className="flex w-full min-w-0 justify-center gap-4"');
    expect(source).toContain('className="flex w-full min-w-0 items-center justify-between"');
    expect(source).toContain('className="flex w-full min-w-0 items-center justify-start"');
    expect(source).toContain('className="flex w-full min-w-0 flex-col"');
    // Timestamp cluster stays shrink-0; sender name must truncate (MailboxInline).
    expect(source).toContain('className="flex shrink-0 items-center justify-center"');
  });

  it('bounds the recipient+actions row below unwrapped To/Cc min-content', () => {
    // Column flex item with default min-width:auto sizes to the unwrapped
    // recipient string; overflow-x-clip then hides names. This node must
    // import the bounded header class — ancestor min-w-0 is not enough.
    expect(source).toContain('className={MAIL_RECIPIENT_HEADER_CLASS}');
    expect(source).toContain('className={MAIL_RECIPIENT_FIELDS_CLASS}');
  });

  it('wraps each To/Cc/Bcc field at recipient boundaries inside a width-bounded line', () => {
    const recipientHeaderIndex = source.indexOf('className={MAIL_RECIPIENT_HEADER_CLASS}');
    const mailBodyIndex = source.indexOf(mailBodyAnchor);
    const recipientHeader = source.slice(recipientHeaderIndex, mailBodyIndex);

    expect(recipientHeader).toContain('MAIL_RECIPIENT_LINE_CLASS');
    expect(recipientHeader).toContain('MAIL_RECIPIENT_ITEM_CLASS');
    expect(source).toContain('className={MAIL_RECIPIENT_ITEM_CLASS}');
  });
});

describe('thread toolbar reply actions', () => {
  it('places one named reply-action group before NotesPanel', () => {
    const [actionGroupIndex] = threadToolbarActionGroupIndexes();
    const notesPanelIndex = threadSource.indexOf('<NotesPanel');

    expect(threadToolbarActionGroupIndexes()).toHaveLength(1);
    expect(actionGroupIndex).toBeLessThan(notesPanelIndex);
  });

  it('keeps each latest-message compose handler and stop-propagation behavior in that group', () => {
    const actionGroup = threadToolbarActionGroupSource();

    for (const mode of ['reply', 'replyAll', 'forward']) {
      expect(actionGroup).toMatch(
        new RegExp(
          `onClick=\\{\\(e\\) => \\{\\s*e\\.stopPropagation\\(\\);\\s*openComposeForLatestMessage\\('${mode}'\\);\\s*\\}\\}`,
        ),
      );
    }
  });

  it('uses native Reply, Reply all, and Forward controls with ReplyAll icon and compact labels', () => {
    const actionGroup = threadToolbarActionGroupSource();

    expect(actionGroup.match(/<button\b/g) ?? []).toHaveLength(3);
    expect(actionGroup.match(/type="button"/g) ?? []).toHaveLength(3);
    expect(actionGroup).toContain('<ReplyAll');
    expect(actionGroup).toContain("{m['common.mail.reply']()}");
    expect(actionGroup).toContain("{m['common.threadDisplay.replyAll']()}");
    expect(actionGroup).toContain("{m['common.mail.forward']()}");
    // Labels icon-only below md so Forward stays inside narrow panes.
    expect(actionGroup).toMatch(/hidden[^"'\n]*md:inline|md:inline[^"'\n]*hidden/);
  });

  it('removes old standalone Reply all button and keeps toolbar wrapping contained', () => {
    const notesPanelIndex = threadSource.indexOf('<NotesPanel');
    const actionsClusterStart = threadSource.lastIndexOf(
      'flex w-full min-w-0 flex-wrap items-center justify-end gap-2',
      notesPanelIndex,
    );
    const toolbar = threadSource.slice(actionsClusterStart, notesPanelIndex);

    expect(actionsClusterStart).toBeGreaterThan(-1);
    expect(threadSource).not.toContain(
      '<div className="flex items-center justify-center gap-2.5 pl-0.5 pr-1">',
    );
    expect(toolbar).toContain('w-full');
    expect(toolbar).toContain('min-w-0');
    expect(toolbar).toContain('flex-wrap');
  });
});

describe('existing context-menu and keyboard reply surfaces', () => {
  it('preserves list context reply action IDs, labels, and latest-message modes', () => {
    const primaryActions = listContextPrimaryActionsSource();
    const contextMenuContent = listContextMenuContentSource();

    expect(primaryActions).toContain('const primaryActions: EmailAction[] = useMemo(');
    expect(contextMenuContent).toContain('{primaryActions.map(renderAction)}');

    for (const { id, label, handler, mode } of [
      {
        id: 'reply',
        label: "m['common.mail.reply']()",
        handler: 'handleThreadReply',
        mode: 'reply',
      },
      {
        id: 'reply-all',
        label: "m['common.mail.replyAll']()",
        handler: 'handleThreadReplyAll',
        mode: 'replyAll',
      },
      {
        id: 'forward',
        label: "m['common.mail.forward']()",
        handler: 'handleThreadForward',
        mode: 'forward',
      },
    ]) {
      const action = listContextActionSource(id);
      const handlerSource = listContextReplyHandlerSource(handler);

      expect(action).toContain(`id: '${id}'`);
      expect(action).toContain(`label: ${label},`);
      expect(action).toContain(`action: ${handler},`);
      expect(handlerSource).toContain('void openReplyComposeContext({');
      expect(handlerSource).toContain(`mode: '${mode}',`);
      expect(handlerSource).toContain('messageId: threadData?.latest?.id ?? null,');
    }
  });

  it('keeps r, a, and f mapped to latest-message reply compose handlers', () => {
    for (const { key, action, mode } of [
      { key: 'r', action: 'reply', mode: 'reply' },
      { key: 'a', action: 'replyAll', mode: 'replyAll' },
      { key: 'f', action: 'forward', mode: 'forward' },
    ]) {
      const shortcut = threadDisplayShortcutSource(key);
      const handler = threadDisplayHotkeyHandlerSource(action);

      expect(shortcut).toContain(`keys: ['${key}'],`);
      expect(shortcut).toContain(`action: '${action}',`);
      expect(handler).toContain('void openReplyComposeContext({');
      expect(handler).toContain(`mode: '${mode}',`);
      expect(handler).toContain('messageId: thread?.latest?.id ?? null,');
    }
  });

  it('keeps message and thread ellipsis menus free of reply compose handlers', () => {
    const messageEllipsisMenu = messageEllipsisMenuSource();
    const threadEllipsisMenu = threadEllipsisMenuSource();

    expect(messageEllipsisMenu).toContain('printMail();');
    expect(messageEllipsisMenu).not.toContain('openComposeForMessage');
    expect(messageEllipsisMenu).not.toContain('openComposeForLatestMessage');
    expect(threadEllipsisMenu).toContain('aria-label="Thread actions"');
    expect(threadEllipsisMenu).not.toContain('openComposeForMessage');
    expect(threadEllipsisMenu).not.toContain('openComposeForLatestMessage');
  });
});
