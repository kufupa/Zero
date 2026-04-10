import { Analytics } from '@dub/analytics/react';

export default function DeferredDubAnalytics() {
  return <Analytics domainsConfig={{ refer: 'mail0.com' }} />;
}
