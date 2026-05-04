import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { assetsGetBimiByEmailQueryKey, type ApiQueryContext } from '@/lib/api/query-options';
import { getEmailLogo } from '@/lib/utils';
import DOMPurify from 'dompurify';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

export const getFirstLetterCharacter = (name?: string) => {
  if (!name) return '';
  const match = name.match(/[a-zA-Z]/);
  return match ? match[0].toUpperCase() : '';
};

interface BimiAvatarProps {
  email?: string;
  name?: string;
  className?: string;
  fallbackClassName?: string;
  onImageError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}

export const BimiAvatar = ({
  email,
  name,
  className = 'h-8 w-8 rounded-full border dark:border-none',
  fallbackClassName = 'rounded-full bg-[#FFFFFF] font-bold text-[#9F9F9F] dark:bg-[#373737]',
  onImageError,
}: BimiAvatarProps) => {
  const [useDefaultFallback, setUseDefaultFallback] = useState(false);
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  const { data: bimiData, isLoading } = useQuery({
    queryKey: assetsGetBimiByEmailQueryKey(queryCtx, { email: email || '' }),
    queryFn: () => getFrontendApi().assets.getBimiByEmail({ email: email || '' }),
    enabled:
      !!email &&
      !useDefaultFallback &&
      !frontendOnlyDemo &&
      queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 60 * 24, // Cache for 24 hours
    gcTime: 1000 * 60 * 60 * 24 * 7, // Keep in cache for 7 days
  });

  const fallbackImageSrc = useMemo(() => {
    if (useDefaultFallback || !email) return '';
    return getEmailLogo(email);
  }, [email, useDefaultFallback]);

  const handleFallbackImageError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      setUseDefaultFallback(true);
      if (onImageError) {
        onImageError(e);
      }
    },
    [onImageError],
  );

  const firstLetter = getFirstLetterCharacter(name || email);

  if (!email) {
    return (
      <Avatar className={className}>
        <AvatarFallback className={fallbackClassName}>{firstLetter}</AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar className={className}>
      {bimiData?.logo?.svgContent && !isLoading ? (
        <div
          className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-white dark:bg-[#373737]"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bimiData.logo.svgContent) }}
        />
      ) : fallbackImageSrc && !useDefaultFallback ? (
        <AvatarImage
          className="rounded-full bg-[#FFFFFF] dark:bg-[#373737]"
          src={fallbackImageSrc}
          alt={name || email}
          onError={handleFallbackImageError}
        />
      ) : getEmailLogo(email) ? (
        <AvatarImage
          className="rounded-full bg-[#FFFFFF] dark:bg-[#373737]"
          src={getEmailLogo(email)}
          alt={name || email}
          onError={handleFallbackImageError}
        />
      ) : (
        <AvatarFallback className={fallbackClassName}>{firstLetter}</AvatarFallback>
      )}
    </Avatar>
  );
};
