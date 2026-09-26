/**
 * Banqueting command centre.
 *
 * One operational picture for a single function: what the venue is, whether the
 * departments have declared themselves ready, who is on the floor, how much of
 * the setup is done, where the money stands and what is still unresolved.
 *
 * Every figure is reconciled against the canonical `event_bookings` row — the
 * console never invents a guest count, a total or a readiness state, and it
 * says so plainly when the booking has not been costed or staffed yet.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardList, Users, Wallet } from "lucide-react";

import { supabase as db } from "@/integrations/supabase/client";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { MoneyValue } from "@/components/common/MoneyValue";
import { cn } from "@/lib/utils";

export type BanquetBooking = {
  id: string;
  event_reference: string | null;
  event_name: string | null;
  event_date: string | null;
  status: string | null;
  billing_status: string | null;
  payment_status: string | null;
  expected_guests: number | null;
  guaranteed_guests: number | null;
  final_guests: number | null;
  total_amount: number | null;
  paid_amount: number | null;
  deposit_required: number | null;
  deposit_paid: number | null;
  venue_id: string | null;
  event_venues?: { name: string | null } | null;
};

export type DepartmentReadiness = {
  department: string;
  total: number;
  ready: number;
  blocked: number;
  at_risk: number;
};

export function useBanquetBooking(bookingId: string | null) {
  return useQuery({
    queryKey: ["sales-events", "command-centre", "booking", bookingId],
    enabled: Boolean(bookingId),
    queryFn: async () => {
      const { data, error } = await db
        .from("event_bookings")
        .select(
          "id,event_reference,event_name,event_date,status,billing_status,payment_status,expected_guests,guaranteed_guests,final_guests,total_amount,paid_amount,deposit_required,deposit_paid,venue_id,event_venues(name)",
        )
        .eq("id", bookingId as string)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as BanquetBooking | null;
    },
  });
}

export function useDepartmentReadiness(bookingId: string | null) {
  return useQuery({
    queryKey: ["sales-events", "command-centre", "readiness", bookingId],
    enabled: Boolean(bookingId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "events_department_readiness", {
        _booking: bookingId as string,
      } as never);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as DepartmentReadiness[];
    },
  });
}

/** Task board progress, derived only from the tasks that exist. */
export function taskProgress(tasks: readonly Record<string, unknown>[]) {
  const total = tasks.length;
  const done = tasks.filter((t) => ["ready", "completed"].includes(String(t["status"] ?? ""))).length;
  const blocked = tasks.filter((t) => String(t["status"] ?? "") === "blocked").length;
  return { total, done, blocked, percent: total ? Math.round((done / total) * 100) : null };
}

/** Money position straight from the booking. Nothing is estimated. */
export function billingPosition(booking: BanquetBooking | null) {
  if (!booking) return null;
  const total = Number(booking.total_amount ?? 0);
  const paid = Number(booking.paid_amount ?? 0);
  if (total <= 0 && paid <= 0) return { total: 0, paid: 0, balance: 0, costed: false };
  return { total, paid, balance: total - paid, costed: true };
}

function Fact({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: typeof Users;
  tone?: "warn" | "bad" | undefined;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-border bg-card p-4",
        tone === "bad" && "border-destructive/40 bg-destructive/5",
        tone === "warn" && "border-warning/40 bg-warning/5",
      )}
    >
      <p className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{label}</span>
      </p>
      <p className="neo-atomic mt-1 text-xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function BanquetingCommandCentre({
  bookingId,
  tasks,
  assignments,
  openIssues,
}: {
  bookingId: string;
  tasks: readonly Record<string, unknown>[];
  assignments: readonly Record<string, unknown>[];
  openIssues: readonly Record<string, unknown>[];
}) {
  const booking = useBanquetBooking(bookingId);
  const readiness = useDepartmentReadiness(bookingId);

  const row = booking.data ?? null;
  const progress = taskProgress(tasks);
  const money = billingPosition(row);
  const departments = readiness.data ?? [];
  const blockedDepartments = departments.filter((d) => Number(d.blocked ?? 0) > 0);
  const risks = openIssues.filter((i) => String(i["booking_id"] ?? "") === bookingId);
  const guests = row?.final_guests ?? row?.guaranteed_guests ?? row?.expected_guests ?? null;

  return (
    <SectionCard
      title="Command centre"
      description="Live position for this function, reconciled against the event booking record."
    >
      {booking.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the booking…</p>
      ) : booking.error ? (
        <p role="alert" className="text-sm text-destructive">
          The booking behind this console could not be loaded.
        </p>
      ) : !row ? (
        <p className="text-sm text-muted-foreground">
          This console is not reconciled to an event booking — the selected event no longer exists.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{row.event_name ?? row.event_reference ?? "Event"}</span>
            <StatusPill tone="default">{row.status ?? "status not set"}</StatusPill>
            <span className="text-muted-foreground">
              {row.event_date ?? "Date not set"} · {row.event_venues?.name ?? "Venue not assigned"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Fact
              label="Venue readiness"
              icon={CheckCircle2}
              tone={blockedDepartments.length ? "bad" : undefined}
              value={
                readiness.isLoading
                  ? "…"
                  : departments.length === 0
                    ? "Not declared"
                    : `${departments.filter((d) => Number(d.ready ?? 0) >= Number(d.total ?? 0) && Number(d.total ?? 0) > 0).length} / ${departments.length}`
              }
              hint={
                departments.length === 0
                  ? "No department has declared a requirement yet"
                  : blockedDepartments.length
                    ? `${blockedDepartments.length} department(s) blocked`
                    : "Departments reporting ready"
              }
            />
            <Fact
              label="Team on the floor"
              icon={Users}
              value={String(assignments.length)}
              hint={guests !== null ? `${guests} guest(s) on the booking` : "Guest count not set"}
            />
            <Fact
              label="Setup tasks"
              icon={ClipboardList}
              tone={progress.blocked ? "warn" : undefined}
              value={progress.total === 0 ? "None yet" : `${progress.done} / ${progress.total}`}
              hint={
                progress.total === 0
                  ? "Break the setup into tasks below"
                  : progress.blocked
                    ? `${progress.blocked} blocked`
                    : `${progress.percent}% complete`
              }
            />
            <Fact
              label="Billing position"
              icon={Wallet}
              tone={money && money.costed && money.balance > 0 ? "warn" : undefined}
              value={
                money && money.costed ? <MoneyValue value={money.balance} /> : "Not costed"
              }
              hint={
                money && money.costed ? (
                  <>
                    <MoneyValue value={money.paid} /> paid of <MoneyValue value={money.total} />
                  </>
                ) : (
                  "No charges raised on this booking yet"
                )
              }
            />
            <Fact
              label="Unresolved risks"
              icon={AlertTriangle}
              tone={risks.length ? "bad" : undefined}
              value={String(risks.length)}
              hint={risks.length ? "Raised on the floor, still open" : "Nothing outstanding"}
            />
          </div>

          {departments.length > 0 ? (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {departments.map((d) => (
                <li
                  key={d.department}
                  className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span className="truncate">{d.department}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {Number(d.ready ?? 0)}/{Number(d.total ?? 0)} ready
                    {Number(d.blocked ?? 0) > 0 ? ` · ${Number(d.blocked)} blocked` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Reconciled to booking {row.event_reference ?? row.id} — guests, status and money are read
            from that record, never re-keyed here.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
