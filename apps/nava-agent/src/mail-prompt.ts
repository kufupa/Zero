const historyLimit = 1500;
const historyLabel = '[Quoted history; earlier correspondence]';
const truncated = '\n[Quoted history truncated]';

function compactBody(body: string, subject: string): string {
  const boundary = /^[ \t]*(?:-{2,}[ \t]*(?:Original Message|Forwarded message)[ \t]*-{2,}[ \t]*$|On[ \t]+[^\r\n]+(?:\r?\n[^\r\n]+){0,2}?[ \t]+wrote:[ \t]*$|From:[ \t]*[^\r\n]+\r?\n(?:[ \t]*\r?\n)*[ \t]*Sent:)/im.exec(body);
  const head = boundary ? body.slice(0, boundary.index) : body;
  const quotedLine = /^[ \t]*>.*$/gm;
  const inlineQuotes = head.match(quotedLine) ?? [];
  if (!boundary && !inlineQuotes.length) return body;

  const current = head.replace(quotedLine, '').trimEnd();
  if (/^(?:fw|fwd):/i.test(subject.trimStart()) && current.trim().length < 300) return body;

  const history = [...inlineQuotes, ...(boundary ? [body.slice(boundary.index)] : [])].join('\n').trimEnd();
  const budget = historyLimit - historyLabel.length - 1;
  const excerpt = history.length > budget ? history.slice(0, budget - truncated.length) + truncated : history;
  return (current ? current + '\n\n' : '') + historyLabel + '\n' + excerpt;
}

// Apply only to model evidence, including copies in historical source events.
export function mailPrompt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mailPrompt);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const mail = Object.fromEntries(entries.map(([key, item]) => [key, mailPrompt(item)]));
  if (typeof mail.subject !== 'string') return mail;
  for (const key of ['body_text', 'body']) {
    const original = mail[key];
    if (typeof original !== 'string') continue;
    const compact = compactBody(original, mail.subject);
    if (compact !== original) {
      mail[key] = compact;
      if ('body_html' in mail) mail.body_html = null;
    }
  }
  return mail;
}
