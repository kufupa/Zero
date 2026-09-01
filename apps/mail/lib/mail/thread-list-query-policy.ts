export function selectLiveThreadListQuery(input: {
  folder: string | undefined;
  demoMode: boolean;
  listEnabled: boolean;
  useDraftsList?: boolean;
}) {
  const liveListEnabled = !input.demoMode && input.listEnabled;
  const liveDraftFolder =
    liveListEnabled && (input.useDraftsList ?? input.folder === 'draft');
  return {
    useDraftsList: liveDraftFolder,
    useMailListThreads: liveListEnabled && !liveDraftFolder,
  };
}
