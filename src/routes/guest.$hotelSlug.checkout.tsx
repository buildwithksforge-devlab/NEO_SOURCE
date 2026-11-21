import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { GuestScreen } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { mpesaSupportsTotal } from "@/lib/mpesa-application-result";
import { useGuestBill, useGuestFolioMpesaCheckout, useGuestPaymentAvailability } from "@/lib/guest-ordering";

export const Route = createFileRoute("/guest/$hotelSlug/checkout")({ component: GuestCheckout });

function GuestCheckout() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const [phone, setPhone] = useState("");
  const [attempt, setAttempt] = useState<{ folioId: string; userId: string; branchId: string | null } | null>(null);
  const activeAttempt = attempt?.userId === user?.id && attempt?.branchId === ws.branch_id ? attempt : null;
  const bill = useGuestBill(ws.organization_id, ws.branch_id, user?.id, Boolean(activeAttempt));
  const available = useGuestPaymentAvailability(ws.organization_id, Boolean(user));
  const pay = useGuestFolioMpesaCheckout();
  const folios = bill.data?.folios ?? [];
  const folio = activeAttempt
    ? folios.find((entry) => entry.id === activeAttempt.folioId)
    : folios.find((entry) => Number(entry.outstanding) > 0) ?? folios[0];
  const due = folio?.outstanding;
  const currency = folio?.currency ?? "KES";
  const billLink = <Link to="/guest/$hotelSlug/folio" params={{ hotelSlug }} className="inline-flex min-h-11 items-center text-sm font-semibold text-slate-700 underline">View itemised bill</Link>;

  return (
    <GuestScreen hotelSlug={hotelSlug} active="stay">
      <div className="neo-commerce-hero">
        <span className="neo-commerce-icon"><CreditCard className="size-5" aria-hidden /></span>
        <div><h1 className="neo-commerce-title">Settle your bill</h1><p className="neo-commerce-copy">{ws.hotel_name || ws.app_name}</p></div>
      </div>
      <div className="mt-6">
        {loading || bill.isLoading ? (
          <div className="flex justify-center py-12 text-[var(--guest-text)]" role="status">
            <Loader2 className="size-6 animate-spin" aria-hidden /><span className="sr-only">Loading folio</span>
          </div>
        ) : !user ? (
          <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to settle your bill" description="Use the account linked to your stay." />
        ) : bill.isError ? (
          <PublicEmptyState title="Your bill couldn’t load" description="Try again to check your balance."
            action={<button className="neo-commerce-primary" onClick={() => void bill.refetch()}>Retry</button>} />
        ) : !folio || due == null ? (
          <PublicEmptyState title={activeAttempt ? "Check your folio" : "No payable balance is available"}
            description={activeAttempt ? "Your payment request was sent. Check your bill or contact the front desk." : "Checkout is available when the hotel opens a folio for your stay."}
            action={billLink} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="neo-commerce-surface p-5 sm:p-6">
              <p className="text-sm font-semibold text-slate-600">Folio {folio.folio_number}</p>
              <h2 className="mt-2 text-3xl font-bold tabular-nums text-slate-950">{money(due, currency)}</h2>
              <p className="text-sm text-slate-600">Outstanding balance</p>
              <dl className="mt-5 space-y-2 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
                <div className="flex justify-between gap-3"><dt>Gross billed</dt><dd className="font-semibold">{money(folio.gross_obligation, currency)}</dd></div>
                <div className="flex justify-between gap-3"><dt>Collected</dt><dd className="font-semibold">{money(folio.collected, currency)}</dd></div>
              </dl>
              {billLink}
            </section>
            <aside className="neo-commerce-summary lg:self-start">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-950"><ShieldCheck className="size-4" aria-hidden /> Payment</h2>
              {due <= 0 ? (
                <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-950" role="status">No payment is due on this folio.</p>
              ) : activeAttempt ? (
                <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-950" role="status">
                  <strong>Waiting for confirmation</strong><p className="mt-1">Approve the M-Pesa prompt on your phone. Your balance updates after the payment is recorded.</p>
                </div>
              ) : available.isError ? (
                <button className="mt-3 min-h-11 text-sm font-semibold text-slate-800 underline" onClick={() => void available.refetch()}>Payment options couldn’t load. Retry</button>
              ) : available.isPending ? (
                <p role="status" className="mt-4 text-sm text-slate-700">Checking payment options…</p>
              ) : available.data?.available && mpesaSupportsTotal(due, currency) ? (
                <form onSubmit={async (event) => {
                  event.preventDefault();
                  if (pay.isPending || phone.replace(/\D/g, "").length < 9) return;
                  try {
                    await pay.mutateAsync({ organizationId: ws.organization_id, folioId: folio.id, msisdn: phone, amount: due });
                    setAttempt({ folioId: folio.id, userId: user.id, branchId: ws.branch_id });
                  } catch { /* The payment mutation reports the error. */ }
                }}>
                  <label className="mt-5 block text-sm font-semibold text-slate-800" htmlFor="folio-phone">M-Pesa number</label>
                  <Input id="folio-phone" className="mt-2 min-h-11 text-base" type="tel" autoComplete="tel" placeholder="07xx xxx xxx" value={phone} onChange={(event) => setPhone(event.target.value)} />
                  <button type="submit" className="neo-commerce-primary mt-4 w-full" disabled={pay.isPending || phone.replace(/\D/g, "").length < 9}>
                    {pay.isPending ? "Sending request…" : `Pay ${money(due, currency)}`}
                  </button>
                </form>
              ) : (
                <p className="mt-4 rounded-xl bg-slate-100 p-4 text-sm text-slate-700">
                  {available.data?.available ? "M-Pesa requires a positive whole KES total." : "Online payment is unavailable for this property."} Please settle at the front desk.
                </p>
              )}
            </aside>
          </div>
        )}
      </div>
    </GuestScreen>
  );
}
