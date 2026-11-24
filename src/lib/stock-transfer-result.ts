import { rejectBusinessFailure } from "@/lib/durable-command-result";

export function requireTransferResult(
  value: unknown,
  action: "create" | "receive" | "cancel",
  transferId?: string,
): Record<string, unknown> {
  const message = "The saved transfer was not verified. Refresh the transfer history before retrying.";
  rejectBusinessFailure(value, message);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const result = value as Record<string, unknown>;
  const id = result["transfer_id"];
  if (result["ok"] !== true || typeof id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    (transferId && id !== transferId)) throw new Error(message);
  const expected = action === "receive" ? "completed" : action === "cancel" ? "cancelled" : "in-transit";
  const replayedCreate = action === "create" && result["replayed"] === true &&
    ["in-transit", "completed", "cancelled"].includes(String(result["status"]));
  if (result["status"] !== expected && !replayedCreate) throw new Error(message);
  if (action === "create" && (typeof result["transfer_number"] !== "string" || !result["transfer_number"].trim()))
    throw new Error(message);
  return result;
}
