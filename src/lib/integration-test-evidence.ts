export type ProviderTestResult = {
  provider: string;
  status: "passed" | "failed" | "not_configured" | "unsupported";
  detail: string;
  environment: string;
  durationMs: number;
  recorded: boolean;
};

/** A provider response is not saved evidence until the database confirms it. */
export function requireRecordedProviderTest(value: unknown, provider: string): ProviderTestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration test evidence was not confirmed.");
  const r = value as Record<string, unknown>;
  if (r["provider"] !== provider || r["recorded"] !== true || !["passed", "failed", "not_configured", "unsupported"].includes(String(r["status"]))
      || typeof r["detail"] !== "string" || typeof r["environment"] !== "string" || !r["environment"].trim()
      || typeof r["durationMs"] !== "number" || !Number.isFinite(r["durationMs"]) || r["durationMs"] < 0) {
    throw new Error("Integration test evidence was not saved or does not match the requested provider. Refresh before trying again.");
  }
  return r as ProviderTestResult;
}
