import { useLoaderData, useNavigate } from 'react-router';

import { MailLayout } from '@/components/mail/mail';
import { useLabels } from '@/hooks/use-labels';
import { isDemoMailFolderSlug } from '@/lib/demo/folder-map';
import { isStandardMailFolderSlug } from '@/lib/domain/folders';
import { isFrontendOnlyDemo } from '@/lib/runtime/mail-mode';
import { useEffect, useState } from 'react';
import type { Route } from './+types/page';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!params.folder) return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/mail/inbox`);
  return {
    folder: params.folder,
  };
}

export default function MailPage() {
  const { folder } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [isLabelValid, setIsLabelValid] = useState<boolean | null>(true);
  const normalizedFolder = folder.toLowerCase();

  const isStandardFolder = isStandardMailFolderSlug(normalizedFolder);
  const isDemoMailFolder = isFrontendOnlyDemo() && isDemoMailFolderSlug(normalizedFolder);

  const { userLabels, isLoading: isLoadingLabels } = useLabels();

  useEffect(() => {
    if (isStandardFolder || isDemoMailFolder) {
      setIsLabelValid(true);
      return;
    }

    if (isLoadingLabels) return;

    if (userLabels) {
      const checkLabelExists = (labels: any[]): boolean => {
        for (const label of labels) {
          if (label.id === normalizedFolder) return true;
          if (label.labels && label.labels.length > 0) {
            if (checkLabelExists(label.labels)) return true;
          }
        }
        return false;
      };

      const labelExists = checkLabelExists(userLabels);
      setIsLabelValid(labelExists);

      if (!labelExists) {
        const timer = setTimeout(() => {
          navigate('/mail/inbox');
        }, 300);
        return () => clearTimeout(timer);
      }
    } else {
      setIsLabelValid(false);
    }
  }, [folder, normalizedFolder, userLabels, isLoadingLabels, isStandardFolder, isDemoMailFolder, navigate]);

  if (!isLabelValid) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">Folder not found</h2>
        <p className="text-muted-foreground mt-2">
          The folder you're looking for doesn't exist. Redirecting to inbox...
        </p>
      </div>
    );
  }

  return <MailLayout />;
}
