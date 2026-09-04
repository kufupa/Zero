import React from 'react';
import { CatchupUploadContent } from '@/components/settings/catchup-upload';
import { usePilotCapabilities } from '@/hooks/use-pilot-capabilities';
import { Navigate } from 'react-router';

export default function CatchupUploadPage() {
  const capabilities = usePilotCapabilities();

  // Guard against direct URL access when capability is false
  if (!capabilities.catchupUpload) {
    return <Navigate to="/settings/general" replace />;
  }

  return <CatchupUploadContent />;
}
