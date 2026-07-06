export function selectLiveThreadListQuery(input: {
  folder: string | undefined;
  demoMode: boolean;
  listEnabled: boolean;
}) {
  const liveDraftFolder = !input.demoMode && input.listEnabled && input.folder === 'draft';
  return {
    useDraftsList: liveDraftFolder,
    useMailListThreads: !input.demoMode && input.listEnabled && !liveDraftFolder,
  };
}
