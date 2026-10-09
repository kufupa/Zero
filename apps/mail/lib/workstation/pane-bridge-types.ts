import type { useOutlookBridge } from './use-outlook-bridge';

/** What the Outlook pane reads from the bridge: the value useOutlookBridge() returns. */
export type PaneBridge = ReturnType<typeof useOutlookBridge>;
