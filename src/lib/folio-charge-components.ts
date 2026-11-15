export type FolioChargeComponent = {
  key: string;
  label: string;
  amount: number;
  classification?: string;
};

/** Optional on older projections; explicit components must reconcile. */
export function readFolioChargeComponents(raw: Record<string, unknown>) {
  const supplied = raw["charge_components"];
  const total = raw["other_charges"] === undefined ? 0 : raw["other_charges"];
  const validAmount = (value: unknown) => (typeof value === "number"
    || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  if (!validAmount(total)) {
    throw new Error("The folio additional charges could not be verified.");
  }
  if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length > 100)) {
    throw new Error("The folio charge breakdown is invalid.");
  }
  const keys = new Set<string>();
  const chargeComponents: FolioChargeComponent[] = (supplied ?? []).map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The folio charge breakdown is invalid.");
    }
    const row = entry as Record<string, unknown>;
    const key = typeof row["key"] === "string" ? row["key"].trim() : "";
    const label = typeof row["label"] === "string" ? row["label"].trim() : "";
    const amount = row["amount"];
    if (!key || keys.has(key) || !label || label.length > 120
      || !validAmount(amount)) {
      throw new Error("The folio charge breakdown is invalid.");
    }
    keys.add(key);
    return { key, label, amount: Number(amount),
      ...(typeof row["classification"] === "string" ? { classification: row["classification"] } : {}),
    };
  });
  if (Math.abs(chargeComponents.reduce((sum, row) => sum + row.amount, 0) - Number(total)) >= 0.005) {
    throw new Error("The folio additional charges do not agree with their breakdown.");
  }
  return { otherCharges: Number(total), chargeComponents };
}
