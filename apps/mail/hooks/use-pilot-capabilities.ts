import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { PILOT_CAPABILITIES } from '@/lib/pilot/capabilities';

export function usePilotCapabilities() {
  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.brain.getCapabilities.queryOptions(undefined, {
      staleTime: 60_000,
      retry: false,
    }),
  );

  return data ?? PILOT_CAPABILITIES;
}
