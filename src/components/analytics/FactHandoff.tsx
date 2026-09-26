/**
 * Operational → Finance reconciliation panel.
 *
 * Every figure comes from the same scoped fact layer the dashboards and
 * Finance read, so the same scope and period always produce the same numbers.
 * Operational value, forecast, invoiced value and recognised revenue are shown
 * as separate facts and are never added together. Loading and error states are
 * rendered as such — never as zero.
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/common/DataDisplay";
import { PermittedLink } from "@/components/common/PermittedLink";
import {
  factCurrency,
  factValue,
  factsMonetaryAuthorised,
  useFactSupplement,
  useFacts,
  useUnmatchedFacts,
  type FactScope,
} from "@/lib/facts";

const money = (v: number | null, currency: string) =>
  v === null
    ? "—"
    : `${currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(v)}`;

const nights = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

type Row = {
  label: string;
  note: string;
  value: string;
  drillTo: string;
  tone?: "info" | "warning";
};

export function FactHandoff({ scope }: { scope: FactScope }) {
  const facts = useFacts(scope);
  const extra = useFactSupplement(scope);
  const unmatched = useUnmatchedFacts(scope);
  const currency = factCurrency(facts.data);
  const moneyAllowed = factsMonetaryAuthorised(facts.data);

  if (facts.isLoading || extra.isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

  if (facts.error || extra.error) {
    return (
      <Card className="surface-panel">
        <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          Reconciliation could not be read for this scope. Nothing is shown as zero.
        </CardContent>
      </Card>
    );
  }

  const f = (path: string) => factValue(facts.data, path);

  const rows: Row[] = [
    {
      label: "Open point-of-sale value",
      note: "Draft, sent, ready and served orders still in service. Operational value only.",
      value: moneyAllowed ? money(f("operational.pos_open_value"), currency) : "Restricted",
      drillTo: "/pos/orders",
      tone: "info",
    },
    {
      label: "Finalised point-of-sale sales",
      note: "Closed, paid, settled or completed orders.",
      value: moneyAllowed ? money(f("operational.pos_finalised_sales"), currency) : "Restricted",
      drillTo: "/pos/orders",
    },
    {
      label: "Confirmed event forecast",
      note: "Contract value of confirmed bookings. Forecast, never revenue.",
      value: moneyAllowed ? money(f("events.confirmed_forecast"), currency) : "Restricted",
      drillTo: "/events/bookings",
      tone: "info",
    },
    {
      label: "Provisional event forecast",
      note: "Enquiries and provisional holds. Never accounting revenue.",
      value: moneyAllowed ? money(f("events.provisional_forecast"), currency) : "Restricted",
      drillTo: "/events/bookings",
      tone: "info",
    },
    {
      label: "Invoiced",
      note: "Issued invoices dated inside the period.",
      value: moneyAllowed ? money(f("events.invoiced"), currency) : "Restricted",
      drillTo: "/finance/invoices",
    },
    {
      label: "Recognised revenue",
      note: "Posted charges and finalised sales, less reversals and credit notes.",
      value: moneyAllowed ? money(f("accounting.net_recognised_revenue"), currency) : "Restricted",
      drillTo: "/finance/journals",
    },
    {
      label: "Collections",
      note: "Confirmed receipts inside the period.",
      value: moneyAllowed ? money(f("collections.total"), currency) : "Restricted",
      drillTo: "/finance/payments",
    },
    {
      label: "Outstanding receivables",
      note: "Invoice balances plus open folio balances.",
      value: moneyAllowed ? money(f("receivables.total"), currency) : "Restricted",
      drillTo: "/finance/receivables",
    },
    {
      label: "Outstanding payables",
      note: "Approved supplier invoices not yet paid.",
      value: moneyAllowed ? money(f("payables.total"), currency) : "Restricted",
      drillTo: "/finance/payables",
    },
    {
      label: "Sellable room nights",
      note: "Sellable rooms × nights, less out-of-order nights.",
      value: nights(f("rooms.available_room_nights")),
      drillTo: "/pms/rooms",
    },
    {
      label: "Occupied room nights",
      note: "Stays checked in, in house, checked out or departed.",
      value: nights(f("rooms.occupied_room_nights")),
      drillTo: "/pms/rooms",
    },
    {
      label: "Occupancy",
      note: "Occupied ÷ sellable room nights.",
      value: f("rooms.occupancy_rate") === null ? "—" : `${f("rooms.occupancy_rate")!.toFixed(1)}%`,
      drillTo: "/pms/rooms",
    },
    {
      label: "Blocked room inventory",
      note: "Rooms under maintenance, blocked or out of service.",
      value: String(extra.data?.rooms?.blocked_rooms ?? 0),
      drillTo: "/housekeeping",
      tone: "warning",
    },
    {
      label: "Unmatched eligible transactions",
      note: "Finalised operational records with no posted journal entry yet.",
      value: String(extra.data?.handoff?.unmatched_eligible ?? 0),
      drillTo: "/finance/posting",
      tone: "warning",
    },
  ];

  const lifecycle = extra.data?.pos_open_by_lifecycle ?? [];

  return (
    <div className="space-y-4">
      <Card className="surface-panel">
        <CardContent className="pt-5">
          <h3 className="text-sm font-semibold text-foreground">
            Operational value, forecast and recognised revenue
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Separate facts for the same scope and period. Dashboard, Analytics and Finance read
            these identical values.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">Fact</th>
                  <th className="py-2 pr-3">What qualifies</th>
                  <th className="py-2 pr-3 text-right">Value</th>
                  <th className="py-2 pr-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3 font-medium text-foreground">{r.label}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{r.note}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-foreground">{r.value}</td>
                    <td className="py-2 pr-3 text-right">
                      <PermittedLink
                        to={r.drillTo}
                        hideWhenDenied
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        Records <ArrowUpRight className="size-3" />
                      </PermittedLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="surface-panel">
        <CardContent className="pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Open point-of-sale by lifecycle</h3>
            <StatusPill tone="info">Not revenue</StatusPill>
          </div>
          {lifecycle.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No orders are open in this scope and period.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2">Lifecycle</th>
                  <th className="py-2 text-right">Orders</th>
                  <th className="py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {lifecycle.map((l) => (
                  <tr key={l.lifecycle} className="border-b border-border/60 last:border-0">
                    <td className="py-2 capitalize text-foreground">{l.lifecycle}</td>
                    <td className="py-2 text-right tabular-nums">{l.orders}</td>
                    <td className="py-2 text-right tabular-nums">
                      {moneyAllowed ? money(Number(l.value), currency) : "Restricted"}
                    </td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="py-2">Total open value</td>
                  <td className="py-2 text-right tabular-nums">
                    {lifecycle.reduce((s, l) => s + Number(l.orders), 0)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {moneyAllowed
                      ? money(
                          lifecycle.reduce((s, l) => s + Number(l.value), 0),
                          currency,
                        )
                      : "Restricted"}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="surface-panel">
        <CardContent className="pt-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Eligible transactions awaiting Finance
          </h3>
          {unmatched.isLoading ? (
            <Skeleton className="h-16 w-full rounded-lg" />
          ) : unmatched.error ? (
            <p className="text-sm text-destructive">Could not read unmatched transactions.</p>
          ) : (unmatched.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing eligible is waiting. Every finalised record in this period has reached
              Finance.
            </p>
          ) : (
            <ul className="space-y-2">
              {(unmatched.data ?? []).slice(0, 25).map((u) => (
                <li
                  key={`${u.source_module}-${u.source_id}`}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {u.reference || u.source_id} · {u.source_module}
                    </p>
                    <p className="text-xs text-muted-foreground">{u.reason}</p>
                  </div>
                  <PermittedLink
                    to={u.drill_to}
                    hideWhenDenied
                    className="text-xs text-primary hover:underline"
                  >
                    Open
                  </PermittedLink>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
