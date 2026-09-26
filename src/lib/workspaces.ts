/**
 * Group (workspace) membership.
 *
 * One human identity may belong to more than one hotel group — a management
 * company, an external accountant, a consultant or a group administrator. The
 * database remains the authority: membership rows decide which groups a person
 * may act in, and the workspace they are currently working in is part of their
 * profile, so every access rule and every query resolves the same answer.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";

export type WorkspaceMembership = {
  organization_id: string;
  organization_name: string;
  membership_type: "staff" | "external";
  status: "active" | "suspended" | "invited";
  is_current: boolean;
};

/** Every group the signed-in person may work in. */
export function useMyWorkspaces() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["my-workspaces", session?.user?.id ?? "none"],
    enabled: Boolean(session?.user?.id),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<WorkspaceMembership[]> => {
      const { data, error } = await guardedRpc<WorkspaceMembership[] | null>(
        supabase,
        "neo_my_workspaces",
      );
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

/**
 * Switches the group being worked in. Everything on screen belongs to the
 * previous group, so the session is reloaded rather than selectively
 * invalidated — no figure from one group can survive into another.
 */
export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  const reload = useCallback(() => {
    if (typeof window !== "undefined") window.location.assign("/workspace");
  }, []);

  return useMutation({
    mutationFn: async (organizationId: string) => {
      const { error } = await guardedRpc(supabase, "neo_switch_workspace", {
        _org: organizationId,
      });
      if (error) throw new Error(error.message);
      return organizationId;
    },
    onSuccess: () => {
      queryClient.clear();
      reload();
    },
  });
}
