import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";

type RequestedLine = { id: string; description: string; quantity: number; unit: string };
type SupplierRfq = {
  id: string;
  rfq_number: string;
  title: string | null;
  notes: string | null;
  closes_at: string | null;
  currency: string | null;
  lines: RequestedLine[];
  response: { number: string; total: number; status: string; submitted_at: string } | null;
};
type Price = { unit_price: string; tax_rate: string; lead_time_days: string; notes: string };

export function SupplierRfqs({ branchId, relationshipId }: { branchId: string; relationshipId: string }) {
  const qc = useQueryClient();
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const queryKey = ["partner-supplier-rfqs", branchId, relationshipId];
  const rfqs = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_supplier_rfqs", {
        _branch: branchId, _relationship: relationshipId,
      });
      if (error) throw new Error(error.message);
      return data as SupplierRfq[];
    },
  });
  const submit = useMutation({
    mutationFn: async (input: { rfq: SupplierRfq; prices: Record<string, Price>; terms: string }) => {
      const lines = input.rfq.lines.map((line) => {
        const p = input.prices[line.id];
        if (!p || p.unit_price.trim() === "" || !Number.isFinite(Number(p.unit_price)) || Number(p.unit_price) < 0)
          throw new Error(`Enter a valid unit price for ${line.description}`);
        const tax = p.tax_rate.trim() === "" ? 0 : Number(p.tax_rate);
        const lead = p.lead_time_days.trim() === "" ? null : Number(p.lead_time_days);
        if (!Number.isFinite(tax) || tax < 0 || tax > 100 ||
          (lead !== null && (!Number.isInteger(lead) || lead < 0)))
          throw new Error(`Check the tax rate and lead time for ${line.description}`);
        return { request_line_id: line.id, unit_price: Number(p.unit_price), tax_rate: tax,
          lead_time_days: lead, notes: p.notes.trim() || null };
      });
      const fingerprint = JSON.stringify({ branchId, relationshipId, rfq: input.rfq.id, lines, terms: input.terms.trim() });
      if (attempt.current?.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      }
      const { data, error } = await guardedRpc(supabase, "neo_partner_supplier_quote_submit", {
        _branch: branchId, _relationship: relationshipId, _rfq: input.rfq.id,
        _lines: lines, _notes: input.terms.trim() || null, _attempt: attempt.current.id,
      });
      if (error) throw new Error(error.message);
      return data as { quotation_number: string; total_amount: number };
    },
    onSuccess: () => {
      attempt.current = null;
      void qc.invalidateQueries({ queryKey });
    },
  });

  if (rfqs.isLoading) return <p className="mt-4 text-sm text-white/70">Loading invitations…</p>;
  if (rfqs.error) return <p role="alert" className="mt-4 text-sm text-white/80">Could not load invitations: {rfqs.error.message}</p>;
  if (!rfqs.data?.length) return <p className="mt-4 text-sm text-white/70">No RFQs have been addressed to your business at this property.</p>;
  return <div className="mt-4 space-y-4">{rfqs.data.map((rfq) =>
    <SupplierRfqForm key={rfq.id} rfq={rfq} onSubmit={(prices, terms) => submit.mutateAsync({ rfq, prices, terms })} />
  )}</div>;
}

