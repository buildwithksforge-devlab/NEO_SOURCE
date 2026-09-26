/**
 * Canonical approval transaction-type registry.
 *
 * Transaction types are platform-defined workflow objects, not hotel master
 * data: the routing engine has to know which workflow it is routing, so a
 * workspace selects from this catalogue rather than inventing names. The same
 * list is mirrored by the database helper `neo_approval_standard_types()`,
 * which seeds every workspace's own `approval_types` rows.
 *
 * A workspace may rename a type (its row carries the display name) but the key
 * — the thing the engine routes on — always comes from here.
 */

export type ApprovalDomain =
  | "procurement"
  | "finance"
  | "front-office"
  | "pos"
  | "inventory"
  | "events";

export type PlatformApprovalType = {
  key: string;
  name: string;
  domain: ApprovalDomain;
  /** What this type governs, shown as help text in configuration screens. */
  description: string;
  /**
   * A historical duplicate kept so old records still read correctly. No active
   * workflow raises it, so configuration screens must not demand an approver
   * for it — but a workspace that already configured one keeps it.
   */
  legacy?: boolean;
};

export const PLATFORM_APPROVAL_TYPES: readonly PlatformApprovalType[] = [
  {
    key: "purchase-request",
    name: "Purchase requisition",
    domain: "procurement",
    description: "A department or store asking for goods or services to be bought.",
  },
  {
    key: "purchase-order",
    name: "Purchase order / LPO",
    domain: "procurement",
    description: "The committed order placed on a supplier.",
  },
  {
    key: "procurement-variance",
    name: "Procurement variance / exception",
    domain: "procurement",
    description: "Receipt, price or quantity differences outside tolerance.",
  },
  {
    key: "supplier-invoice",
    name: "Supplier invoice",
    domain: "procurement",
    description: "A supplier bill cleared for payment after matching.",
  },
  {
    key: "procurement-approval",
    name: "Procurement approval (historical)",
    domain: "procurement",
    description:
      "Superseded by the specific procurement types. Kept so existing records and rules stay readable.",
    legacy: true,
  },
  { key: "expense", name: "Expense approval", domain: "finance", description: "Staff or departmental expense claims." },
  { key: "refund", name: "Refund approval", domain: "finance", description: "Money returned to a guest or customer." },
  { key: "payment-reversal", name: "Payment reversal", domain: "finance", description: "Reversing a recorded payment." },
  { key: "write-off", name: "Write-off approval", domain: "finance", description: "Writing off an uncollectable balance." },
  { key: "cash-variance", name: "Cash variance review", domain: "finance", description: "Till or banking differences." },
  { key: "credit-account", name: "Credit account approval", domain: "finance", description: "Granting or changing corporate credit." },
  { key: "discount", name: "Discount", domain: "pos", description: "Discount beyond standard pricing." },
  { key: "bill-void", name: "Bill void request", domain: "pos", description: "Voiding a bill." },
  { key: "bill-adjustment", name: "Bill adjustment", domain: "pos", description: "Adjusting a posted bill." },
  { key: "complimentary-meal", name: "Complimentary meal", domain: "pos", description: "Food or drink given free of charge." },
  { key: "price-change", name: "Manual price change", domain: "pos", description: "Overriding a menu or item price." },
  { key: "till-reopen", name: "Till reopening", domain: "pos", description: "Reopening a closed till." },
  { key: "complimentary-room", name: "Complimentary room", domain: "front-office", description: "A room given free of charge." },
  { key: "rate-override", name: "Rate override", domain: "front-office", description: "Selling outside the published rate." },
  { key: "stock-adjustment", name: "Stock adjustment", domain: "inventory", description: "Correcting a counted stock balance." },
  { key: "stock-write-off", name: "Stock write-off", domain: "inventory", description: "Writing off damaged or expired stock." },
  { key: "event-quotation", name: "Event quotation", domain: "events", description: "A quotation issued to an event client." },
  {
    key: "event-pricing-exception",
    name: "Event pricing exception",
    domain: "events",
    description: "Event pricing outside the standard package.",
  },
];

/** The platform types belonging to one domain, in catalogue order. */
export function approvalTypesForDomain(domain: ApprovalDomain): PlatformApprovalType[] {
  return PLATFORM_APPROVAL_TYPES.filter((t) => t.domain === domain);
}

export function platformApprovalType(key: string): PlatformApprovalType | undefined {
  return PLATFORM_APPROVAL_TYPES.find((t) => t.key === key);
}

/**
 * The selector list for a configuration screen: always the platform catalogue
 * for that domain, carrying the workspace's own wording where it has renamed a
 * type. The dropdown is therefore never empty, even before the workspace's own
 * catalogue rows have been seeded.
 */
export function selectableApprovalTypes(
  domain: ApprovalDomain,
  workspaceTypes: ReadonlyArray<{ key: string; name: string; active?: boolean }> | undefined,
): { key: string; name: string; description: string; legacy: boolean }[] {
  const byKey = new Map((workspaceTypes ?? []).map((t) => [t.key, t] as const));
  return approvalTypesForDomain(domain)
    .filter((t) => byKey.get(t.key)?.active !== false)
    .map((t) => ({
      key: t.key,
      name: byKey.get(t.key)?.name ?? t.name,
      description: t.description,
      legacy: t.legacy === true,
    }));
}
