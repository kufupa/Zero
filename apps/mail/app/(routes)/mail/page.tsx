import type { Route } from './+types/page';

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return Response.redirect(new URL('/mail/inbox', new URL(request.url).origin));
}
