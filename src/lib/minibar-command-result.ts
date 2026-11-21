import { requireSavedRecord } from "@/lib/durable-command-result";

export function requireMinibarPostingResult(value: unknown, lineCount: number) {
  const message =
    "The saved minibar charge was not confirmed. Check its history before posting again.";
  const result = requireSavedRecord(value, ["posting_id", "posting_number"], message);
  const total = result["total"];
  if (
    result["ok"] !== true ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(result["posting_id"])) ||
    result["lines"] !== lineCount ||
    lineCount < 1 ||
    (typeof total !== "number" && typeof total !== "string") ||
    String(total).trim() === "" ||
    !Number.isFinite(Number(total)) ||
    Number(total) < 0
  )
    throw new Error(message);
  return result;
}
