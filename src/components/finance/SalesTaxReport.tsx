import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SectionCard } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useFinanceCtx, useFinanceFactScope } from "@/lib/finance-data";
import { formatDocumentMoney } from "@/lib/document-identity";
import { guardedRpc } from "@/lib/rpc-guard";

type AmountRow = { currency: string; label: string; code?: string; account_code?: string; amount: number };
type TaxSummary = {
  sales: { currency: string; gross: number; net: number; sales: number }[];
  taxes: AmountRow[];
  treatments: AmountRow[];
  refunds: AmountRow[];
};

export function SalesTaxReport() {
  const scope = useFinanceFactScope();
  const { organizationId } = useFinanceCtx();
  const [from, setFrom] = useState(scope.from);
  const [to, setTo] = useState(scope.to);
  const validDates = Boolean(from && to && from <= to);
  const summary = useQuery({
    queryKey: ["finance", "sales-tax-summary", organizationId, scope.branchId, from, to],
    enabled: validDates && Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc<TaxSummary>(supabase, "neo_sales_tax_finance_summary", {
        _branch: scope.branchId, _from: from, _to: to,
      });
      if (error) throw error;
      return data;
    },
  });
  return (
    <SectionCard title="Posted sales tax" description="Menu sales with saved tax profiles and posted journals. Refund reversals follow the original liability accounts.">
      <div className="flex flex-wrap gap-4">
        <div><Label htmlFor="sales-tax-from">From</Label><Input id="sales-tax-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
        <div><Label htmlFor="sales-tax-to">Through</Label><Input id="sales-tax-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
      </div>
      {!validDates && <p className="mt-3 text-sm" role="alert">Choose a valid reporting period.</p>}
      {summary.isLoading && <p className="mt-3 text-sm" aria-live="polite">Loading posted sales</p>}
      {summary.error && <p className="mt-3 text-sm" role="alert">{summary.error.message}</p>}
      {summary.data && <div className="mt-4 space-y-4">
        {summary.data.sales.length === 0 && <p className="text-sm">No eligible posted sales in this period.</p>}
        {summary.data.sales.map((sale) => (
          <dl key={sale.currency} className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
            <div><dt>Gross sales</dt><dd className="font-semibold">{formatDocumentMoney(sale.gross, sale.currency)}</dd></div>
            <div><dt>Net sales</dt><dd className="font-semibold">{formatDocumentMoney(sale.net, sale.currency)}</dd></div>
            <div><dt>Transactions</dt><dd className="font-semibold">{sale.sales}</dd></div>
          </dl>
        ))}
        {([
          ["Tax collected", summary.data.taxes],
          ["Sales by tax treatment", summary.data.treatments],
          ["Tax reversed on refunds", summary.data.refunds],
        ] as const).map(([label, rows]) => rows.length > 0 && (
          <div key={label}>
            <h3 className="font-semibold">{label}</h3>
            <dl className="divide-y text-sm">
              {rows.map((row) => <div key={`${row.currency}-${row.code}-${row.label}-${row.account_code}`} className="flex justify-between gap-4 py-2">
                <dt>{row.label}{row.account_code ? ` · ${row.account_code}` : ""}</dt>
                <dd className="shrink-0">{formatDocumentMoney(row.amount, row.currency)}</dd>
              </div>)}
            </dl>
          </div>
        ))}
      </div>}
    </SectionCard>
  );
}
