import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { useGuestBookingPosition, usePayGuestDeposit } from "@/lib/guest-booking";
import {
  BrandButton,
  PublicAppShell,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback } from "@/lib/public-apps";
import { money } from "@/lib/public-delivery";

export const Route = createFileRoute("/guest/$hotelSlug/reservations/$reservationReference")({
  head: () => ({
    meta: [
      { title: "Your reservation — NEØ Guest" },
      {
        name: "description",
        content: "The details, dates and balance of your booking with this hotel.",
      },
      { property: "og:title", content: "Your reservation — NEØ Guest" },
      {
        property: "og:description",
        content: "The details, dates and balance of your booking with this hotel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      // Personal to one guest: never a search result.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ReservationDetail,
});

type Row = Record<string, unknown>;

function ReservationDetail() {
  const ws = useWorkspace();
  const { hotelSlug, reservationReference } = Route.useParams();

  const reservation = useQuery({
    queryKey: ["guest", ws.organization_id, "reservation", reservationReference],
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as { from: (t: string) => any })
        .from("reservations")
        .select(
          "id, confirmation_number, status, arrival_date, departure_date, nights, adults, children, total_amount, balance, deposit_paid, special_requests, payment_status",
        )
        .eq("organization_id", ws.organization_id)
        .eq("confirmation_number", reservationReference)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Row | null) ?? null;
    },
  });

  return (
    <PublicAppShell homeTo={{ to: "/guest/$hotelSlug", params: { hotelSlug } }}>
      <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
        Reservation {reservationReference}
      </h1>

      {reservation.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : !reservation.data ? (
        <div className="mt-4">
          <PublicEmptyState
            title="Reservation not available"
            description="Sign in with the details used when booking, or contact the hotel to confirm this reference."
            action={
              <Link to="/guest/$hotelSlug" params={{ hotelSlug }}>
                <BrandButton>Back to my stay</BrandButton>
              </Link>
            }
          />
        </div>
      ) : (
        <section className="neo-rider-card mt-4 space-y-2 p-5 text-sm">
          <Detail label="Status" value={String(reservation.data["status"])} />
          <Detail label="Arrival" value={String(reservation.data["arrival_date"])} />
          <Detail label="Departure" value={String(reservation.data["departure_date"])} />
          <Detail label="Nights" value={String(reservation.data["nights"])} />
          <Detail
            label="Guests"
            value={`${String(reservation.data["adults"])} adult(s), ${String(reservation.data["children"])} child(ren)`}
          />
          <Detail label="Total" value={money(reservation.data["total_amount"])} />
          <Detail label="Deposit paid" value={money(reservation.data["deposit_paid"])} />
          <Detail label="Balance" value={money(reservation.data["balance"])} />
          {reservation.data["special_requests"] ? (
            <Detail label="Special requests" value={String(reservation.data["special_requests"])} />
          ) : null}
        </section>
      )}

      {reservation.data ? (
        <DepositPanel organizationId={ws.organization_id} reference={reservationReference} />
      ) : null}
    </PublicAppShell>
  );
}

function DepositPanel({ organizationId, reference }: { organizationId: string; reference: string }) {
  const position = useGuestBookingPosition(organizationId, reference);
  const pay = usePayGuestDeposit(organizationId, reference);
  const [phone, setPhone] = useState("");

  if (position.isLoading) return null;
  const p = position.data;
  if (!p?.ok || !(p.required ?? 0)) return null;

  const outstanding = p.outstanding ?? 0;

  return (
    <section className="neo-rider-card mt-4 space-y-3 p-5 text-sm">
      <h2 className="text-base font-semibold" style={{ color: brandFallback.secondary }}>
        Deposit
      </h2>
      <Detail label="Deposit required" value={money(p.required)} />
      <Detail label="Paid so far" value={money(p.paid)} />
      <Detail label="Still to pay" value={money(outstanding)} />

      {outstanding <= 0 ? (
        <p style={{ color: brandFallback.steel }}>Your deposit is settled in full. Thank you.</p>
      ) : p.can_pay_online ? (
        <div className="space-y-2">
          <label className="block" style={{ color: brandFallback.steel }} htmlFor="deposit-phone">
            Mobile number for the payment prompt
          </label>
          <Input
            id="deposit-phone"
            inputMode="tel"
            value={phone}
            placeholder="07XX XXX XXX"
            onChange={(e) => setPhone(e.target.value)}
          />
          <BrandButton
            disabled={pay.isPending || phone.replace(/\D/g, "").length < 9}
            onClick={() => {
              pay.mutate(
                { msisdn: phone },
                {
                  onSuccess: (r) =>
                    toast.success(
                      `Payment request sent for ${money(r.amount)} — approve the prompt on your phone.`,
                    ),
                  onError: (e: Error) => toast.error(e.message),
                },
              );
            }}
          >
            {pay.isPending ? "Sending request…" : `Pay ${money(outstanding)} by mobile money`}
          </BrandButton>
        </div>
      ) : (
        <p style={{ color: brandFallback.steel }}>
          Mobile payment is not available for this property yet — the deposit can be settled at the
          front desk on arrival.
        </p>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-black/5 pb-2 last:border-0">
      <span style={{ color: brandFallback.steel }}>{label}</span>
      <span className="font-medium" style={{ color: brandFallback.secondary }}>
        {value}
      </span>
    </div>
  );
}
