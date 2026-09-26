/**
 * The scope hook every write path should use.
 *
 * It reads the same three sources the rest of the OS reads — the signed-in
 * actor, the property scope the backend granted, and the operating currency —
 * and turns them into either a complete transaction scope or a blocked
 * outcome with a reason the operator can act on.
 */
import { useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { useTenant } from "@/lib/tenant";
import {
  resolveTransactionScope,
  type ScopeResult,
  type TransactionScope,
} from "@/lib/transaction-scope";

export type ScopeFactory = (
  action: string,
  identity: readonly (string | number | null | undefined)[],
) => ScopeResult;

export function useTransactionScope(sourceModule: string): {
  /** Build the scope for one specific command. */
  forCommand: ScopeFactory;
  /** True while the estate is a reporting view — writes are blocked. */
  reportingOnly: boolean;
  propertyId: string | null;
  currency: string;
} {
  const { organizationId, profile, user, access } = useAuth();
  const { activeBranchId, activeBranch } = useBranchScope();
  const { tenant } = useTenant();

  const currency = activeBranch?.currency || tenant.regional.currency || "";
  const permitted = useMemo(() => access.branchIds ?? [], [access.branchIds]);
  const actorId = user?.id ?? profile?.id ?? null;
  const actorName = profile?.full_name ?? null;

  const forCommand = useCallback<ScopeFactory>(
    (action, identity) =>
      resolveTransactionScope({
        organizationId,
        activeBranchId,
        permittedBranchIds: permitted,
        sourceModule,
        action,
        actorId,
        actorName,
        currency,
        identity,
      }),
    [organizationId, activeBranchId, permitted, sourceModule, actorId, actorName, currency],
  );

  return {
    forCommand,
    reportingOnly: activeBranchId === "all",
    propertyId: activeBranchId === "all" ? null : (activeBranchId ?? null),
    currency,
  };
}

export type { TransactionScope };
