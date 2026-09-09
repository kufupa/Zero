import { getDb } from '../db/client.js';
import { message, mailboxAccess } from '../db/schema/mail.js';
import { getS3Storage } from '../storage/s3.js';
import { synthesizeRfc822Eml, formatEmlFilename } from '../mail/eml-export.js';
import { formatContentDispositionFilename } from '../mail/attachment-filename.js';
import type { Auth } from '../lib/auth.js';
import type { DB } from '../db/client.js';
import { and, eq } from 'drizzle-orm';

export type EmlDownloadDeps = {
  getSession: (req: Request) => Promise<{ user: { id: string } } | null>;
  loadAuthorizedMessage: (args: {
    userId: string;
    messageId: string;
  }) => Promise<typeof message.$inferSelect | null>;
  getRawMime?: (s3Key: string) => Promise<Buffer | null>;
  synthesizeEml?: typeof synthesizeRfc822Eml;
};

/**
 * Load message only when session user has mailbox_access on the message's transport.
 */
export async function loadAuthorizedMessage(
  db: DB,
  args: { userId: string; messageId: string },
): Promise<typeof message.$inferSelect | null> {
  const rows = await db
    .select({ message })
    .from(message)
    .innerJoin(mailboxAccess, eq(mailboxAccess.transportId, message.transportId))
    .where(
      and(
        eq(message.id, args.messageId),
        eq(mailboxAccess.userId, args.userId),
      ),
    )
    .limit(1);

  return rows[0]?.message ?? null;
}

export function createEmlDownloadHandler(
  authOrDeps: Auth | EmlDownloadDeps,
  overrides?: Partial<EmlDownloadDeps>,
) {
  let deps: EmlDownloadDeps;

  if ('api' in authOrDeps && typeof authOrDeps.api?.getSession === 'function') {
    const auth = authOrDeps;
    deps = {
      getSession: async (req) => {
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session?.user?.id) return null;
        return { user: { id: session.user.id } };
      },
      loadAuthorizedMessage: (args) => loadAuthorizedMessage(getDb(), args),
      getRawMime: async (s3Key) => {
        const storage = getS3Storage();
        const obj = await storage.getObject(s3Key);
        return obj?.body ?? null;
      },
      synthesizeEml: synthesizeRfc822Eml,
      ...overrides,
    };
  } else {
    deps = {
      getRawMime: async (s3Key) => {
        const storage = getS3Storage();
        const obj = await storage.getObject(s3Key);
        return obj?.body ?? null;
      },
      synthesizeEml: synthesizeRfc822Eml,
      ...(authOrDeps as EmlDownloadDeps),
      ...overrides,
    };
  }

  return async (req: Request, params: { messageId: string }): Promise<Response> => {
    try {
      const session = await deps.getSession(req);
      if (!session?.user?.id) {
        return new Response('Unauthorized', { status: 401 });
      }

      const msg = await deps.loadAuthorizedMessage({
        userId: session.user.id,
        messageId: params.messageId,
      });

      if (!msg) {
        return new Response('Not Found', { status: 404 });
      }

      const filename = formatEmlFilename(msg.subject, msg.receivedAt ?? msg.sentAt);

      let emlBuffer: Buffer;
      if (msg.rawMimeS3Key) {
        const getRaw = deps.getRawMime ?? (async (s3Key: string) => {
          const storage = getS3Storage();
          const obj = await storage.getObject(s3Key);
          return obj?.body ?? null;
        });
        const raw = await getRaw(msg.rawMimeS3Key);
        if (raw) {
          emlBuffer = raw;
        } else {
          const synth = deps.synthesizeEml ?? synthesizeRfc822Eml;
          emlBuffer = await synth({
            from: msg.fromAddress,
            to: (msg.toAddresses as string[]) ?? [],
            cc: (msg.ccAddresses as string[]) ?? [],
            bcc: (msg.bccAddresses as string[]) ?? [],
            subject: msg.subject ?? '',
            date: msg.receivedAt ?? msg.sentAt ?? new Date(),
            textBody: msg.textBody,
            htmlBody: msg.htmlBody,
            messageId: msg.messageIdHeader,
          });
        }
      } else {
        const synth = deps.synthesizeEml ?? synthesizeRfc822Eml;
        emlBuffer = await synth({
          from: msg.fromAddress,
          to: (msg.toAddresses as string[]) ?? [],
          cc: (msg.ccAddresses as string[]) ?? [],
          bcc: (msg.bccAddresses as string[]) ?? [],
          subject: msg.subject ?? '',
          date: msg.receivedAt ?? msg.sentAt ?? new Date(),
          textBody: msg.textBody,
          htmlBody: msg.htmlBody,
          messageId: msg.messageIdHeader,
        });
      }

      return new Response(emlBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'message/rfc822',
          'Content-Disposition': formatContentDispositionFilename(filename),
          'Content-Length': String(emlBuffer.length),
          'Cache-Control': 'private, no-cache',
        },
      });
    } catch (err) {
      console.error('Error serving .eml download:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}
