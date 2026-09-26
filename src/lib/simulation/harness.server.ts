/**
 * NEØ System Test — test harness (server only).
 *
 * The harness owns the vocabulary of a run: a case either PASSES, raises a
 * WARNING because something outside the product is not configured, FAILS
 * because the product misbehaved, or is CRITICAL because isolation or
 * authorisation broke. A missing external provider is never a core failure.
 *
 * Every case records its assertions, its evidence and its duration, and every
 * record a case creates is registered as an artifact so a run can be removed
 * again without touching anything else.
 */

export type CaseStatus = "pass" | "warn" | "fail" | "critical" | "skip";

export type Assertion = {
  label: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
};

export type CaseResult = {
  suite: string;
  suiteOrder: number;
  caseKey: string;
  name: string;
  status: CaseStatus;
  severity: "normal" | "high" | "critical";
  durationMs: number;
  assertions: Assertion[];
  evidence: Record<string, unknown>;
  detail: string | null;
};

export type Artifact = { table: string; id: string };

/** Thrown by a case when an external dependency is absent, not broken. */
export class NotConfigured extends Error {}

/** Thrown when isolation or authorisation was breached. */
export class CriticalFailure extends Error {}

/** Thrown when a prerequisite is missing, so the case cannot run at all. */
export class Skipped extends Error {}

export class CaseContext {
  readonly assertions: Assertion[] = [];
  readonly evidence: Record<string, unknown> = {};

  /** Records a check. A failed check fails the case. */
  check(label: string, ok: boolean, expected?: unknown, actual?: unknown) {
    this.assertions.push({ label, ok, expected, actual });
    return ok;
  }

  /** Records a check and stops the case immediately when it fails. */
  must(label: string, ok: boolean, expected?: unknown, actual?: unknown) {
    this.check(label, ok, expected, actual);
    if (!ok) throw new Error(label);
  }

  /** Records a check whose failure means data crossed a tenant or role boundary. */
  mustIsolate(label: string, ok: boolean, expected?: unknown, actual?: unknown) {
    this.check(label, ok, expected, actual);
    if (!ok) throw new CriticalFailure(label);
  }

  note(key: string, value: unknown) {
    this.evidence[key] = value;
  }
}

/** Picks the first project source line out of a stack trace, for readers. */
export function codeLocation(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split("\n").slice(1)) {
    const match = line.match(/((?:src|scripts)\/[\w./-]+\.(?:ts|tsx)):(\d+):(\d+)/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return null;
}

export class Recorder {
  readonly cases: CaseResult[] = [];
  readonly artifacts: Artifact[] = [];

  artifact(table: string, id: string | null | undefined) {
    if (id) this.artifacts.push({ table, id });
  }

  async run(
    suite: string,
    suiteOrder: number,
    caseKey: string,
    name: string,
    fn: (t: CaseContext) => Promise<void>,
  ): Promise<CaseResult> {
    const t = new CaseContext();
    const started = Date.now();
    let status: CaseStatus = "pass";
    let severity: CaseResult["severity"] = "normal";
    let detail: string | null = null;

    // Where this case is written, so a reader can open the exact code.
    const definedAt = codeLocation(new Error().stack);
    if (definedAt) t.note("_case_source", definedAt);

    try {
      await fn(t);
      if (t.assertions.some((a) => !a.ok)) {
        status = "fail";
        severity = "high";
        detail = t.assertions.filter((a) => !a.ok).map((a) => a.label).join("; ");
      }
    } catch (error) {
      if (error instanceof NotConfigured) {
        status = "warn";
        detail = error.message;
      } else if (error instanceof Skipped) {
        status = "skip";
        detail = error.message;
      } else if (error instanceof CriticalFailure) {
        status = "critical";
        severity = "critical";
        detail = error.message;
      } else {
        status = "fail";
        severity = "high";
        detail = error instanceof Error ? error.message : String(error);
      }
      if (error instanceof Error && error.stack) {
        t.note("_failure_trace", error.stack.split("\n").slice(0, 8).join("\n"));
        const at = codeLocation(error.stack);
        if (at) t.note("_failed_at", at);
      }
    }

    const result: CaseResult = {
      suite,
      suiteOrder,
      caseKey,
      name,
      status,
      severity,
      durationMs: Date.now() - started,
      assertions: t.assertions,
      evidence: t.evidence,
      detail,
    };
    this.cases.push(result);
    return result;
  }

  totals() {
    const count = (s: CaseStatus) => this.cases.filter((c) => c.status === s).length;
    return {
      tests: this.cases.length,
      passed: count("pass"),
      warnings: count("warn"),
      failed: count("fail"),
      critical: count("critical"),
      skipped: count("skip"),
    };
  }
}

/** Reads a PostgREST-style error into a comparable shape. */
export function denial(error: { message?: string; code?: string } | null): {
  denied: boolean;
  message: string;
} {
  if (!error) return { denied: false, message: "" };
  const message = error.message ?? "";
  const denied =
    /permission|not allowed|denied|forbidden|unauthor|row-level|violates row-level security|no access|cannot/i.test(
      message,
    ) || error.code === "42501" || error.code === "PGRST301";
  return { denied, message };
}
