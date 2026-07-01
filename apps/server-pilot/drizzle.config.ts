import { type Config } from 'drizzle-kit';

const rawUrl = process.env.DATABASE_URL ?? '';
const url = rawUrl.includes('sslmode=')
  ? rawUrl
  : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}sslmode=require`;

export default {
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
  out: './drizzle',
} satisfies Config;
