import { describe, expect, it, vi } from 'vitest';
import { fetchAttachmentBlob } from '../lib/attachment-access';

function b64(text: string): string {
  return btoa(text);
}

describe('fetchAttachmentBlob', () => {
  it('uses body base64 when present and skips getSignedUrl', async () => {
    const getSignedUrl = vi.fn();
    const blob = await fetchAttachmentBlob(
      {
        messageId: 'msg-1',
        attachmentId: 'att-1',
        mimeType: 'text/plain',
        body: b64('hello'),
      },
      { getSignedUrl },
    );
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(await blob.text()).toBe('hello');
  });

  it('fetches via signed URL when body empty', async () => {
    const getSignedUrl = vi.fn().mockResolvedValue('https://s3.example/obj');
    const fetchBytes = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    const blob = await fetchAttachmentBlob(
      {
        messageId: 'msg-1',
        attachmentId: 'att-1',
        mimeType: 'application/octet-stream',
        body: '',
        size: 3,
      },
      { getSignedUrl, fetchBytes },
    );
    expect(getSignedUrl).toHaveBeenCalledWith('msg-1', 'att-1');
    expect(fetchBytes).toHaveBeenCalledWith('https://s3.example/obj');
    expect(blob.size).toBe(3);
  });

  it('throws when fetch is not ok', async () => {
    await expect(
      fetchAttachmentBlob(
        {
          messageId: 'msg-1',
          attachmentId: 'att-1',
          mimeType: 'image/gif',
          body: '',
        },
        {
          getSignedUrl: async () => 'https://s3.example/obj',
          fetchBytes: async () => new Response(null, { status: 403 }),
        },
      ),
    ).rejects.toThrow(/403/);
  });

  it('throws when blob empty but size expected', async () => {
    await expect(
      fetchAttachmentBlob(
        {
          messageId: 'msg-1',
          attachmentId: 'att-1',
          mimeType: 'image/gif',
          body: '',
          size: 100,
        },
        {
          getSignedUrl: async () => 'https://s3.example/obj',
          fetchBytes: async () => new Response(new Uint8Array(0), { status: 200 }),
        },
      ),
    ).rejects.toThrow(/empty/i);
  });

  it('throws hard without messageId', async () => {
    await expect(
      fetchAttachmentBlob({
        messageId: '',
        attachmentId: 'att-1',
        mimeType: 'image/gif',
        body: '',
      }),
    ).rejects.toThrow(/messageId required/);
  });
});
