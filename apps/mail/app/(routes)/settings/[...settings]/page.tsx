import NotificationsPage from '../notifications/page';
import AppearancePage from '../appearance/page';
import ShortcutsPage from '../shortcuts/page';
import SecurityPage from '../security/page';
import { m } from '@/paraglide/messages';
import GeneralPage from '../general/page';
import { useLocation } from 'react-router';
import LabelsPage from '../labels/page';

const settingsPages: Record<string, React.ComponentType> = {
  general: GeneralPage,
  security: SecurityPage,
  appearance: AppearancePage,
  shortcuts: ShortcutsPage,
  notifications: NotificationsPage,
  labels: LabelsPage,
};

export default function SettingsPage() {
  const location = useLocation();
  const sections = location.pathname.split('/').filter(Boolean);
  const section = sections.length ? sections[sections.length - 1] : 'general';

  const SettingsComponent = settingsPages[section];

  if (!SettingsComponent) {
    return <div>{m['pages.error.settingsNotFound']()}</div>;
  }

  return <SettingsComponent />;
}
