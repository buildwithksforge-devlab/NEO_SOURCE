import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useActivePropertyFilter } from '@/lib/branch-filter';
import { supabase } from '@/integrations/supabase/client';
import { guardedRpc } from '@/lib/rpc-guard';

export function useAutomaticPlatformChecks() {
  const { organizationId, user, permissionsLoaded, phase, can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const cache = useQueryClient();
  const allowed = permissionsLoaded && (can('platform', 'readiness.view') || can('platform', 'quality.view'));
  const query = useQuery({
    queryKey: ['platform', 'automatic-checks', organizationId, user?.id, branchId, allowed],
    enabled: phase === 'ready' && Boolean(organizationId && user?.id && branchId) && allowed,
    staleTime: 15 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase as never, 'neo_platform_run_checks', { _branch: branchId });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      const result = data as { run_id?: string; finished_at?: string; failed?: number; blocked?: number; status?: string; cached?: boolean } | null;
      if (!result?.run_id || !result.finished_at) throw new Error('Automatic check results were not saved.');
      await Promise.all(['test_runs', 'defects'].map(table => cache.invalidateQueries({ queryKey: ['platform', table] })));
      return result;
    },
  });
  return { ...query, allowed, branchId };
}
