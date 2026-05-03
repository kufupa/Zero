import { z } from 'zod';

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
});

export type MailSettings = z.infer<typeof userSettingsSchema>;

export const defaultUserSettings: MailSettings = {
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
};
