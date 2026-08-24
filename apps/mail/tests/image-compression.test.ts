import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage } from '../lib/image-compression';

class MockImage {
  width = 64;
  height = 64;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = '';

  set src(value: string) {
    this.source = value;
    queueMicrotask(() => this.onload?.());
  }

  get src() {
    return this.source;
  }
}

function installCanvas(blobType: string) {
  const toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
    callback(new Blob(['compressed'], { type: blobType }));
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    toBlob,
  };

  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  vi.stubGlobal('Image', MockImage);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:input'),
    revokeObjectURL: vi.fn(),
  });

  return { toBlob };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('image compression MIME safety', () => {
  it.each([
    ['image/gif', 'animated.gif'],
    ['image/svg+xml', 'image.svg'],
  ])('preserves %s when canvas falls back to PNG', async (originalType, name) => {
    installCanvas('image/png');
    const original = new File(['source'], name, { type: originalType, lastModified: 1 });

    const result = await compressImage(original, { quality: 'medium' });

    expect(result).toBe(original);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'keeps %s compression when canvas preserves MIME type',
    async (type) => {
      const { toBlob } = installCanvas(type);
      const original = new File(['source'], `image.${type.split('/')[1]}`, {
        type,
        lastModified: 1,
      });

      const result = await compressImage(original, { quality: 'medium' });

      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), type, 0.8);
      expect(result).not.toBe(original);
      expect(result.type).toBe(type);
    },
  );
});
