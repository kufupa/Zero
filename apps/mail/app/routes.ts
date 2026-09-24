import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';

export default [
  index('page.tsx'),
  route('/home', 'home/page.tsx'),

  route('/mailto-handler', 'mailto-handler.ts'),

  layout('(full-width)/layout.tsx', [
    route('/about', '(full-width)/about.tsx'),
    route('/terms', '(full-width)/terms.tsx'),
    route('/pricing', '(full-width)/pricing.tsx'),
    route('/privacy', '(full-width)/privacy.tsx'),
    route('/contributors', '(full-width)/contributors.tsx'),
    route('/hr', '(full-width)/hr.tsx'),
  ]),

  route('/login', '(auth)/login/page.tsx'),

  // Pilot email/password (Better Auth). Signup stays closed.
  route('/zero/login', '(auth)/zero/login/page.tsx'),
  route('/outlook-pane', '(routes)/outlook-pane/page.tsx'),

  layout('(routes)/layout.tsx', [
    route('/developer', '(routes)/developer/page.tsx'),
    layout(
      '(routes)/lab/layout.tsx',
      prefix('/lab', [
        route('/centurion', '(routes)/lab/centurion/page.tsx'),
        route('/centurion/:tool', '(routes)/lab/centurion/[tool]/page.tsx'),
      ]),
    ),
    layout(
      '(routes)/mail/layout.tsx',
      prefix('/mail', [
        index('(routes)/mail/page.tsx'),
        route('/create', '(routes)/mail/create/page.tsx'),
        route('/compose', '(routes)/mail/compose/page.tsx'),
        route('/under-construction/:path', '(routes)/mail/under-construction/[path]/page.tsx'),
        route('/:folder', '(routes)/mail/[folder]/page.tsx'),
      ]),
    ),
    layout(
      '(routes)/settings/layout.tsx',
      prefix('/settings', [
        index('(routes)/settings/page.tsx'),
        route('/appearance', '(routes)/settings/appearance/page.tsx'),
        route('/danger-zone', '(routes)/settings/danger-zone/page.tsx'),
        route('/general', '(routes)/settings/general/page.tsx'),
        route('/labels', '(routes)/settings/labels/page.tsx'),
        route('/categories', '(routes)/settings/categories/page.tsx'),
        route('/notifications', '(routes)/settings/notifications/page.tsx'),
        route('/privacy', '(routes)/settings/privacy/page.tsx'),
        route('/security', '(routes)/settings/security/page.tsx'),
        route('/shortcuts', '(routes)/settings/shortcuts/page.tsx'),
        route('/catchup-upload', '(routes)/settings/catchup-upload/page.tsx'),
        route('/outlook-addin', '(routes)/settings/outlook-addin/page.tsx'),
        route('/*', '(routes)/settings/[...settings]/page.tsx'),
      ]),
    ),
    route('/*', 'meta-files/not-found.ts'),
  ]),
] satisfies RouteConfig;
