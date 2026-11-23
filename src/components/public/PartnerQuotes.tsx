import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

type RequestForQuote = {
  id: string;
  number: string;
  title: string | null;
  closes_at: string | null;
  currency: string;
  quote_id: string | null;
  total: number | null;
  valid_until: string | null;
  notes: string | null;
  can_quote: boolean;
  lines: { id: string; description: string; quantity: number; unit: string; price: number | null }[] | null;
};

export function PartnerQuotes({ branch, relationship }: { branch: string; relationship: string }) {
  const { user } = useAuth();
  const args = { _branch: branch, _relationship: relationship };
  const requests = useQuery({
    queryKey: ["partner-rfq-quotes", user?.id, branch, relationship],
    queryFn: async () => {
      const { data, error } = await guardedRpc<RequestForQuote[]>(supabase, "neo_partner_rfq_quotes", args);
      if (error) throw new Error(error.message);
      return data;
    },
  });
  if (requests.isPending) return <p role="status">Loading quotation requests…</p>;
  if (requests.isError) return <p role="alert">Quotation requests could not be loaded. <button onClick={() => void requests.refetch()}>Retry</button></p>;
  if (!requests.data.length) return <p>No quotation invitations from this property yet.</p>;
  return <div className="space-y-4">{requests.data.map((request) =>
    <QuoteForm key={`${request.id}:${request.quote_id}`} request={request} args={args} refresh={requests.refetch} />
  )}</div>;
}

function QuoteForm({ request, args, refresh }: {
  request: RequestForQuote;
  args: { _branch: string; _relationship: string };
  refresh: () => Promise<unknown>;
}) {
  const lines = request.lines ?? [];
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(
    lines.map((line) => [line.id, line.price == null ? "" : String(line.price)]),
  ));
  const [validUntil, setValidUntil] = useState(request.valid_until ?? "");
  const [notes, setNotes] = useState(request.notes ?? "");
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await guardedRpc(supabase, "neo_partner_rfq_quotes", {
        ...args, _rfq: request.id, _prices: prices, _valid_until: validUntil, _notes: notes, _previous: request.quote_id,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: refresh,
  });
  const format = (amount: number) => new Intl.NumberFormat(undefined, {
    style: "currency", currency: request.currency,
  }).format(amount);

  return (
    <form className="neo-partner-hero flex-col space-y-2" onSubmit={(event) => {
      event.preventDefault();
      if (!submit.isPending) submit.mutate();
    }}>
      <div>
        <h2 className="font-semibold">{request.title || request.number}</h2>
        {request.title ? <p>{request.number}</p> : null}
        {request.closes_at ? <p>Closes {new Date(request.closes_at).toLocaleString()}</p> : null}
        {request.total != null ? <p>Submitted total {format(request.total)}</p> : null}
      </div>
      {lines.map((line) => <label key={line.id} className="block w-full">
        {line.description} · {line.quantity} {line.unit}
        {request.can_quote ? <input className="block min-h-11 w-full rounded border bg-background px-3 text-foreground"
          aria-label={`Unit price for ${line.description}`} inputMode="decimal" min="0" step="0.01"
          type="number" required value={prices[line.id] ?? ""} disabled={submit.isPending}
          onChange={(event) => setPrices({ ...prices, [line.id]: event.target.value })} />
          : line.price != null ? <span> · {format(line.price)} per {line.unit}</span> : null}
      </label>)}
      {request.can_quote && lines.length ? <>
        <label className="block">Valid until
          <input className="block min-h-11 rounded border bg-background px-3 text-foreground" type="date"
            required value={validUntil} disabled={submit.isPending} onChange={(event) => setValidUntil(event.target.value)} />
        </label>
        <label className="block">Delivery and payment terms
          <textarea className="block w-full rounded border bg-background p-3 text-foreground" maxLength={2000}
            value={notes} disabled={submit.isPending} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <p>Quote total {format(lines.reduce((sum, line) =>
          sum + Math.round(line.quantity * Number(prices[line.id] || 0) * 100) / 100, 0))}</p>
        <button className="neo-commerce-primary" disabled={submit.isPending}>
          {request.quote_id ? "Submit revised quotation" : "Submit quotation"}
        </button>
      </> : <p>Quotation changes are closed for this request.</p>}
      {submit.error ? <p role="alert">{submit.error.message}</p> : null}
    </form>
  );
}
