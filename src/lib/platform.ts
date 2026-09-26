/**
 * Phase 17 — Platform readiness domain logic.
 *
 * Pure, deterministic helpers only. Nothing here contacts a provider or claims
 * a connection is live: status is always derived from stored verification
 * evidence, never assumed. Credentials never appear in this module — only the
 * names of the secrets a provider requires and a masked identifier.
 */

export type IntegrationStatus =
  | "not_configured"
  | "configured"
  | "sandbox_tested"
  | "connected"
  | "degraded"
  | "failed"
  | "disabled";

export type EnvironmentKey = "local" | "development" | "testing" | "staging" | "production";

export type SubscriptionStatus =
  | "trial"
  | "active"
  | "grace_period"
  | "suspended"
  | "cancelled"
  | "expired";

export type GateStatus = "not_started" | "in_progress" | "passed" | "failed" | "waived";

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  not_configured: "Not configured",
  configured: "Credentials recorded",
  sandbox_tested: "Sandbox verified",
  connected: "Connected",
  degraded: "Degraded",
  failed: "Failed",
  disabled: "Disabled",
};

export const INTEGRATION_STATUS_TONE: Record<
  IntegrationStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  not_configured: "neutral",
  configured: "info",
  sandbox_tested: "info",
  connected: "success",
  degraded: "warning",
  failed: "danger",
  disabled: "neutral",
};

export type ConnectionEvidence = {
  status: IntegrationStatus;
  enabled: boolean;
  secret_names?: unknown;
  sandbox_test_passed_at?: string | null;
  security_review_passed_at?: string | null;
  production_approved_at?: string | null;
  last_success_at?: string | null;
  last_error_at?: string | null;
  error_count?: number | null;
  environment?: string | null;
  credentials_expire_at?: string | null;
};

export type ReadinessRequirement = { key: string; label: string; met: boolean };

/**
 * A provider is only "Connected" when every piece of evidence exists. This is
 * intentionally strict: we never present an unverified integration as working.
 */
export function connectionRequirements(c: ConnectionEvidence): ReadinessRequirement[] {
  const secrets = Array.isArray(c.secret_names) ? c.secret_names : [];
  return [
    { key: "secrets", label: "Credentials stored as server-side secrets", met: secrets.length > 0 },
    { key: "sandbox", label: "Sandbox test passed", met: Boolean(c.sandbox_test_passed_at) },
    { key: "security", label: "Security review passed", met: Boolean(c.security_review_passed_at) },
    { key: "approval", label: "Production use approved", met: Boolean(c.production_approved_at) },
    { key: "enabled", label: "Enabled for this property", met: Boolean(c.enabled) },
  ];
}

export function derivedConnectionStatus(c: ConnectionEvidence): IntegrationStatus {
  if (c.status === "disabled" || (!c.enabled && c.status !== "not_configured")) {
    return c.enabled ? c.status : "disabled";
  }
  const reqs = connectionRequirements(c);
  const unmet = reqs.filter((r) => !r.met);
  const errors = c.error_count ?? 0;
  if (unmet.length === 0) {
    if (errors >= 5) return "failed";
    if (errors > 0) return "degraded";
    return "connected";
  }
  if (unmet.length === reqs.length) return "not_configured";
  if (c.sandbox_test_passed_at) return "sandbox_tested";
  return "configured";
}

export function isCredentialExpiring(expiresAt: string | null | undefined, days = 30): boolean {
  if (!expiresAt) return false;
  const due = new Date(expiresAt).getTime();
  return due - Date.now() < days * 86_400_000;
}

/** Exponential backoff for the outbound integration outbox, capped at 6 hours. */
export function nextRetryDelayMs(attempt: number): number {
  const base = 30_000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, 6 * 3_600_000);
}

export function maskIdentifier(value: string | null | undefined): string {
  if (!value) return "—";
  const v = value.trim();
  if (v.length <= 4) return "••••";
  return `${"•".repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`;
}

/** Deterministic idempotency key for outbound provider events. */
export function idempotencyKey(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((p) => (p === null || p === undefined ? "_" : String(p)))
    .join(":")
    .slice(0, 200);
}

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trial: "Trial",
  active: "Active",
  grace_period: "Grace period",
  suspended: "Suspended",
  cancelled: "Cancelled",
  expired: "Expired",
};

export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const diff = new Date(date).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

export function subscriptionAlert(sub: {
  status?: string | null;
  trial_ends_at?: string | null;
  grace_until?: string | null;
  renewal_date?: string | null;
} | null): { tone: "info" | "warning" | "danger"; message: string } | null {
  if (!sub) return null;
  const status = (sub.status ?? "trial") as SubscriptionStatus;
  if (status === "suspended") {
    return { tone: "danger", message: "Subscription suspended. Operational modules are read-only until renewal." };
  }
  if (status === "grace_period") {
    const d = daysUntil(sub.grace_until);
    return {
      tone: "warning",
      message: d === null ? "Subscription is in the grace period." : `Grace period ends in ${d} day(s).`,
    };
  }
  if (status === "trial") {
    const d = daysUntil(sub.trial_ends_at);
    return {
      tone: d !== null && d <= 7 ? "warning" : "info",
      message: d === null ? "Trial subscription." : `Trial ends in ${d} day(s).`,
    };
  }
  const r = daysUntil(sub.renewal_date);
  if (r !== null && r <= 30) return { tone: "info", message: `Renewal due in ${r} day(s).` };
  return null;
}

