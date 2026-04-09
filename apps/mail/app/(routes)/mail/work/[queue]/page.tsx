import { useLoaderData } from 'react-router';

import { MailLayout } from '@/components/mail/mail';
import { getSessionOrRedirect } from '@/lib/route-auth-shim';
import { isFrontendOnlyDemo } from '@/lib/demo-frontonly';
import { parseWorkQueueSlug } from '@/lib/demo-mail/work-queue';
import type { Route } from './+types/page';

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const session = await getSessionOrRedirect({ request });
  if (session instanceof Response) return session;

  if (!isFrontendOnlyDemo()) {
    return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/mail/inbox`);
  }

  const queue = parseWorkQueueSlug(params.queue);
  if (!queue) {
    return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/mail/inbox`);
  }

  return { queue };
}

export default function MailWorkQueuePage() {
  useLoaderData<typeof clientLoader>();
  return <MailLayout />;
}
