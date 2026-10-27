import { z } from 'zod';

export const serializedFileSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number(),
  lastModified: z.number(),
  base64: z.string(),
});

export const deserializeFiles = async (
  serializedFiles: z.infer<typeof serializedFileSchema>[],
): Promise<File[]> => {
  // TODO(task-6): browser/File available at runtime; on node use buffer shim if needed.
  return await Promise.all(
    serializedFiles.map((data) => {
      const buf = Buffer.from(data.base64, 'base64');
      const blob = new Blob([buf], { type: data.type });
      return new File([blob], data.name, {
        type: data.type,
        lastModified: data.lastModified,
      });
    }),
  );
};

export const createDraftData = z.object({
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  message: z.string(),
  attachments: z.array(serializedFileSchema).optional(),
  id: z.string().nullable(),
  threadId: z.string().nullable(),
  fromEmail: z.string().nullable(),
});

export type CreateDraftData = z.infer<typeof createDraftData>;

export const mailCategorySchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-zA-Z0-9\-_ ]+$/,
      'Category ID must contain only alphanumeric characters, hyphens, underscores, and spaces',
    ),
  name: z.string(),
  searchValue: z.string(),
  order: z.number().int(),
  icon: z.string().optional(),
  isDefault: z.boolean().optional().default(false),
});

export type MailCategory = z.infer<typeof mailCategorySchema>;

export const defaultMailCategories: MailCategory[] = [
  {
    id: 'Important',
    name: 'Important',
    searchValue: 'IMPORTANT',
    order: 0,
    icon: 'Lightning',
    isDefault: false,
  },
  {
    id: 'All Mail',
    name: 'All Mail',
    searchValue: '',
    order: 1,
    icon: 'Mail',
    isDefault: true,
  },
  {
    id: 'Unread',
    name: 'Unread',
    searchValue: 'UNREAD',
    order: 5,
    icon: 'ScanEye',
    isDefault: false,
  },
];

const categoriesSchema = z.array(mailCategorySchema).superRefine((cats, ctx) => {
  const orders = cats.map((c) => c.order);
  if (new Set(orders).size !== orders.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Each mail category must have a unique order number',
    });
  }

  const defaultCount = cats.filter((c) => c.isDefault).length;
  if (defaultCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Exactly one mail category must be set as default',
    });
  }
});

/** Per-user default for the HMS confirmation letter. The pane can override it per booking. */
export const confirmationSettingSchema = z.object({
  mode: z.enum(['self', 'client', 'custom']),
  address: z.string().email().optional(),
});

export type ConfirmationSetting = z.infer<typeof confirmationSettingSchema>;

export const userSettingsSchema = z.object({
  language: z.string(),
  timezone: z.string(),
  dynamicContent: z.boolean().optional(),
  externalImages: z.boolean(),
  customPrompt: z.string().default(''),
  isOnboarded: z.boolean().optional(),
  trustedSenders: z.string().array().optional(),
  colorTheme: z.enum(['light', 'dark', 'system']).default('system'),
  zeroSignature: z.boolean().default(false),
  categories: categoriesSchema.optional(),
  defaultEmailAlias: z.string().optional(),
  undoSendEnabled: z.boolean().default(true),
  imageCompression: z.enum(['low', 'medium', 'original']).default('medium'),
  autoRead: z.boolean().default(true),
  animations: z.boolean().default(false),
  // Optional so a row saved before this key still parses. Missing means the default below.
  confirmation: confirmationSettingSchema.optional(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const defaultUserSettings: UserSettings = {
  language: 'en',
  timezone: 'UTC',
  dynamicContent: false,
  externalImages: true,
  customPrompt: '',
  trustedSenders: [],
  isOnboarded: false,
  colorTheme: 'system',
  zeroSignature: false,
  autoRead: true,
  defaultEmailAlias: '',
  categories: defaultMailCategories,
  undoSendEnabled: true,
  imageCompression: 'medium',
  animations: false,
  confirmation: { mode: 'self' },
};
