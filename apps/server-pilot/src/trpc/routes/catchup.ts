import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailCatchupUpload } from '../../db/schema/mail-catchup-upload.js';
import { isCatchupUploadEnabled } from '../../env.js';
import {
  MAX_CATCHUP_FILE_BYTES,
  SINGLE_PUT_THRESHOLD_BYTES,
  MPU_PART_SIZE_BYTES,
  sanitizeCatchupFilename,
  assertCatchupAllowedFile,
  contentTypeForCatchupFilename,
  buildCatchupS3Key,
  presignCatchupPut,
  createCatchupMultipart,
  presignCatchupPart,
  completeCatchupMultipart,
  abortCatchupMultipart,
  headCatchupObject,
} from '../../storage/catchup-upload.js';

const catchupProcedure = privateProcedure.use(({ next }) => {
  if (!isCatchupUploadEnabled()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Centurion catch-up upload is currently disabled',
    });
  }
  return next();
});

export const catchupRouter = tRouter({
  initUpload: catchupProcedure
    .input(
      z.object({
        filename: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(MAX_CATCHUP_FILE_BYTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        assertCatchupAllowedFile(input.filename, input.sizeBytes);
      } catch (err: unknown) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const db = getDb();
      const uploadId = randomUUID();
      const safeFilename = sanitizeCatchupFilename(input.filename);
      const contentType = contentTypeForCatchupFilename(safeFilename);
      const s3Key = buildCatchupS3Key(ctx.sessionUser.id, uploadId, safeFilename);

      if (input.sizeBytes <= SINGLE_PUT_THRESHOLD_BYTES) {
        // Single direct PUT
        const { uploadUrl, headers } = await presignCatchupPut({
          key: s3Key,
          contentType,
        });

        await db.insert(mailCatchupUpload).values({
          id: uploadId,
          userId: ctx.sessionUser.id,
          originalFilename: safeFilename,
          contentType,
          sizeBytes: input.sizeBytes,
          s3Key,
          s3UploadId: null,
          status: 'pending',
        });

        return {
          uploadId,
          mode: 'single' as const,
          key: s3Key,
          putUrl: uploadUrl,
          putHeaders: headers,
        };
      }

      // S3 Multipart Upload
      const s3UploadId = await createCatchupMultipart({
        key: s3Key,
        contentType,
      });

      const numParts = Math.ceil(input.sizeBytes / MPU_PART_SIZE_BYTES);
      const partPromises = Array.from({ length: numParts }, (_, i) =>
        presignCatchupPart({
          key: s3Key,
          uploadId: s3UploadId,
          partNumber: i + 1,
        }),
      );
      const parts = await Promise.all(partPromises);

      await db.insert(mailCatchupUpload).values({
        id: uploadId,
        userId: ctx.sessionUser.id,
        originalFilename: safeFilename,
        contentType,
        sizeBytes: input.sizeBytes,
        s3Key,
        s3UploadId,
        status: 'pending',
      });

      return {
        uploadId,
        mode: 'multipart' as const,
        key: s3Key,
        s3UploadId,
        partSizeBytes: MPU_PART_SIZE_BYTES,
        parts,
      };
    }),

  completeUpload: catchupProcedure
    .input(
      z.object({
        uploadId: z.string().min(1),
        parts: z
          .array(
            z.object({
              partNumber: z.number().int().positive(),
              etag: z.string().min(1),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(mailCatchupUpload)
        .where(
          and(
            eq(mailCatchupUpload.id, input.uploadId),
            eq(mailCatchupUpload.userId, ctx.sessionUser.id),
          ),
        );

      const row = rows[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Catch-up upload not found',
        });
      }

      if (row.status === 'stored') {
        return { ok: true, status: 'stored' as const, uploadId: row.id };
      }

      if (row.status === 'aborted') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Catch-up upload was aborted',
        });
      }

      if (row.s3UploadId) {
        if (!input.parts || input.parts.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Multipart upload requires part etags to complete',
          });
        }
        await completeCatchupMultipart({
          key: row.s3Key,
          uploadId: row.s3UploadId,
          parts: input.parts,
          totalSizeBytes: row.sizeBytes,
        });
      }

      // Verify object exists in storage
      const head = await headCatchupObject(row.s3Key);
      if (!head) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Uploaded file not found in storage',
        });
      }

      await db
        .update(mailCatchupUpload)
        .set({
          status: 'stored',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mailCatchupUpload.id, row.id));

      return { ok: true, status: 'stored' as const, uploadId: row.id };
    }),

  abortUpload: catchupProcedure
    .input(z.object({ uploadId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(mailCatchupUpload)
        .where(
          and(
            eq(mailCatchupUpload.id, input.uploadId),
            eq(mailCatchupUpload.userId, ctx.sessionUser.id),
          ),
        );

      const row = rows[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Catch-up upload not found',
        });
      }

      if (row.status === 'stored') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot abort an already completed upload',
        });
      }

      if (row.status === 'aborted') {
        return { ok: true, status: 'aborted' as const, uploadId: row.id };
      }

      if (row.s3UploadId) {
        await abortCatchupMultipart({
          key: row.s3Key,
          uploadId: row.s3UploadId,
        });
      }

      await db
        .update(mailCatchupUpload)
        .set({
          status: 'aborted',
          updatedAt: new Date(),
        })
        .where(eq(mailCatchupUpload.id, row.id));

      return { ok: true, status: 'aborted' as const, uploadId: row.id };
    }),

  listMine: catchupProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        id: mailCatchupUpload.id,
        originalFilename: mailCatchupUpload.originalFilename,
        contentType: mailCatchupUpload.contentType,
        sizeBytes: mailCatchupUpload.sizeBytes,
        status: mailCatchupUpload.status,
        createdAt: mailCatchupUpload.createdAt,
        completedAt: mailCatchupUpload.completedAt,
      })
      .from(mailCatchupUpload)
      .where(eq(mailCatchupUpload.userId, ctx.sessionUser.id))
      .orderBy(desc(mailCatchupUpload.createdAt));

    return rows;
  }),
});
