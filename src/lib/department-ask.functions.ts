/**
 * Ask NEØ (departmental) — answered server-side, from authorised records only.
 *
 * The browser never chooses the figures. The payload is re-read through
 * `neo_my_work`, which resolves organisation, property and every effective
 * permission inside the database before a single count is taken.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  answerDepartmentQuestion,
  BANK_PATTERN,
  PAYROLL_PATTERN,
  type BankFacts,
  type PayrollFacts,
} from "@/lib/department-ask";

import type { WorkItem } from "@/lib/my-work";

type Result = Promise<{ data: unknown; error: { message: string } | null }>;
type Selected = {
  order: (col: string, opts: { ascending: boolean }) => { limit: (n: number) => Result };
  eq: (col: string, value: unknown) => Selected;
} & Result;

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Result;
  from: (table: string) => { select: (cols: string) => Selected };
};


type ComputedPay = {
  currency?: string;
  base_pay?: number;
  deductions?: number;
  net_pay?: number;
  missing_compensation?: boolean;
};

/**
 * Pay figures for the most recent payroll period.
 *
 * `neo_hr_payroll_compute` itself requires payroll permission and returns
 * nothing without it, so an empty result is a refusal, not a missing answer.
 */
async function readPayrollFacts(client: RpcClient): Promise<PayrollFacts | null> {
  const periods = await client.from("payroll_periods").select("id, name, period_start, period_end").order("period_start", { ascending: false }).limit(1);
  if (periods.error) return null;
  const period = ((periods.data ?? []) as Record<string, unknown>[])[0];
  if (!period) return null;

  const { data, error } = await client.rpc("neo_hr_payroll_compute", { _period: period["id"] });
  if (error) return null;
  const rows = (data ?? []) as ComputedPay[];
  if (rows.length === 0) return null;

  const sum = (key: "base_pay" | "deductions" | "net_pay") =>
    rows.reduce((total, r) => total + Number(r[key] ?? 0), 0);

  return {
    periodLabel: String(period["name"] ?? "Current payroll period"),
    currency: rows[0]?.currency ?? "KES",
    employees: rows.length,
    missingCompensation: rows.filter((r) => r.missing_compensation).length,
    base: sum("base_pay"),
    deductions: sum("deductions"),
    net: sum("net_pay"),
    route: "/hr/payroll",
  };
}

/**
 * Posted bank and cash positions for the current financial period.
 *
 * `neo_general_ledger` refuses anyone without permission to read the ledger,
 * so an error or empty result here is a refusal, not a zero balance. Two bank
 * accounts mapped to one ledger account are one sum of money and counted once.
 */
async function readBankFacts(client: RpcClient, branchId: string | null): Promise<BankFacts | null> {
  const year = new Date().getUTCFullYear();
  const from = `${year}-01-01`;
  const to = new Date().toISOString().slice(0, 10);

  const ledger = await client.rpc("neo_general_ledger", { _from: from, _to: to, _branch: branchId, _account: null });
  if (ledger.error) return null;

  const accounts = await client.from("bank_accounts").select("name, currency, active, gl_account_id");
  if (accounts.error) return null;

  const lines = (ledger.data ?? []) as Record<string, unknown>[];
  const position = new Map<string, number>();
  for (const l of lines) position.set(String(l["account_id"]), Number(l["running_balance"] ?? 0));

  const rows = ((accounts.data ?? []) as Record<string, unknown>[]).filter((a) => a["active"] !== false);
  if (rows.length === 0) return null;

  const counted = new Set<string>();
  let total = 0;
  let quiet = 0;
  let unmapped = 0;
  const named: { name: string; balance: number | null }[] = [];

  for (const a of rows) {
    const gl = String(a["gl_account_id"] ?? "");
    if (!gl) {
      unmapped += 1;
      named.push({ name: String(a["name"] ?? "Account"), balance: null });
      continue;
    }
    if (!position.has(gl)) {
      quiet += 1;
      named.push({ name: String(a["name"] ?? "Account"), balance: null });
      continue;
    }
    const balance = position.get(gl) ?? 0;
    named.push({ name: String(a["name"] ?? "Account"), balance });
    if (!counted.has(gl)) {
      counted.add(gl);
      total += balance;
    }
  }

  return {
    currency: String(rows[0]?.["currency"] ?? "KES"),
    rangeLabel: `${from} to ${to}`,
    accounts: named,
    total,
    quiet,
    unmapped,
    route: "/finance/bank-accounts",
  };
}


export const askNeoDepartment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { question?: string; branchId?: string | null; propertyLabel?: string | null }) => ({
    question: String(input?.question ?? "").slice(0, 400).trim(),
    branchId: input?.branchId ?? null,
    propertyLabel: input?.propertyLabel ?? "your property",
  }))
  .handler(async ({ data, context }) => {
    if (!data.question) return { ok: false as const, reason: "empty_question" as const };

    const client = context.supabase as unknown as RpcClient;
    const { data: payload, error } = await client.rpc("neo_my_work", { _branch: data.branchId });
    if (error) throw new Error(error.message);

    const work = (payload ?? { authorised: false }) as {
      authorised?: boolean;
      today?: string;
      items?: WorkItem[];
    };

    if (work.authorised === false) {
      return {
        ok: true as const,
        answer: {
          kind: "refused" as const,
          question: data.question,
          headline: "NEØ cannot answer that with your permissions.",
          statements: [],
          limitation: "Your account does not yet reach any operational records in this property.",
          scope: { propertyLabel: data.propertyLabel, today: null, modules: [] },
        },
      };
    }

    const payroll = PAYROLL_PATTERN.test(data.question) ? await readPayrollFacts(client) : null;
    const bank = BANK_PATTERN.test(data.question) ? await readBankFacts(client, data.branchId) : null;

    const answer = answerDepartmentQuestion(data.question, work.items ?? [], {
      propertyLabel: data.propertyLabel,
      today: work.today ?? null,
      payroll,
      bank,
    });



    return { ok: true as const, answer };
  });
