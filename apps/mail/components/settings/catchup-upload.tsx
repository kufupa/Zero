import React, { useState, useRef, useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { SettingsCard } from '@/components/settings/settings-card';
import { toast } from 'sonner';
import {
  Upload,
  X,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import {
  validateCatchupFile,
  computeUploadProgress,
  uploadSinglePut,
  uploadMultipartParts,
} from '@/lib/catchup-upload-client';
import { formatFileSize } from '@/lib/utils';
import { OutlookSetupDownloadButton } from '@/components/settings/outlook-setup-download';

export function CatchupUploadContent() {
  const trpc = useTRPC();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [activeFile, setActiveFile] = useState<File | null>(null);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const { data: uploads, refetch: refetchUploads } = useQuery(
    trpc.catchup.listMine.queryOptions(),
  );

  const initUploadMutation = useMutation(trpc.catchup.initUpload.mutationOptions());
  const completeUploadMutation = useMutation(trpc.catchup.completeUpload.mutationOptions());
  const abortUploadMutation = useMutation(trpc.catchup.abortUpload.mutationOptions());

  const handleFile = useCallback(
    async (file: File) => {
      const validation = validateCatchupFile(file);
      if (!validation.valid) {
        toast.error(validation.error);
        return;
      }

      setActiveFile(file);
      setTotalBytes(file.size);
      setUploadedBytes(0);
      setIsUploading(true);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const init = await initUploadMutation.mutateAsync({
          filename: file.name,
          sizeBytes: file.size,
        });

        setActiveUploadId(init.uploadId);

        if (init.mode === 'single') {
          await uploadSinglePut({
            file,
            putUrl: init.putUrl,
            putHeaders: init.putHeaders,
            onProgress: (loaded) => setUploadedBytes(loaded),
            signal: abortController.signal,
          });

          await completeUploadMutation.mutateAsync({
            uploadId: init.uploadId,
          });
        } else {
          const parts = await uploadMultipartParts({
            file,
            partSizeBytes: init.partSizeBytes,
            parts: init.parts,
            onProgress: (loaded) => setUploadedBytes(loaded),
            signal: abortController.signal,
          });

          await completeUploadMutation.mutateAsync({
            uploadId: init.uploadId,
            parts,
          });
        }

        toast.success('Backup received');
        refetchUploads();
      } catch (err: unknown) {
        if (abortController.signal.aborted) {
          toast.info('Upload was cancelled');
        } else {
          console.error('Catchup upload failed:', err);
          toast.error(
            err instanceof Error ? err.message : 'Upload failed. Please try again.',
          );
        }
      } finally {
        setIsUploading(false);
        setActiveFile(null);
        setActiveUploadId(null);
        abortControllerRef.current = null;
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [initUploadMutation, completeUploadMutation, refetchUploads],
  );

  const handleCancel = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (activeUploadId) {
      try {
        await abortUploadMutation.mutateAsync({ uploadId: activeUploadId });
      } catch (err) {
        console.warn('Failed to register abort with server:', err);
      }
    }
    setIsUploading(false);
    setActiveFile(null);
    setActiveUploadId(null);
    refetchUploads();
  }, [activeUploadId, abortUploadMutation, refetchUploads]);

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (isUploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const progress = computeUploadProgress(uploadedBytes, totalBytes);

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Upload Outlook backup"
        description="Export Sent mail from Outlook as a .pst, a .zip of .msg files, or a single .msg. Drop it here. We store it for Nava — it will not appear in your inbox yet."
      >
        <div className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pst,.zip,.msg"
            className="hidden"
            disabled={isUploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />

          {!isUploading ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors cursor-pointer ${
                isDragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
            >
              <div className="rounded-full bg-muted p-3 mb-3">
                <Upload className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">
                Drop .pst, .zip, or .msg here
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                Choose file
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Max 50 GB
              </p>
            </div>
          ) : (
            <div className="rounded-lg border p-4 space-y-3 bg-muted/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 truncate pr-2">
                  <FileText className="h-5 w-5 text-primary shrink-0" />
                  <span className="text-sm font-medium truncate">
                    {activeFile?.name}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleCancel}
                  className="h-8 px-2 text-destructive hover:text-destructive"
                >
                  <X className="h-4 w-4 mr-1" />
                  Cancel
                </Button>
              </div>

              <Progress value={progress.percent} className="h-2" />

              <div className="flex justify-between text-xs text-muted-foreground">
                <span className="flex items-center">
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                  Uploading… {progress.percent}%
                </span>
                <span>
                  {progress.formattedUploaded} / {progress.formattedTotal}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Keep this window open until it finishes.
              </p>
            </div>
          )}

          <OutlookSetupDownloadButton />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Recent Uploads"
        description="History of Outlook backup dumps uploaded from this account."
      >
        <div className="overflow-x-auto">
          {!uploads || uploads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No backups yet.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Filename</th>
                  <th className="pb-2 font-medium">Size</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium text-right">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {uploads.map((row) => (
                  <tr key={row.id} className="py-2.5">
                    <td className="py-2.5 font-medium flex items-center space-x-2">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-[200px] sm:max-w-[300px]">
                        {row.originalFilename}
                      </span>
                    </td>
                    <td className="py-2.5 text-muted-foreground">
                      {formatFileSize(row.sizeBytes)}
                    </td>
                    <td className="py-2.5">
                      {row.status === 'stored' && (
                        <Badge variant="default" className="bg-emerald-600/90 text-white hover:bg-emerald-600">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Received
                        </Badge>
                      )}
                      {row.status === 'pending' && (
                        <Badge variant="secondary">
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" /> In progress
                        </Badge>
                      )}
                      {row.status === 'aborted' && (
                        <Badge variant="destructive">
                          <AlertCircle className="h-3 w-3 mr-1" /> Cancelled
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 text-right text-muted-foreground">
                      {new Date(row.createdAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
