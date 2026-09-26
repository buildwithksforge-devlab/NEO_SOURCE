/**
 * Approval routing policy — configured, never hard-coded.
 *
 * For each approval workflow a workspace may name the role that reserves the
 * decision (restricted actions) and the role that picks the request up when the
 * configured approver is unavailable or is the person who raised it. The
 * database routine `neo_approval_route` reads exactly these rows; workflows with
 * no policy keep the behaviour they already had.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ApprovalRoutingPolicy = {
  id: string;
  workflow_key: string;
  reserved_role_id: string | null;
  fallback_role_id: string | null;
  fallback_enabled: boolean;
  notes: string | null;
  active: boolean;
};

export type ApprovalRoutingPolicyInput = {
  workflow_key: string;
  reserved_role_id: string | null;
  fallback_role_id: string | null;
  fallback_enabled: boolean;
  notes: string | null;
};

/** Plain sentence describing how a workflow currently routes. */
export function describeRouting(
  policy: ApprovalRoutingPolicy | undefined,
  roleName: (id: string | null) => string,
): string {
  if (!policy) return "Follows the workspace default route for this workflow.";
  const parts: string[] = [];
  parts.push(
    policy.reserved_role_id
      ? `Reserved for ${roleName(policy.reserved_role_id)}`
      : "Not a reserved action",
  );
  parts.push(
    policy.fallback_enabled && policy.fallback_role_id
      ? `falls back to ${roleName(policy.fallback_role_id)}`
      : "no fallback approver",
  );
  return parts.join(" · ");
}

export function useApprovalRoutingPolicies() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["approval-routing-policies", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("approval_routing_policies")
        .select("id, workflow_key, reserved_role_id, fallback_role_id, fallback_enabled, notes, active")
        .order("workflow_key");
      if (error) throw new Error(error.message);
      return (data ?? []) as ApprovalRoutingPolicy[];
    },
  });
}

export function useSaveApprovalRoutingPolicy() {
  const { organizationId, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApprovalRoutingPolicyInput) => {
      if (!organizationId) throw new Error("No workspace context.");
      const { error } = await (supabase as any)
        .from("approval_routing_policies")
        .upsert(
          {
            organization_id: organizationId,
            workflow_key: input.workflow_key,
            reserved_role_id: input.reserved_role_id,
            fallback_role_id: input.fallback_role_id,
            fallback_enabled: input.fallback_enabled,
            notes: input.notes,
            active: true,
            created_by: user?.id ?? null,
          },
          { onConflict: "organization_id,workflow_key" },
        );
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Routing policy saved");
      void qc.invalidateQueries({ queryKey: ["approval-routing-policies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useClearApprovalRoutingPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("approval_routing_policies")
        .delete()
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Routing policy removed — this workflow returns to the default route");
      void qc.invalidateQueries({ queryKey: ["approval-routing-policies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
