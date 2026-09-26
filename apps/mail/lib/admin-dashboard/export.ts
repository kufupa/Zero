import type { AdminDashboardExport } from './types';

/** Stable JSON serializer for the server-authorized, body-free dashboard export. */
export function serializeAdminDashboardExport(payload: AdminDashboardExport): string {
  return JSON.stringify(payload, null, 2);
}

export function downloadAdminDashboardExport(
  payload: AdminDashboardExport,
  filename = 'admin-dashboard-export.json',
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([serializeAdminDashboardExport(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
