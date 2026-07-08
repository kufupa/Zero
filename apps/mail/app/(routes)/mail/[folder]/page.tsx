import { useLoaderData, useNavigate } from 'react-router';

import { MailLayout } from '@/components/mail/mail';
import { useCategorySettingsQueryState } from '@/hooks/use-categories';
import { useLabels } from '@/hooks/use-labels';
import { isDemoMailFolderSlug } from '@/lib/demo/folder-map';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useEffect, useState } from 'react';
import type { Route } from './+types/page';

const ALLOWED_FOLDERS = new Set(['inbox', 'draft', 'sent', 'spam', 'bin', 'archive', 'snoozed']);

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

  const isStandardFolder = ALLOWED_FOLDERS.has(normalizedFolder);
  const isDemoMailFolder = isFrontendOnlyDemo() && isDemoMailFolderSlug(normalizedFolder);

  const { userLabels, isLoading: isLoadingLabels } = useLabels();
  const { categories, hasSettledLiveCategories } = useCategorySettingsQueryState();

  useEffect(() => {
    if (isStandardFolder || isDemoMailFolder) {
      setIsLabelValid(true);
      return;
    }

    if (isLoadingLabels || !hasSettledLiveCategories) return;

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

      const categoryExists = categories.some((category) => category.slug === normalizedFolder);
      const labelExists = checkLabelExists(userLabels);
      setIsLabelValid(categoryExists || labelExists);

      if (!categoryExists && !labelExists) {
        const timer = setTimeout(() => {
          navigate('/mail/inbox');
        }, 300);
        return () => clearTimeout(timer);
      }
    } else {
      const categoryExists = categories.some((category) => category.slug === normalizedFolder);
      setIsLabelValid(categoryExists);
      if (!categoryExists) {
        const timer = setTimeout(() => {
          navigate('/mail/inbox');
        }, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [
    folder,
    normalizedFolder,
    userLabels,
    isLoadingLabels,
    hasSettledLiveCategories,
    categories,
    isStandardFolder,
    isDemoMailFolder,
    navigate,
  ]);

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
