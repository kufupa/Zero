import { describe, expect, it } from 'vitest';
import { navigationConfig, bottomNavItems } from '../config/navigation';
import { CatchupUploadContent } from '../components/settings/catchup-upload';
import {
  MAX_CATCHUP_FILE_BYTES,
  ALLOWED_CATCHUP_EXTENSIONS,
} from '../lib/catchup-upload-client';

describe('catchup upload UI navigation and component contract', () => {
  it('registers catchup-upload in settings navigation items', () => {
    const settingsSection = navigationConfig.settings.sections[0];
    const catchupItem = settingsSection.items.find((item) => item.id === 'catchup-upload');

    expect(catchupItem).toBeDefined();
    expect(catchupItem?.title).toBe('Upload backup');
    expect(catchupItem?.url).toBe('/settings/catchup-upload');
    expect(catchupItem?.hidden).toBe(true);
  });

  it('registers catchup-upload in bottomNavItems immediately after settings', () => {
    const bottomSection = bottomNavItems[0];
    const settingsIdx = bottomSection.items.findIndex((item) => item.id === 'settings');
    const catchupIdx = bottomSection.items.findIndex((item) => item.id === 'catchup-upload');

    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(catchupIdx).toBe(settingsIdx + 1);
    expect(bottomSection.items[catchupIdx].title).toBe('Upload backup');
    expect(bottomSection.items[catchupIdx].hidden).toBe(true);
  });

  it('exports CatchupUploadContent component', () => {
    expect(typeof CatchupUploadContent).toBe('function');
  });

  it('enforces 50 GB limit and allowed extensions', () => {
    expect(MAX_CATCHUP_FILE_BYTES).toBe(53687091200);
    expect(ALLOWED_CATCHUP_EXTENSIONS).toContain('.pst');
    expect(ALLOWED_CATCHUP_EXTENSIONS).toContain('.zip');
    expect(ALLOWED_CATCHUP_EXTENSIONS).toContain('.msg');
  });
});
