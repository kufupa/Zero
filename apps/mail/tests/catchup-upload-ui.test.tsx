import { describe, expect, it } from 'vitest';
import { navigationConfig } from '../config/navigation';
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
