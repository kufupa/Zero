import nodemailer from 'nodemailer';
import { Readable } from 'node:stream';

function sanitizeFilenamePart(raw: string): string {
  let cleaned = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) {
      cleaned += '_';
    } else {
      cleaned += raw[i];
    }
  }
  cleaned = cleaned
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
  const codepoints = [...cleaned].slice(0, 60).join('').replace(/^_+|_+$/g, '');
  return codepoints;
}

export function formatEmlFilename(
  subject?: string | null,
  date?: Date | string | null,
): string {
  const cleanSubject = subject ? sanitizeFilenamePart(subject.trim()) : '';
  const dateObj = date ? new Date(date) : new Date();
  const dateStr = Number.isNaN(dateObj.getTime())
    ? new Date().toISOString().slice(0, 10)
    : dateObj.toISOString().slice(0, 10);

  const base = cleanSubject || 'email';
  return `${base}_${dateStr}.eml`;
}

export async function synthesizeRfc822Eml(params: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  date: Date;
  textBody?: string | null;
  htmlBody?: string | null;
  messageId?: string | null;
}): Promise<Buffer> {
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });

  const validDate =
    params.date && !Number.isNaN(params.date.getTime()) ? params.date : new Date();

  const mailOptions: nodemailer.SendMailOptions = {
    from: params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    date: validDate,
    text: params.textBody ?? undefined,
    html: params.htmlBody ?? undefined,
    messageId: params.messageId ?? undefined,
  };

  const info = await transporter.sendMail(mailOptions);
  if (Buffer.isBuffer(info.message)) {
    return info.message;
  }
  if (info.message instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of info.message) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(info.message);
}
