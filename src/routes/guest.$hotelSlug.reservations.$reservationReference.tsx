import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { useGuestBookingPosition, usePayGuestDeposit } from "@/lib/guest-booking";
import {
  BrandButton,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { supabase } from "@/integrations/supabase/client";
import { GuestPageIntro, GuestScreen } from "@/components/public/GuestScreen";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { useCustomerSession } from "@/lib/public-session";
import { useMyStays } from "@/lib/guest-app";
import { money, statusLabel } from "@/lib/public-delivery";

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
  const { user, loading } = useCustomerSession();
  const stays = useMyStays(ws.organization_id, ws.branch_id, user?.id);
  const linked = stays.data?.find((stay) => stay["confirmation_number"] === reservationReference);

  const reservation = useQuery({
    queryKey: ["guest", ws.organization_id, ws.branch_id, user?.id, "reservation", reservationReference],
    enabled: Boolean(user && ws.branch_id),
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as { from: (t: string) => any })
        .from("reservations")
        .select(
          "id, confirmation_number, status, arrival_date, departure_date, nights, adults, children, total_amount, balance, deposit_paid, special_requests, payment_status",
        )
        .eq("organization_id", ws.organization_id)
        .eq("branch_id", ws.branch_id)
        .eq("confirmation_number", reservationReference)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Row | null) ?? null;
    },
  });
  const booking = linked ? { ...linked, ...reservation.data } : reservation.data;
  const currency = String(booking?.["currency"] ?? ws.currency ?? "KES");
  const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value))
    : "—";

  return (
    <GuestScreen hotelSlug={hotelSlug} active="stay">
      <Link to="/guest/$hotelSlug/stay" params={{ hotelSlug }} className="mb-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold">
        <span aria-hidden>←</span> Back to My Stay
      </Link>
      <GuestPageIntro title="Your reservation" description={ws.hotel_name} image={ws.hero_url}>
        {booking ? <span className="neo-guest-outline-action">{statusLabel(booking["status"])}</span> : null}
      </GuestPageIntro>

      {loading || (!booking && (stays.isLoading || reservation.isLoading)) ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
        </div>
      ) : !user ? (
        <div className="mt-4"><GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to see this reservation" description="Return here after signing in." /></div>
      ) : !booking && (stays.isError || reservation.isError) ? (
        <div className="mt-4">
          <PublicEmptyState
            title="Reservation couldn’t load"
            description="Try loading your booking again."
            action={<BrandButton onClick={() => void (stays.isError ? stays.refetch() : reservation.refetch())}>Retry</BrandButton>}
          />
        </div>
      ) : !booking ? (
        <div className="mt-4">
          <PublicEmptyState
            title="Reservation not available"
            description="Sign in with the details used when booking, or contact the hotel to confirm this reference."
          />
        </div>
      ) : (
        <div className="neo-guest-reservation-grid">
          <section className="neo-guest-task-panel">
            <h2 className="text-lg font-semibold">Stay details</h2>
            <dl className="neo-guest-date-ticket text-sm">
              <div><dt className="text-[var(--guest-muted)]">Check-in</dt><dd className="font-semibold">{date(booking["arrival_date"])}</dd></div>
              <div><dt className="text-[var(--guest-muted)]">Check-out</dt><dd className="font-semibold">{date(booking["departure_date"])}</dd></div>
            </dl>
            <dl className="space-y-2 text-sm">
              <Detail label="Booking reference" value={reservationReference} />
              <Detail label="Nights" value={String(booking["nights"] ?? "—")} />
              {booking["room_number"] ? <Detail label="Room" value={String(booking["room_number"])} /> : null}
              {booking["adults"] != null ? <Detail label="Adults" value={String(booking["adults"])} /> : null}
              {Number(booking["children"]) > 0 ? <Detail label="Children" value={String(booking["children"])} /> : null}
              {booking["special_requests"] ? <Detail label="Special requests" value={String(booking["special_requests"])} /> : null}
            </dl>
          </section>
          <section className="neo-guest-task-panel">
            <h2 className="mb-3 text-lg font-semibold">Booking charges</h2>
            <dl className="space-y-2 text-sm">
              {booking["total_amount"] != null ? <Detail label="Booking total" value={money(booking["total_amount"], currency)} /> : null}
              {booking["balance"] != null ? <Detail label="Booking balance" value={money(booking["balance"], currency)} /> : null}
              {booking["payment_status"] ? <Detail label="Payment status" value={statusLabel(booking["payment_status"])} /> : null}
            </dl>
          </section>
          <DepositPanel organizationId={ws.organization_id} reference={reservationReference} />
        </div>
      )}
    </GuestScreen>
  );
}

function DepositPanel({ organizationId, reference }: { organizationId: string; reference: string }) {
  const position = useGuestBookingPosition(organizationId, reference);
  const pay = usePayGuestDeposit(organizationId, reference);
  const [phone, setPhone] = useState("");
  const [requested, setRequested] = useState(false);

  if (position.isLoading) return <p role="status" className="text-sm">Checking deposit requirements…</p>;
  if (position.isError) return <PublicEmptyState title="Deposit details couldn’t load"
    description="Refresh to check the current amount before paying."
    action={<BrandButton onClick={() => void position.refetch()}>Refresh deposit</BrandButton>} />;
  const p = position.data;
  if (!p?.ok || !(p.required ?? 0)) return null;

  const outstanding = p.outstanding ?? 0;
  const currency = p.currency ?? "KES";

  return (
    <section className="neo-guest-task-panel space-y-3 text-sm">
      <h2 className="text-base font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
        Deposit
      </h2>
      <dl className="space-y-2">
        <Detail label="Deposit required" value={money(p.required, currency)} />
        <Detail label="Paid so far" value={money(p.paid, currency)} />
        <Detail label="Still to pay" value={money(outstanding, currency)} />
      </dl>

      {outstanding <= 0 ? (
        <p style={{ color: "var(--guest-muted, #52627A)" }}>Your deposit is settled in full. Thank you.</p>
      ) : p.can_pay_online ? (
        <div className="space-y-2">
          {requested ? <p role="status">Payment request sent. Approve it on your phone, then refresh to check the balance.</p> : null}
          <label className="block" style={{ color: "var(--guest-muted, #52627A)" }} htmlFor="deposit-phone">
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
                  onSuccess: (r) => {
                    setRequested(true);
                    toast.success(`Payment request sent for ${money(r.amount, currency)}`);
                  },
                  onError: (e: Error) => toast.error(e.message),
                },
              );
            }}
          >
            {pay.isPending ? "Sending request…" : requested ? "Send another payment prompt" : `Pay ${money(outstanding, currency)} by mobile money`}
          </BrandButton>
          {requested ? <BrandButton variant="outline" onClick={() => void position.refetch()}>Refresh payment status</BrandButton> : null}
        </div>
      ) : (
        <p style={{ color: "var(--guest-muted, #52627A)" }}>
          Mobile payment is not available for this property yet — the deposit can be settled at the
          front desk on arrival.
        </p>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--guest-border)] pb-2 last:border-0">
      <dt className="shrink-0" style={{ color: "var(--guest-muted, #52627A)" }}>{label}</dt>
      <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]" style={{ color: "var(--guest-text, #07142D)" }}>
        {value}
      </dd>
    </div>
  );
}
