/** Mount the real Outlook route against a synthetic, loopback-only transport. */
import OutlookPanePage from '../../../app/(routes)/outlook-pane/page';
import { ClientProviders } from '../../../providers/client-providers';
import { QueryProvider } from '../../../providers/query-provider';
import { BrowserRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import React from 'react';
import './fixture.css';

const root = document.getElementById('root');
if (!root) throw new Error('Synthetic replay root is missing');
createRoot(root).render(
  <BrowserRouter>
    <QueryProvider>
      <ClientProviders>
        <OutlookPanePage />
      </ClientProviders>
    </QueryProvider>
  </BrowserRouter>,
);
