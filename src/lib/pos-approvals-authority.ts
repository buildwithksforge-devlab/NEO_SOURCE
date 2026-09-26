/**
 * POS approval authority — one contract for route, screen, buttons and RLS.
 *
 * The spoken capability is `pos.approvals.decide`. It is an alias that resolves
 * onto the catalogued `restaurant.approvals.approve`, so a screen asking for the
 * spoken name and a policy asking for the catalogued name always get the same
 * answer. The mapping validator below fails fast if that stops being true, so a
 * mismatched or phantom capability can never quietly render an action nobody is
 * actually allowed to take.
 */
import { PERMISSION_MODULES, canonicalPermission, featureKey } from "@/lib/permissions";

export type CanFn = (module: string, actionOrFeature: string, action?: string) => boolean;

/** The capability the Approvals surface speaks. */
export const POS_DECIDE_CAPABILITY = "pos.approvals.decide" as const;

/** Every capability the POS approval flow depends on, in spoken form. */
export const POS_APPROVAL_CAPABILITIES = [
  POS_DECIDE_CAPABILITY,
  "pos.void.approve",
  "pos.refunds.approve",
] as const;

export class CapabilityMappingError extends Error {
  constructor(
    readonly capability: string,
    reason: string,
  ) {
    super(`Permission mapping error for "${capability}": ${reason}`);
    this.name = "CapabilityMappingError";
  }
}

/** Splits `module.feature.action` (or `module.action`) into resolver arguments. */
function parts(capability: string): [string, string] {
  const dot = capability.indexOf(".");
  if (dot <= 0 || dot === capability.length - 1) {
    throw new CapabilityMappingError(capability, "not a module.feature.action key");
  }
  return [capability.slice(0, dot), capability.slice(dot + 1)];
}

/**
 * Resolves a spoken capability to its canonical triple, throwing when the key
 * cannot be mapped onto a real module. Callers use this at module scope so a
 * broken mapping surfaces immediately instead of silently denying (or, worse,
 * silently allowing) an action.
 */
export function resolveCapability(capability: string) {
  const [moduleKey, rest] = parts(capability);
  const canonical = canonicalPermission(moduleKey, rest);
  if (!(PERMISSION_MODULES as readonly string[]).includes(canonical.module)) {
    throw new CapabilityMappingError(
      capability,
      `resolves to unknown module "${canonical.module}"`,
    );
  }
  if (!canonical.feature || !canonical.action) {
    throw new CapabilityMappingError(capability, "resolves to an incomplete permission");
  }
  return canonical;
}

/** Validator: returns the canonical key for every capability, or throws. */
export function validateCapabilityMappings(
  capabilities: readonly string[],
): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const capability of capabilities) {
    const canonical = resolveCapability(capability);
    mapped[capability] = featureKey(canonical.module, canonical.feature, canonical.action);
  }
  return mapped;
}

/** Fails fast at import time — a mismatched POS approval mapping is a build defect. */
export const POS_APPROVAL_CAPABILITY_MAP = validateCapabilityMappings(POS_APPROVAL_CAPABILITIES);

export type PosApprovalGates = {
  /** Holds the POS decision authority itself. */
  canDecide: boolean;
  canDecideVoid: boolean;
  canDecideRefund: boolean;
  canDecideDiscount: boolean;
};

/**
 * Single gating helper for every POS approval surface. Frontline cashiers hold
 * none of these and may only request; the decision buttons never render for them.
 */
export function resolvePosApprovalGates(can: CanFn): PosApprovalGates {
  const decide = can("pos", "approvals.decide");
  return {
    canDecide: decide,
    canDecideVoid: decide || can("pos", "void.approve"),
    canDecideRefund: decide || can("pos", "refunds.approve"),
    canDecideDiscount: decide,
  };
}
