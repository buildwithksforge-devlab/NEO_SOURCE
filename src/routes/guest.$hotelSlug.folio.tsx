import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2, Receipt } from "lucide-react";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { useGuestScreenView } from "@/lib/guest-app";
import { useGuestBill, useGuestPaymentAvailability } from "@/lib/guest-ordering";

export const Route = createFileRoute("/guest/$hotelSlug/folio")({
  head: () => ({
    meta: [
      { title: "My Bill — NEØ Guest" },
      { name: "description", content: "Your live room folio, charges and receipts at this property." },
      { property: "og:title", content: "My Bill — NEØ Guest" },
      { property: "og:description", content: "Your live room folio, charges and receipts at this property." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FolioPage,
});

function FolioPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  // Ownership is resolved inside the database routine from the signed-in
  // account, so no customer id ever leaves the browser.
  const bill = useGuestBill(ws.organization_id, Boolean(user));
  const paymentAvailability = useGuestPaymentAvailability(ws.organization_id);
  useGuestScreenView(ws.organization_id, "folio", Boolean(user));

  const list = bill.data?.folios ?? [];
  const payments = bill.data?.payments ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const activeFolio = list.find((f) => f.id === selected) ?? list[0];
  const currency = activeFolio?.currency ?? "KES";
  const lines = activeFolio?.lines ?? [];

  return (
    <GuestScreen hotelSlug={hotelSlug} active="trips">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          My bill
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Everything posted to your account at {ws.hotel_name}, exactly as the property's ledger holds it.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to see your bill" description="Your folio, confirmed payments and receipts are visible only to your account." />
      ) : bill.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : list.length === 0 ? (
        <GuestSection title="Folios">
          <PublicEmptyState
            title="No open bill"
            description="A folio appears here once the property checks you in or posts a charge to your account."
          />
        </GuestSection>
      ) : (
        <>
          {list.length > 1 ? (
            <GuestSection title="Select an account">
              <div className="flex flex-wrap gap-2">
                {list.map((f) => {
                  const isActive = f.id === activeFolio?.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setSelected(f.id)}
                      className="rounded-full border px-3 py-1.5 text-xs font-medium"
                      style={{
                        borderColor: isActive ? ws.primary_color : "rgba(0,0,0,0.1)",
                        color: isActive ? ws.primary_color : brandFallback.steel,
                      }}
                    >
                      {f.folio_number ?? f.id.slice(0, 8)} · {f.status}
                    </button>
                  );
                })}
              </div>
            </GuestSection>
          ) : null}

          <GuestSection
            title={`Folio ${activeFolio?.folio_number ?? ""}`}
            description={`Opened ${activeFolio?.opened_at ? new Date(activeFolio.opened_at).toLocaleDateString() : "—"} · ${activeFolio?.status ?? ""}`}
          >
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Figure label="Net charges" value={money(activeFolio?.net_revenue, currency)} />
              <Figure label="VAT" value={money(activeFolio?.tax, currency)} />
              <Figure label="Service charge" value={money(activeFolio?.service_charge, currency)} />
              <Figure label="Gross billed" value={money(activeFolio?.gross_obligation, currency)} />
              <Figure label="Collected" value={money(activeFolio?.collected, currency)} />
            </dl>
            <div
              className="neo-public-row mt-4 rounded-xl px-4 py-3"
              style={{ background: "rgba(0,0,0,0.03)" }}
            >
              <span className="text-sm font-medium" style={{ color: brandFallback.steel }}>
                 Outstanding
              </span>
              <span className="text-lg font-semibold" style={{ color: brandFallback.secondary }}>
                 {money(activeFolio?.outstanding, currency)}
              </span>
            </div>

            <div className="mt-4 rounded-2xl border border-black/5 bg-slate-50 p-4 text-sm text-slate-700">
              {paymentAvailability.data?.available && Number(activeFolio?.outstanding ?? 0) > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3"><span>Ready to settle this folio?</span><Link to="/guest/$hotelSlug/checkout" params={{ hotelSlug }} className="neo-commerce-primary">Go to checkout</Link></div>
              ) : "Online payment is not configured for this property yet. Settle your bill at the front desk; every payment you make is receipted below."}
            </div>
          </GuestSection>

          <GuestSection title="Charges" description="Only posted, non-voided lines are shown.">
            {lines.length === 0 ? (
              <PublicEmptyState title="No charges yet" description="Charges posted by the property appear here." />
            ) : (
              <ul className="divide-y divide-black/5">
                {lines.map((line) => (
                  <li key={line.id} className="neo-public-row py-3">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                        {line.description ?? "Charge"}
                      </span>
                      <span className="block text-xs" style={{ color: brandFallback.steel }}>
                        {line.posting_date ? new Date(line.posting_date).toLocaleDateString() : "—"} · qty{" "}
                        {line.quantity ?? 1}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {money(line.net_amount, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </GuestSection>
        </>
      )}

      {user ? (
        <GuestSection title="Receipts" description="Payments the property has receipted to your account.">
          {payments.length === 0 ? (
            <PublicEmptyState title="No receipts yet" description="Receipts appear here as soon as a payment is recorded." />
          ) : (
            <ul className="space-y-2">
              {payments.map((p) => (
                <li key={p.id} className="neo-public-row rounded-xl border border-black/5 p-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <Receipt className="size-4" style={{ color: brandFallback.steel }} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                        <span data-public-id>{p.receipt_number ?? "Receipt"}</span>
                      </span>
                      <span className="block text-xs" style={{ color: brandFallback.steel }}>
                        {p.paid_at ? new Date(p.paid_at).toLocaleString() : "—"} · {p.method ?? ""}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                    {money(p.amount, p.currency ?? "KES")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </GuestSection>
      ) : null}

      <div className="mt-4 px-1 text-center text-xs" style={{ color: brandFallback.steel }}>
        <Link to="/guest/$hotelSlug/trips" params={{ hotelSlug }} className="underline">
          Back to my stay
        </Link>
      </div>
    </GuestScreen>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-black/5 p-3">
      <dt className="text-xs" style={{ color: brandFallback.steel }}>
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold" style={{ color: brandFallback.secondary }}>
        {value}
      </dd>
    </div>
  );
}
