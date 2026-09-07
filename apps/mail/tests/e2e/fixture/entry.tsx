import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import AdminDashboardPage from '../../../app/(routes)/settings/admin-dashboard/page';
import { QueryProvider } from '../../../providers/query-provider';
import { setMailCacheScope } from '../../../lib/mail/mail-cache-scope';
import '../../../app/globals.css';
import './fixture.css';

setMailCacheScope({ userId: 'fixture-viewer', activeTransportId: 'transport-centurion' });

const root = document.getElementById('root');
if (!root) throw new Error('fixture root is missing');

createRoot(root).render(
  <BrowserRouter>
    <QueryProvider>
      <AdminDashboardPage />
    </QueryProvider>
  </BrowserRouter>,
);
