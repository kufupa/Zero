import {
  ThreadDraftCard,
  type ThreadDraftCardProps,
  type DraftCardAttachment,
} from './thread-draft-card';
import { useDraftArtifactHydration } from '@/hooks/use-drafts';
import { useRef, useState } from 'react';
/** Authorized PDF preview uses the captured candidate bytes and returns keyboard focus on close. */
export function ReservationistDraftCard({
  draftId,
  ...props
}: ThreadDraftCardProps & { draftId: string }) {
  const hydrated = useDraftArtifactHydration({
    id: draftId,
    attachments: (props.attachments ?? []).map((a) => ({
      ...a,
      mimeType: 'application/pdf',
      sizeBytes: (a as DraftCardAttachment & { sizeBytes?: number }).sizeBytes ?? 0,
      sourceHash: (a as DraftCardAttachment & { sourceHash?: string }).sourceHash ?? null,
    })),
  });
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  return (
    <>
      <ThreadDraftCard
        {...props}
        attachments={hydrated.entries.length ? hydrated.entries : props.attachments}
        onRetryAttachment={hydrated.retry}
        onPreviewAttachment={(ref) => {
          const entry = hydrated.entries.find((a) => a.artifactRef === ref);
          if (!entry?.file) return;
          trigger.current = document.activeElement as HTMLElement;
          setPreview({ url: URL.createObjectURL(entry.file), filename: entry.filename });
        }}
      />
      {preview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${preview.filename}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              URL.revokeObjectURL(preview.url);
              setPreview(null);
              trigger.current?.focus();
            }
            if (event.key === 'Tab') {
              event.preventDefault();
              (event.currentTarget.querySelector('button') as HTMLButtonElement)?.focus();
            }
          }}
          className="bg-background fixed inset-4 z-50 p-4"
        >
          <button
            autoFocus
            type="button"
            onClick={() => {
              URL.revokeObjectURL(preview.url);
              setPreview(null);
              trigger.current?.focus();
            }}
          >
            Close preview
          </button>
          <iframe title={preview.filename} src={preview.url} className="h-full w-full" />
        </div>
      ) : null}
    </>
  );
}
