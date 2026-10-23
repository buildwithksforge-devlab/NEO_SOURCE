import { guardedRpc } from "@/lib/rpc-guard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { parseAvailabilitySearch } from "@/lib/availability-search";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/StateSystem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import {
  BOOKING_SOURCES,
  GUARANTEE_METHODS,
  RESERVATION_TYPES,
  addDays,
  money,
  nightsBetween,
  titleCase,
  today,
} from "@/lib/pms";
import {
  useAvailability,
  useCustomers,
  useMealPlans,
  useRatePlans,
  useRoomTypes,
  useRooms,
} from "@/lib/pms-data";
import { useRateQuote } from "@/lib/rates-data";
import {
  RatePlanPicker,
  roomTypeForRoom,
  selectableRatePlans,
} from "@/components/pms/RatePlanPicker";
import { PmsGuard } from "@/components/pms/PmsShared";


export const Route = createFileRoute("/_shell/pms/reservations/new")({
  // Receives the exact search context the operator used on Availability.
  validateSearch: parseAvailabilitySearch,
  head: () => ({
    meta: [
      { title: "New Reservation — NEØ" },
      {
        name: "description",
        content: "Create a booking with live availability, rate selection and deposit rules.",
      },
      { property: "og:title", content: "New Reservation — NEØ" },
      {
        property: "og:description",
        content: "Create a booking with live availability, rate selection and deposit rules.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="reservations.create">
      <ReservationWizard />
    </PmsGuard>
  ),
});

const STEPS = ["Stay", "Guest", "Room & rate", "Payment", "Review"];

function ReservationWizard() {
  const { organizationId, profile, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The reservation belongs to the property currently selected in the global
  // selector — never the booking clerk's home branch.
  const { branchId: activeBranchId } = useActivePropertyFilter();
  const handoff = useSearch({ from: "/_shell/pms/reservations/new" });
  const [step, setStep] = useState(0);
  const reservationIntentKey = useRef(crypto.randomUUID());

  const [arrival, setArrival] = useState(handoff.arrival ?? today());
  const [departure, setDeparture] = useState(handoff.departure ?? addDays(today(), 1));
  const [adults, setAdults] = useState(handoff.adults ?? 1);
  const [children, setChildren] = useState(handoff.children ?? 0);
  const [infants, setInfants] = useState(0);
  const [reservationType, setReservationType] = useState<string>("individual");
  const [bookingSource, setBookingSource] = useState<string>("direct");

  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [newGuestName, setNewGuestName] = useState("");
  const [newGuestEmail, setNewGuestEmail] = useState("");
  const [newGuestPhone, setNewGuestPhone] = useState("");
  const [isVip, setIsVip] = useState(false);
  /** Email stays optional; it is only rejected when something was typed and it
   *  is not a valid address. */
  const emailInvalid =
    newGuestEmail.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newGuestEmail.trim());

  const [roomTypeId, setRoomTypeId] = useState<string>("");
  const [roomId, setRoomId] = useState<string>(handoff.roomId ?? "");
  const [ratePlanId, setRatePlanId] = useState<string>("");
  const [mealPlanId, setMealPlanId] = useState<string>("");
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideRate, setOverrideRate] = useState(0);
  const [overrideReason, setOverrideReason] = useState("");
  const [specialRequests, setSpecialRequests] = useState("");

  const [guarantee, setGuarantee] = useState<string>("none");
  const [depositMode, setDepositMode] = useState<"percentage" | "fixed">("percentage");
  const [depositValue, setDepositValue] = useState(0);
  const [status, setStatus] = useState("tentative");

  const nights = nightsBetween(arrival, departure);
  const roomTypes = useRoomTypes();
  const ratePlans = useRatePlans();
  const mealPlans = useMealPlans();
  const customers = useCustomers(customerSearch);
  const canOverrideRate = can("front-office", "rates", "manage");
  const quote = useRateQuote({
    ratePlanId: ratePlanId || null,
    arrival,
    departure,
    adults,
    children,
    enabled: step >= 2 && nights > 0,
  });
  const availability = useAvailability({
    branch: activeBranchId ?? profile?.branch_id ?? null,
    arrival,
    departure,
    roomType: roomTypeId || null,
    adults,
    children,
    enabled: step >= 2 && nights > 0,
  });
  // A room handed off from Availability resolves to its own room type so the
  // applicable rate plans are shown without weakening the availability check.
  const rooms = useRooms();
  const handoffRoomType = roomTypeForRoom(
    (rooms.data ?? []) as Array<{ id: string; room_type_id?: string | null }>,
    roomId,
  );
  useEffect(() => {
    if (roomTypeId || !handoffRoomType) return;
    setRoomTypeId(handoffRoomType);
  }, [handoffRoomType, roomTypeId]);

  /** Changing the room type clears every selection that no longer applies. */
  const changeRoomType = useCallback(
    (next: string) => {
      setRoomTypeId(next);
      setRatePlanId("");
      setMealPlanId("");
      setOverrideOn(false);
      setOverrideRate(0);
      setOverrideReason("");
      if (roomId && handoffRoomType !== next) setRoomId("");
    },
    [roomId, handoffRoomType],
  );




  const derivedRate = quote.data?.ok ? Number(quote.data.nightly_rate ?? 0) : 0;
  const nightlyRate = overrideOn && canOverrideRate ? overrideRate : derivedRate;
  const taxAmount = overrideOn && canOverrideRate ? 0 : Number(quote.data?.tax_amount ?? 0);
  const serviceCharge = overrideOn && canOverrideRate ? 0 : Number(quote.data?.service_charge ?? 0);
  const total = useMemo(
    () => Math.round((nightlyRate * nights + taxAmount + serviceCharge) * 100) / 100,
    [nightlyRate, nights, taxAmount, serviceCharge],
  );

  const depositRequired = useMemo(() => {
    const value = Math.max(0, Number(depositValue) || 0);
    const calculated = depositMode === "percentage"
      ? (total * value) / 100
      : value;

    return Math.round(Math.max(0, calculated) * 100) / 100;
  }, [depositMode, depositValue, total]);

  const balanceAfterRequiredDeposit =
    Math.round(Math.max(0, total - depositRequired) * 100) / 100;
  const create = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("No organisation context");
      if (!Number.isFinite(depositValue) || depositValue < 0) {
        throw new Error("Enter a valid deposit amount.");
      }
      if (depositMode === "percentage" && depositValue > 100) {
        throw new Error("Deposit percentage cannot exceed 100%.");
      }
      if (depositMode === "fixed" && depositValue > total) {
        throw new Error("Deposit cannot exceed the reservation total.");
      }
      if (nights < 1) throw new Error("Departure must be after arrival");
      if (!ratePlanId) throw new Error("Select a rate plan so the nightly rate can be derived");
      if (nightlyRate <= 0)
        throw new Error("The selected rate plan produced no price for these dates");
      if (overrideOn && (!canOverrideRate || overrideReason.trim().length < 4))
        throw new Error("An authorised reason is required for a rate override");
      const branchId = activeBranchId ?? profile?.branch_id;
      if (!branchId)
        throw new Error(
          "Select a property in the property selector before creating a reservation.",
        );

      let guestId = customerId;
      if (!guestId) {
        if (!newGuestName.trim()) throw new Error("A guest name is required");
        // Resolve against existing guest profiles first so repeat guests are never duplicated.
        const { data: resolved, error: customerError } = await guardedRpc(supabase, 
          "neo_customer_resolve",
          {
            _org: organizationId,
            _branch: branchId,
            _full_name: newGuestName.trim(),
            ...(newGuestPhone.trim() ? { _phone: newGuestPhone.trim() } : {}),
            ...(newGuestEmail.trim() ? { _email: newGuestEmail.trim() } : {}),
          },
        );
        if (customerError) throw customerError;
        guestId = resolved as string;
        await supabase
          .from("customers")
          .update({ customer_type: "individual-guest", is_vip: isVip, source: bookingSource })
          .eq("id", guestId);
      }

      const { data, error } = await guardedRpc(supabase, "neo_reservation_create", {
        _payload: {
          branch_id: branchId,
          customer_id: guestId as string,
          booking_source: bookingSource,
          reservation_type: reservationType,
          arrival_date: arrival,
          departure_date: departure,
          nights,
          adults,
          children,
          infants,
          room_type_id: roomTypeId || null,
          room_id: roomId || null,
          rate_plan_id: ratePlanId || null,
          meal_plan_id: mealPlanId || null,
          nightly_rate: nightlyRate,
          tax_amount: taxAmount,
          total_amount: total,
          rate_source: overrideOn && canOverrideRate ? "override" : "rate-plan",
          rate_override_reason: overrideOn && canOverrideRate ? overrideReason.trim() : null,
          rate_quoted_amount: derivedRate,
          deposit_basis: depositMode,
          deposit_value: depositValue,
          deposit_required: depositRequired,
          balance: total,
          guarantee_method: guarantee,
          special_requests: specialRequests,
          is_vip: isVip,
          status,
        },
        _idempotency_key: reservationIntentKey.current,
      });
      if (error) throw error;
      const result = data as { ok?: boolean; id?: string; confirmation_number?: string } | null;
      if (!result?.ok || !result.id || !result.confirmation_number) {
        throw new Error("The reservation was not persisted.");
      }
      return { id: result.id, confirmation_number: result.confirmation_number };
    },
    onSuccess: (data) => {
      toast.success(`Reservation ${data.confirmation_number} created`);
      // Refresh every surface that lists the new booking before we navigate.
      for (const key of ["reservations", "pms", "arrivals", "availability", "facts"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      void navigate({ to: "/pms/reservations/$id", params: { id: data.id } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canAdvance = [
    nights > 0,
    (Boolean(customerId) || newGuestName.trim().length > 1) && !emailInvalid,
    Boolean(roomTypeId) &&
      Boolean(ratePlanId) &&
      nightlyRate > 0 &&
      (!overrideOn || overrideReason.trim().length > 3),
    true,
    true,
  ][step];

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="New reservation"
        description="Availability is checked against real rooms, existing stays, blocks and holds before the booking is written."
      />

      <ol className="mb-6 flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setStep(i)}
              className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm transition-colors ${
                i === step
                  ? "border-primary/40 bg-chip-selected font-semibold text-chip-selected-foreground shadow-[var(--elevation-1)]"
                  : i < step
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-border text-muted-foreground"
              }`}
            >
              {i < step ? <Check className="size-3.5" /> : <span className="text-xs">{i + 1}</span>}
              {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <SectionCard title={STEPS[step] ?? ""} description="">
          {step === 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Stay dates</Label>
                <NeoDateRangePicker
                  from={arrival}
                  to={departure}
                  onChange={({ from, to }) => {
                    setArrival(from);
                    setDeparture(to);
                  }}
                  fromLabel="Arrival"
                  toLabel="Departure"
                  showNights
                />
              </div>
              <div className="space-y-2">
                <Label>Adults</Label>
                <Input
                  type="number"
                  min={1}
                  value={adults}
                  onChange={(e) => setAdults(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Children</Label>
                <Input
                  type="number"
                  min={0}
                  value={children}
                  onChange={(e) => setChildren(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Infants</Label>
                <Input
                  type="number"
                  min={0}
                  value={infants}
                  onChange={(e) => setInfants(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Reservation type</Label>
                <Select value={reservationType} onValueChange={setReservationType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESERVATION_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {titleCase(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Booking source</Label>
                <Select value={bookingSource} onValueChange={setBookingSource}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BOOKING_SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {titleCase(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {nights < 1 ? (
                <p className="sm:col-span-2 text-sm text-destructive">
                  Departure must be at least one night after arrival.
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="guest-search">Search existing guests</Label>
                <Input
                  id="guest-search"
                  name="guest-search"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Name, email, phone or customer number"
                />
                {customerSearch.trim().length >= 2 ? (
                  <div className="max-h-52 overflow-y-auto rounded-lg border border-border/70">
                    {(customers.data ?? []).length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground">
                        No matching guest — capture the details below to create a new profile.
                      </p>
                    ) : (
                      (customers.data ?? []).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setCustomerId(c.id);
                            setCustomerName(c.full_name);
                            setIsVip(Boolean(c.is_vip));
                          }}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted ${
                            customerId === c.id ? "bg-primary-soft" : ""
                          }`}
                        >
                          <span>
                            <span className="font-medium">{c.full_name}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {c.email || c.phone || c.customer_number}
                            </span>
                          </span>
                          {customerId === c.id ? <Check className="size-4 text-primary" /> : null}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              {customerId ? (
                <div className="flex items-center justify-between rounded-lg border border-border/70 p-3">
                  <p className="text-sm">
                    Booking for <span className="font-semibold">{customerName}</span>
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => setCustomerId(null)}>
                    Clear
                  </Button>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2 sm:col-span-3">
                    <Label htmlFor="new-guest-name">New guest full name</Label>
                    <Input
                      id="new-guest-name"
                      name="new-guest-name"
                      value={newGuestName}
                      onChange={(e) => setNewGuestName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-guest-email">Email (optional)</Label>
                    {/* A plain text field with an explicit pattern: the browser
                        email widget and password managers must never rewrite or
                        clear what the agent typed. Validation is ours. */}
                    <Input
                      id="new-guest-email"
                      name="new-guest-email"
                      type="text"
                      inputMode="email"
                      autoComplete="off"
                      spellCheck={false}
                      value={newGuestEmail}
                      onChange={(e) => setNewGuestEmail(e.target.value)}
                      aria-invalid={emailInvalid || undefined}
                      aria-describedby="new-guest-email-hint"
                    />
                    <p
                      id="new-guest-email-hint"
                      className={`text-xs ${emailInvalid ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {emailInvalid
                        ? "Enter a valid email address, or leave it blank."
                        : "Optional — used for confirmations and the folio statement."}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-guest-phone">Phone</Label>
                    <Input
                      id="new-guest-phone"
                      name="new-guest-phone"
                      value={newGuestPhone}
                      onChange={(e) => setNewGuestPhone(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border border-border/70 p-3">
                <div>
                  <p className="text-sm font-medium">VIP handling</p>
                  <p className="text-xs text-muted-foreground">
                    Flags the arrival for management attention.
                  </p>
                </div>
                <Switch checked={isVip} onCheckedChange={setIsVip} />
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Room type</Label>
                  <Select value={roomTypeId} onValueChange={changeRoomType}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          (roomTypes.data ?? []).length
                            ? "Select a room type"
                            : "No room types configured"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(roomTypes.data ?? []).map((rt) => (
                        <SelectItem key={rt.id} value={rt.id}>
                          {rt.name} · sleeps {rt.max_occupancy}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label id="rate-plan-label">Rate plan</Label>
                  {ratePlans.isLoading ? (
                    <LoadingState variant="rows" rows={2} />
                  ) : ratePlans.error ? (
                    <ErrorState
                      inline
                      error={ratePlans.error}
                      title="Rate plans could not be loaded"
                      onRetry={() => void ratePlans.refetch()}
                    />
                  ) : (
                    <RatePlanPicker
                      plans={(ratePlans.data ?? []) as never}
                      roomTypeId={roomTypeId || null}
                      value={ratePlanId}
                      onSelect={(planId) => {
                        setRatePlanId(planId);
                        setOverrideOn(false);
                        const plan = selectableRatePlans(
                          (ratePlans.data ?? []) as never,
                          roomTypeId || null,
                        ).find((p) => p.id === planId);
                        setMealPlanId(plan?.meal_plan_id ?? "");
                      }}
                    />
                  )}
                </div>



                <div className="space-y-2">
                  <Label>Meal plan</Label>
                  <Select value={mealPlanId} onValueChange={setMealPlanId}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          (mealPlans.data ?? []).length
                            ? "Select a meal plan"
                            : "No meal plans configured"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(mealPlans.data ?? []).map((mp) => (
                        <SelectItem key={mp.id} value={mp.id}>
                          {mp.code} — {mp.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Nightly rate</Label>
                  {!ratePlanId ? (
                    <p className="text-sm text-muted-foreground">
                      Select a rate plan — the nightly rate is derived, never typed.
                    </p>
                  ) : quote.isLoading ? (
                    <LoadingState variant="rows" rows={1} />
                  ) : quote.error ? (
                    <ErrorState
                      inline
                      error={quote.error}
                      title="Rate could not be calculated"
                      onRetry={() => void quote.refetch()}
                    />
                  ) : quote.data && !quote.data.ok ? (
                    <p className="text-sm text-destructive">{quote.data.reason}</p>
                  ) : (
                    <div className="rounded-lg border border-border p-3 text-sm">
                      <div className="flex justify-between font-medium">
                        <span>{money(derivedRate, quote.data?.currency)}</span>
                        <span className="text-muted-foreground">per night</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {nights} night(s) · service {money(serviceCharge)} · tax {money(taxAmount)}{" "}
                        · total {money(total)}
                      </p>
                      {(quote.data?.restrictions ?? []).map((r) => (
                        <p key={r} className="mt-1 text-xs text-on-tint-warning">
                          {r}
                        </p>
                      ))}
                    </div>
                  )}
                  {canOverrideRate && ratePlanId ? (
                    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">Authorised rate override</Label>
                        <Switch
                          checked={overrideOn}
                          onCheckedChange={(v) => {
                            setOverrideOn(v);
                            if (v) setOverrideRate(derivedRate);
                          }}
                        />
                      </div>
                      {overrideOn ? (
                        <>
                          <Input
                            type="number"
                            min={0}
                            value={overrideRate}
                            onChange={(e) => setOverrideRate(Number(e.target.value))}
                          />
                          <Input
                            placeholder="Reason for the override (required, audited)"
                            value={overrideReason}
                            onChange={(e) => setOverrideReason(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            Plan price {money(derivedRate)} will be preserved on the reservation
                            record.
                          </p>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Assign a specific room (optional)</Label>
                {availability.isLoading ? (
                  <LoadingState variant="rows" rows={1} />
                ) : (availability.data ?? []).length === 0 ? (
                  <EmptyState
                    inline
                    title="No room is free for these dates"
                    description="The booking can still be taken and assigned later, or added to the waitlist."
                  />
                ) : (
                  <Select value={roomId} onValueChange={setRoomId}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={`${(availability.data ?? []).length} room(s) available`}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(availability.data ?? []).map((r) => (
                        <SelectItem key={r.room_id} value={r.room_id}>
                          {r.room_number} · {r.room_type_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-2">
                <Label>Special requests</Label>
                <Textarea
                  value={specialRequests}
                  onChange={(e) => setSpecialRequests(e.target.value)}
                  rows={3}
                />
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Guarantee method</Label>
                <Select value={guarantee} onValueChange={setGuarantee}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GUARANTEE_METHODS.map((g) => (
                      <SelectItem key={g} value={g}>
                        {titleCase(g)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3">
                <Label>Deposit type</Label>

                <Select
                  value={depositMode}
                  onValueChange={(value) =>
                    setDepositMode(value as "percentage" | "fixed")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage (%)</SelectItem>
                    <SelectItem value="fixed">Fixed amount (KES)</SelectItem>
                  </SelectContent>
                </Select>

                <Label>
                  {depositMode === "percentage"
                    ? "Deposit percentage"
                    : "Deposit amount (KES)"}
                </Label>

                <Input
                  type="number"
                  min={0}
                  max={depositMode === "percentage" ? 100 : total}
                  step="0.01"
                  value={depositValue}
                  onChange={(e) => setDepositValue(Number(e.target.value))}
                />

                <p className="text-sm font-medium">
                  Required deposit: {money(depositRequired)}
                </p>

                <p className="text-xs text-muted-foreground">
                  Balance after receiving the required deposit:{" "}
                  {money(balanceAfterRequiredDeposit)}
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Reservation status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["enquiry", "tentative", "pending-deposit", "confirmed", "guaranteed"].map(
                      (s) => (
                        <SelectItem key={s} value={s}>
                          {titleCase(s)}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Deposits are recorded against the folio after check-in, or as a pre-arrival
                  payment from the folio screen.
                </p>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail label="Guest" value={customerId ? customerName : newGuestName || "—"} />
              <Detail label="Stay" value={`${arrival} → ${departure} (${nights} night(s))`} />
              <Detail
                label="Party"
                value={`${adults} adult(s), ${children} child(ren), ${infants} infant(s)`}
              />
              <Detail
                label="Room type"
                value={(roomTypes.data ?? []).find((r) => r.id === roomTypeId)?.name ?? "—"}
              />
              <Detail
                label="Room"
                value={
                  (availability.data ?? []).find((r) => r.room_id === roomId)?.room_number ??
                  "Assign later"
                }
              />
              <Detail label="Rate" value={`${money(nightlyRate)} per night`} />
              <Detail label="Total" value={money(total)} />
              <Detail label="Deposit" value={money(depositRequired)} />
              <Detail label="Status" value={titleCase(status)} />
              <Detail label="Source" value={titleCase(bookingSource)} />
            </dl>
          ) : null}

          <div className="mt-6 flex items-center justify-between">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
              <ChevronLeft className="mr-1 size-4" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button disabled={!canAdvance} onClick={() => setStep((s) => s + 1)}>
                Continue <ChevronRight className="ml-1 size-4" />
              </Button>
            ) : (
              <Button
                disabled={
                  create.isPending ||
                  !ratePlanId ||
                  nightlyRate <= 0 ||
                  (overrideOn && overrideReason.trim().length < 4)
                }
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create reservation"}
              </Button>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Booking summary" description="Updates as you complete each step.">
          <dl className="space-y-3 text-sm">
            <Detail label="Nights" value={String(nights)} />
            <Detail label="Nightly rate" value={money(nightlyRate)} />
            <Detail label="Accommodation total" value={money(total)} />
            <Detail label="Deposit required" value={money(depositRequired)} />
            <Detail
              label="Balance after required deposit"
              value={money(balanceAfterRequiredDeposit)}
            />
          </dl>
          {isVip ? <Badge className="mt-4">VIP arrival</Badge> : null}
        </SectionCard>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}
