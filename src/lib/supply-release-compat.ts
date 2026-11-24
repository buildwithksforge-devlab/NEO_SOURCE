import { requireTransferResult } from "./stock-transfer-result";

type Row = Record<string, any>;

/** Read missing legacy metadata through the caller's scoped client; never infer ownership. */
export async function resolveApprovedCountOwnership(
  value: unknown,
  load: (ids: string[]) => Promise<Row[]>,
): Promise<Row[]> {
  const message = "The receiving queue needs the property and purchase history update. Contact an administrator before posting.";
  if (!Array.isArray(value)) throw new Error("The receiving queue response could not be verified.");
  if (value.some((row) => !row || typeof row.count_id !== "string" || !row.count_id)) throw new Error(message);
  const missing = value.filter((row) => !row.branch_id || !row.purchase_order_id);
  if (!missing.length) return value;
  let saved: Row[];
  try { saved = await load(missing.map((row) => row.count_id)); }
  catch { throw new Error(message); }
  if (!Array.isArray(saved)) throw new Error(message);
  return value.map((row) => {
    if (row.branch_id && row.purchase_order_id) return row;
    const source = saved.find((candidate) => candidate["id"] === row.count_id);
    if (!source?.["branch_id"] || !source["purchase_order_id"] ||
      (row.branch_id && row.branch_id !== source["branch_id"]) ||
      (row.purchase_order_id && row.purchase_order_id !== source["purchase_order_id"])) throw new Error(message);
    return { ...row, branch_id: source["branch_id"], purchase_order_id: source["purchase_order_id"] };
  });
}

/** Older receive/cancel RPCs omit ID; verify their saved row before reporting success. */
export async function resolveTransferActionResult(
  value: unknown,
  action: "receive" | "cancel",
  transferId: string,
  load: () => Promise<{ id: string; status: string } | null>,
): Promise<Row> {
  const result = value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
  const expected = action === "receive" ? "completed" : "cancelled";
  if (!result || result["ok"] !== true || result["transfer_id"] != null || result["status"] !== expected)
    return requireTransferResult(value, action, transferId);
  const saved = await load();
  if (!saved || saved.id !== transferId || saved.status !== expected)
    throw new Error("The saved transfer was not verified. Refresh the transfer history before retrying.");
  return requireTransferResult({ ...result, transfer_id: saved.id }, action, transferId);
}
