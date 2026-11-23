import { extractForwardedSender } from './party-matching.js';

const historyLimit = 1500;
const historyLabel = '[Quoted history; earlier correspondence]';
const truncated = '\n[Quoted history truncated]';

function compactBody(body: string, subject: string): string {
  const replyHeader = /^[ \t]*(?:>[ \t]*)*(?:-{2,}[ \t]*(?:Original Message|Forwarded message)[ \t]*-{2,}[ \t]*$|On[ \t]+[^\r\n]+(?:\r?\n[^\r\n]+){0,2}?[ \t]+wrote:[ \t]*$|\*?From:\*?[ \t]*[^\r\n]+\r?\n(?:[ \t]*\r?\n)*[ \t]*(?:>[ \t]*)*\*?Sent:\*?)/im;
  const boundary = replyHeader.exec(body);
  const head = boundary ? body.slice(0, boundary.index) : body;
  const quotedLine = /^[ \t]*>.*$/gm;
  const inlineQuotes = head.match(quotedLine) ?? [];
  if (!boundary && !inlineQuotes.length) return body;

  const current = head.replace(quotedLine, '').trimEnd();
  if (/^(?:fw|fwd):/i.test(subject.trimStart()) && current.trim().length < 300) return body;

  let history = [...inlineQuotes, ...(boundary ? [body.slice(boundary.index)] : [])].join('\n').trimEnd();
  let first = '';
  if (current.trim().length < 300 || /\b(?:below|attached|trailing\s+(?:mail|email|message|thread))\b/i.test(current)) {
    const start = boundary ? inlineQuotes.join('\n').length + (inlineQuotes.length ? 1 : 0) + boundary[0].length : 0;
    const older = boundary ? replyHeader.exec(history.slice(start)) : null;
    const cut = older ? start + older.index : history.length;
    first = history.slice(0, cut).trimEnd();
    history = history.slice(cut);
  }

  const budget = historyLimit - historyLabel.length - 1;
  const excerpt = history.length > budget ? history.slice(0, budget - truncated.length) + truncated : history;
  return [current, first && '[First quoted message]\n' + first, excerpt && historyLabel + '\n' + excerpt].filter(Boolean).join('\n\n');
}

function mailFromAddress(mail: Record<string, unknown>): string | null {
  if (typeof mail.from_address === 'string' && mail.from_address.trim()) return mail.from_address;
  const from = mail.from;
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    const email = (from as {email?: unknown}).email;
    if (typeof email === 'string' && email.trim()) return email;
  }
  return null;
}

function withForwardedClientHeader(body: string, subject: string, fromAddress: string | null): string {
  if (!fromAddress || !/(?:^|@)(?:[^@\s]*\.)?legacyhotels?\.(?:com|co\.za)$/i.test(fromAddress)) return body;
  const {innerEmail, staffInstruction} = extractForwardedSender(body, subject);
  if (!innerEmail) return body;
  const instruction = staffInstruction ? ` | Staff instruction: ${staffInstruction}` : '';
  return `[Forwarded client sender: ${innerEmail}${instruction}]\n${body}`;
}

// Apply only to model evidence, including copies in historical source events.
export function mailPrompt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mailPrompt);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const mail = Object.fromEntries(entries.map(([key, item]) => [key, mailPrompt(item)]));
  if (typeof mail.subject !== 'string') return mail;
  const fromAddress = mailFromAddress(mail);
  for (const key of ['body_text', 'body']) {
    const original = mail[key];
    if (typeof original !== 'string') continue;
    const compact = compactBody(original, mail.subject);
    const next = withForwardedClientHeader(compact, mail.subject, fromAddress);
    if (next !== original) {
      mail[key] = next;
      if ('body_html' in mail) mail.body_html = null;
    }
  }
  return mail;
}