export const MIGRATION_DATA_TYPES = [
  "guests",
  "corporate_clients",
  "rooms",
  "rates",
  "future_reservations",
  "menu_items",
  "suppliers",
  "stock_items",
  "opening_stock",
  "chart_of_accounts",
  "opening_balances",
  "employees",
] as const;

export type MigrationRowInput = Record<string, string>;

export type MigrationValidation = {
  row_number: number;
  status: "valid" | "invalid" | "duplicate";
  errors: string[];
  warnings: string[];
  normalized: Record<string, string>;
};

/**
 * Client-side pre-validation for an import file. This never writes anything —
 * it produces the dry-run report the operator must review before approval.
 */
export function validateMigrationRows(
  dataType: string,
  rows: MigrationRowInput[],
  requiredColumns: string[],
): MigrationValidation[] {
  const seen = new Map<string, number>();
  return rows.map((raw, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) normalized[k.trim()] = (v ?? "").toString().trim();

    for (const col of requiredColumns) {
      if (!normalized[col]) errors.push(`Missing required value: ${col}`);
    }
    if (normalized['email'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized['email'])) {
      errors.push("Email address is not valid");
    }
    if (normalized['phone'] && normalized['phone'].replace(/\D/g, "").length < 9) {
      warnings.push("Telephone number looks too short");
    }
    for (const amountKey of ["amount", "balance", "opening_balance", "rate", "cost"]) {
      const val = normalized[amountKey];
      if (val && Number.isNaN(Number(val.replace(/,/g, "")))) errors.push(`${amountKey} is not a number`);
    }

    const identity = (normalized['email'] || normalized['phone'] || normalized['code'] || normalized['name'] || "").toLowerCase();
    let status: MigrationValidation["status"] = errors.length ? "invalid" : "valid";
    if (identity) {
      const first = seen.get(identity);
      if (first !== undefined) {
        status = "duplicate";
        warnings.push(`Duplicate of row ${first}`);
      } else {
        seen.set(identity, i + 1);
      }
    }
    if (dataType === "opening_balances" && !normalized['account']) {
      errors.push("Opening balances require an account reference");
      status = "invalid";
    }
    return { row_number: i + 1, status, errors, warnings, normalized };
  });
}

export function migrationSummary(results: MigrationValidation[]) {
  return {
    total: results.length,
    valid: results.filter((r) => r.status === "valid").length,
    invalid: results.filter((r) => r.status === "invalid").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
  };
}

/** Parses a delimited text file into row objects. Header row is required. */
export function parseDelimited(text: string, delimiter = ","): MigrationRowInput[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === delimiter && !quoted) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const headers = split(lines[0]!).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: MigrationRowInput = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

export type GateLike = { gate_key: string; name: string; category: string; mandatory: boolean; status: string };

export function readinessScore(gates: GateLike[]): {
  total: number;
  passed: number;
  blocking: GateLike[];
  percent: number;
  goLive: boolean;
} {
  const mandatory = gates.filter((g) => g.mandatory);
  const passed = mandatory.filter((g) => g.status === "passed" || g.status === "waived");
  const blocking = mandatory.filter((g) => g.status !== "passed" && g.status !== "waived");
  return {
    total: mandatory.length,
    passed: passed.length,
    blocking,
    percent: mandatory.length === 0 ? 0 : Math.round((passed.length / mandatory.length) * 100),
    goLive: mandatory.length > 0 && blocking.length === 0,
  };
}

export type DefectLike = { severity: string; status: string; release_blocking?: boolean };

export function defectGate(defects: DefectLike[]): { blocking: number; open: number; releasable: boolean } {
  const open = defects.filter((d) => !["closed", "rejected", "accepted"].includes(d.status));
  const blocking = open.filter((d) => d.severity === "critical" || d.release_blocking);
  return { blocking: blocking.length, open: open.length, releasable: blocking.length === 0 };
}

export function slaDeadline(createdAt: string, minutes: number | null | undefined): Date | null {
  if (!minutes) return null;
  return new Date(new Date(createdAt).getTime() + minutes * 60_000);
}

export function slaState(
  createdAt: string,
  firstResponseAt: string | null | undefined,
  minutes: number | null | undefined,
): { label: string; tone: "neutral" | "success" | "warning" | "danger" } {
  const deadline = slaDeadline(createdAt, minutes);
  if (!deadline) return { label: "No target", tone: "neutral" };
  if (firstResponseAt) {
    const met = new Date(firstResponseAt) <= deadline;
    return met ? { label: "Responded in target", tone: "success" } : { label: "Response target missed", tone: "danger" };
  }
  const left = deadline.getTime() - Date.now();
  if (left < 0) return { label: "Response overdue", tone: "danger" };
  if (left < 30 * 60_000) return { label: "Response due shortly", tone: "warning" };
  return { label: `Response due ${deadline.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, tone: "neutral" };
}

export function reference(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}
