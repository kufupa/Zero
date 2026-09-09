/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  triggerEmlDownload,
  defaultFetchDownloadMeta,
  defaultTriggerDownload,
} from '../lib/eml-download';

const mockGetEmlDownloadUrlQuery = vi.fn();

vi.mock('@/providers/query-provider', () => ({
  trpcClient: {
    mail: {
      getEmlDownloadUrl: {
        query: (...args: unknown[]) => mockGetEmlDownloadUrlQuery(...args),
      },
    },
  },
}));

describe('eml-download helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerEmlDownload', () => {
    it('calls fetchDownloadMeta and triggers browser download anchor', async () => {
      const fetchDownloadMeta = vi.fn().mockResolvedValue({
        url: 'https://s3.amazonaws.com/test-bucket/test.eml?signed=true',
        filename: 'Res_123_2026-09-09.eml',
      });
      const triggerDownload = vi.fn();

      const result = await triggerEmlDownload('msg-123', {
        fetchDownloadMeta,
        triggerDownload,
      });

      expect(fetchDownloadMeta).toHaveBeenCalledWith('msg-123');
      expect(triggerDownload).toHaveBeenCalledWith(
        'https://s3.amazonaws.com/test-bucket/test.eml?signed=true',
        'Res_123_2026-09-09.eml',
      );
      expect(result).toEqual({ filename: 'Res_123_2026-09-09.eml' });
    });

    it('throws Error("messageId required for eml download") when messageId is falsy', async () => {
      await expect(triggerEmlDownload('')).rejects.toThrow(
        'messageId required for eml download',
      );
      await expect(triggerEmlDownload((null as unknown) as string)).rejects.toThrow(
        'messageId required for eml download',
      );
      await expect(triggerEmlDownload((undefined as unknown) as string)).rejects.toThrow(
        'messageId required for eml download',
      );
    });

    it('uses default dependencies when none provided', async () => {
      mockGetEmlDownloadUrlQuery.mockResolvedValueOnce({
        url: 'https://s3.amazonaws.com/bucket/reservation.eml',
        filename: 'reservation_2026-09-09.eml',
      });

      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');

      const result = await triggerEmlDownload('msg-456');

      expect(mockGetEmlDownloadUrlQuery).toHaveBeenCalledWith({ messageId: 'msg-456' });
      expect(clickSpy).toHaveBeenCalled();
      expect(result).toEqual({ filename: 'reservation_2026-09-09.eml' });
    });
  });

  describe('defaultFetchDownloadMeta', () => {
    it('queries trpcClient.mail.getEmlDownloadUrl with messageId', async () => {
      mockGetEmlDownloadUrlQuery.mockResolvedValueOnce({
        url: '/api/mail/messages/msg-789/download.eml',
        filename: 'Invoice_2026-09-09.eml',
      });

      const res = await defaultFetchDownloadMeta('msg-789');

      expect(mockGetEmlDownloadUrlQuery).toHaveBeenCalledWith({ messageId: 'msg-789' });
      expect(res).toEqual({
        url: '/api/mail/messages/msg-789/download.eml',
        filename: 'Invoice_2026-09-09.eml',
      });
    });
  });

  describe('defaultTriggerDownload', () => {
    it('creates anchor, sets attributes, appends, clicks, and removes from body', () => {
      const appendChildSpy = vi.spyOn(document.body, 'appendChild');
      const removeChildSpy = vi.spyOn(document.body, 'removeChild');
      let createdAnchor: HTMLAnchorElement | null = null;
      let clicked = false;

      const origCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
        const el = origCreateElement(tagName);
        if (tagName.toLowerCase() === 'a') {
          createdAnchor = el as HTMLAnchorElement;
          vi.spyOn(createdAnchor, 'click').mockImplementation(() => {
            clicked = true;
          });
        }
        return el;
      });

      defaultTriggerDownload('https://example.com/file.eml', 'file.eml');

      expect(createdAnchor).not.toBeNull();
      const anchor = createdAnchor as unknown as HTMLAnchorElement;
      expect(anchor.href).toBe('https://example.com/file.eml');
      expect(anchor.download).toBe('file.eml');
      expect(anchor.target).toBe('_blank');
      expect(anchor.rel).toBe('noopener noreferrer');
      expect(appendChildSpy).toHaveBeenCalledWith(anchor);
      expect(clicked).toBe(true);
      expect(removeChildSpy).toHaveBeenCalledWith(anchor);
    });

    it('revokes object URL if url starts with blob:', () => {
      if (typeof URL.revokeObjectURL !== 'function') {
        URL.revokeObjectURL = vi.fn();
      }
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      defaultTriggerDownload('blob:https://example.com/uuid-blob-123', 'download.eml');

      expect(revokeSpy).toHaveBeenCalledWith('blob:https://example.com/uuid-blob-123');
    });

    it('does not revoke object URL if url is not a blob:', () => {
      if (typeof URL.revokeObjectURL !== 'function') {
        URL.revokeObjectURL = vi.fn();
      }
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      defaultTriggerDownload('https://s3.amazonaws.com/test.eml', 'download.eml');

      expect(revokeSpy).not.toHaveBeenCalled();
    });
  });
});