function SupplierRfqForm({ rfq, onSubmit }: {
  rfq: SupplierRfq;
  onSubmit: (prices: Record<string, Price>, terms: string) => Promise<unknown>;
}) {
  const [prices, setPrices] = useState<Record<string, Price>>({});
  const [terms, setTerms] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const closed = Boolean(rfq.closes_at && Date.now() > new Date(rfq.closes_at).getTime());
  const selected = rfq.response?.status === "selected";
  useEffect(() => { setPrices({}); setTerms(""); }, [rfq.id]);
  const change = (id: string, field: keyof Price, value: string) =>
    setPrices((current) => ({ ...current, [id]: {
      unit_price: "", tax_rate: "", lead_time_days: "", notes: "", ...current[id], [field]: value,
    } }));
  const estimate = rfq.lines.reduce((sum, line) => {
    const p = prices[line.id];
    return sum + (Number(line.quantity) * Number(p?.unit_price || 0) * (1 + Number(p?.tax_rate || 0) / 100));
  }, 0);
  return <section className="neo-pub-card min-w-0 p-5" aria-label={`RFQ ${rfq.rfq_number}`}>
    <h2 className="text-base font-semibold text-white">{rfq.rfq_number} · {rfq.title || "Request for quotation"}</h2>
    <p className="mt-1 text-xs text-white/65">{rfq.closes_at ? `Closes ${new Date(rfq.closes_at).toLocaleString()}` : "No closing date set"}</p>
    {rfq.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-white/75">{rfq.notes}</p>}
    {rfq.response && <p className="mt-3 text-sm text-white/80">Your {rfq.response.status} quote: {rfq.response.number} · {Number(rfq.response.total).toLocaleString()} {rfq.currency ?? ""}</p>}
    <div className="mt-4 space-y-3">{rfq.lines.map((line) => <div key={line.id} className="rounded-xl border border-white/15 p-3">
      <p className="text-sm font-medium text-white">{line.description} · {line.quantity} {line.unit}</p>
      <p className="mt-1 text-xs text-white/60">Quote your price for one {line.unit || "unit"}, before tax. Check the unit and quantity before submitting.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="text-xs text-white/70">Unit price ({rfq.currency ?? "property currency"})<input aria-label={`${line.description} unit price`} type="number" min="0" step="0.01" inputMode="decimal" disabled={closed || selected || pending} value={prices[line.id]?.unit_price ?? ""} onChange={(e) => change(line.id, "unit_price", e.target.value)} className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2 text-white" /></label>
        <label className="text-xs text-white/70">Tax rate (%)<input aria-label={`${line.description} tax rate`} type="number" min="0" max="100" step="0.01" disabled={closed || selected || pending} value={prices[line.id]?.tax_rate ?? ""} onChange={(e) => change(line.id, "tax_rate", e.target.value)} className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2 text-white" /></label>
        <label className="text-xs text-white/70">Lead time (days)<input aria-label={`${line.description} lead time`} type="number" min="0" step="1" disabled={closed || selected || pending} value={prices[line.id]?.lead_time_days ?? ""} onChange={(e) => change(line.id, "lead_time_days", e.target.value)} className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2 text-white" /></label>
      </div>
      <input aria-label={`${line.description} notes`} placeholder="Item specification or availability (optional)" disabled={closed || selected || pending} value={prices[line.id]?.notes ?? ""} onChange={(e) => change(line.id, "notes", e.target.value)} className="mt-2 w-full rounded-lg border border-white/20 bg-white/10 p-2 text-sm text-white placeholder:text-white/50" />
    </div>)}</div>
    {!closed && !selected && rfq.lines.length > 0 && <div className="mt-4">
      <label className="text-xs text-white/70">Payment and delivery terms<textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2 text-sm text-white" /></label>
      <p className="mt-2 text-sm text-white/80">Estimated quote including entered tax: {estimate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {rfq.currency ?? ""}</p>
      {rfq.response && <p className="mt-1 text-xs text-white/65">Submitting revised prices preserves your previous quotation in the audit history.</p>}
      <button type="button" disabled={pending} onClick={async () => { setPending(true); setMessage(""); try {
        const result = await onSubmit(prices, terms) as { quotation_number: string };
        setMessage(`Quotation ${result.quotation_number} submitted to Procurement.`);
      } catch (error) { setMessage(error instanceof Error ? error.message : "Could not submit the quotation."); }
      finally { setPending(false); } }} className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#020A1C] disabled:opacity-50">{pending ? "Submitting…" : rfq.response ? "Submit revised quote" : "Submit quotation"}</button>
    </div>}
    {closed && <p className="mt-3 text-sm text-white/70">This invitation has closed.</p>}
    {selected && <p className="mt-3 text-sm text-white/70">This quotation has been selected and is locked.</p>}
    {message && <p role="status" className="mt-3 text-sm text-white">{message}</p>}
  </section>;
}
