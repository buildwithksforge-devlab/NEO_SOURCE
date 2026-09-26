/**
 * Delivery verification — one board showing, for every recent delivery, whether
 * the customer's collection PIN was generated, sent, used or locked, plus the
 * manager actions (reveal with a reason, resend, replace, authorise handover).
 * The PIN itself is never listed here; it only appears inside the order's own
 * panel, briefly, after an audited reveal.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Send } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { DeliveryPinDialog } from "@/components/delivery/DeliveryPinPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { shortDateTime, titleCase } from "@/lib/delivery";
import {
  useDeliveryPinBoard,
  useRecordDeliveryCash,
  useResendDeliveryPin,
  useUnsettledCashDeliveries,
  type PinBoardRow,
} from "@/lib/delivery-data";

export const Route = createFileRoute("/_shell/delivery/verification")({
  head: () => ({
    meta: [
      { title: "Delivery Verification — NEØ Hospitality OS" },
      {
        name: "description",
        content: "Collection PIN status, send history and manager recovery for every delivery.",
      },
      { property: "og:title", content: "Delivery Verification — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Collection PIN status, send history and manager recovery for every delivery.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const STATE_LABEL: Record<string, string> = {
  none: "No PIN",
  generated: "Generated",
  sent: "Sent",
  failed: "Sending failed",
  verified: "Verified · expired",
  expired: "Expired",
  locked: "Locked",
  replaced: "Replaced",
};

const STATE_TONE: Record<string, string> = {
  none: "default",
  generated: "info",
  sent: "info",
  failed: "destructive",
  verified: "success",
  expired: "warning",
  locked: "destructive",
  replaced: "warning",
};

const CHANNEL_LABEL: Record<string, string> = {
  sms: "text message",
  email: "email",
  whatsapp: "WhatsApp",
};

function Page() {
  const { branchId } = useActivePropertyFilter();
  const board = useDeliveryPinBoard(branchId);
  const resend = useResendDeliveryPin();
  const [pinFor, setPinFor] = useState<PinBoardRow | null>(null);

  const rows = board.data ?? [];
  const lead: SummaryFigure = { id: "total", label: "Deliveries", value: String(rows.length) };
  const figures: SummaryFigure[] = useMemo(
    () => [
      {
        id: "awaiting",
        label: "Awaiting verification",
        value: String(rows.filter((r) => r.has_pin && !r.consumed_at).length),
      },
      {
        id: "failed",
        label: "Could not be sent",
        value: String(rows.filter((r) => r.state === "failed").length),
        tone: "destructive",
      },
      { id: "locked", label: "Locked", value: String(rows.filter((r) => r.locked).length), tone: "warning" },
    ],
    [rows],
  );

  return (
    <OpsGuard module="delivery" action="dispatch.view">
      <div className="space-y-4">
        <PageHeader
          title="Delivery verification"
          description="Whether each customer received their collection PIN, and what to do when they did not."
        />
        <SummaryStrip lead={lead} figures={figures} />

        <SectionCard title="Recent deliveries" description="Last 30 days at the selected property.">
          <QueryState
            isLoading={board.isLoading}
            error={board.error}
            isEmpty={rows.length === 0}
            empty={<EmptyState title="No deliveries yet" description="PIN activity appears here once orders are placed." />}
          >
            <ul className="divide-y divide-border/60">
              {rows.map((r) => (
                <li key={r.order_id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {r.order_number ?? "Delivery"}{" "}
                      <span className="text-muted-foreground">· {r.contact_name ?? "No name"}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {shortDateTime(r.created_at)} · {titleCase(r.order_status ?? "")}
                      {r.sent_at
                        ? ` · sent by ${CHANNEL_LABEL[r.channel ?? ""] ?? titleCase(r.channel ?? "")} ${shortDateTime(r.sent_at)}`
                        : " · not sent"}
                      {r.attempt_count > 0 ? ` · ${r.attempt_count} of ${r.max_attempts} wrong entries` : ""}
                    </p>
                  </div>
                  <StatusPill tone={(STATE_TONE[r.state] ?? "default") as never}>
                    {STATE_LABEL[r.state] ?? titleCase(r.state)}
                  </StatusPill>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!r.has_pin || Boolean(r.consumed_at) || resend.isPending}
                    onClick={() => resend.mutate({ orderId: r.order_id })}
                  >
                    <Send className="mr-1.5 size-3.5" />
                    Resend
                  </Button>
                  <Button size="sm" variant="outline" disabled={!r.has_pin} onClick={() => setPinFor(r)}>
                    <KeyRound className="mr-1.5 size-3.5" />
                    Manage
                  </Button>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>

        <CashToAccountFor />
      </div>

      <DeliveryPinDialog
        orderId={pinFor?.order_id ?? null}
        orderNumber={pinFor?.order_number ?? null}
        onOpenChange={(open) => !open && setPinFor(null)}
      />
    </OpsGuard>
  );
}

/**
 * Cash-on-delivery handovers where the rider did not enter the money. Without
 * this the order stays unpaid for ever and the cash is untracked, so the
 * manager accounts for it here and the order settles.
 */
function CashToAccountFor() {
  const unsettled = useUnsettledCashDeliveries();
  const record = useRecordDeliveryCash();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const rows = unsettled.data ?? [];

  return (
    <SectionCard
      title="Cash to account for"
      description="Deliveries handed over on cash terms where the money was never recorded."
    >
      <QueryState
        isLoading={unsettled.isLoading}
        error={unsettled.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="Nothing outstanding"
            description="Every cash delivery has its money recorded against a rider."
          />
        }
      >
        <ul className="divide-y divide-border/60">
          {rows.map((r) => {
            const id = String(r["id"]);
            const expected = Number(r["grand_total"] ?? 0);
            const typed = amounts[id] ?? "";
            const amount = Number(typed);
            const valid = typed !== "" && Number.isFinite(amount) && amount > 0;
            const short = valid && amount !== expected;
            const reason = reasons[id] ?? "";
            return (
              <li key={id} className="flex flex-wrap items-end gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {String(r["order_number"] ?? "Delivery")}{" "}
                    <span className="text-muted-foreground">
                      · expected {String(r["currency"] ?? "")} {expected.toFixed(2)}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Delivered {shortDateTime(String(r["delivered_at"] ?? ""))}
                    {r["contact_name"] ? ` · ${String(r["contact_name"])}` : ""}
                  </p>
                </div>
                <div className="w-32">
                  <Input
                    inputMode="decimal"
                    placeholder="Cash taken"
                    aria-label={`Cash collected for ${String(r["order_number"] ?? "delivery")}`}
                    value={typed}
                    onChange={(e) => setAmounts((s) => ({ ...s, [id]: e.target.value }))}
                  />
                </div>
                {short ? (
                  <div className="w-48">
                    <Input
                      placeholder="Reason for the difference"
                      aria-label="Reason for the difference"
                      value={reason}
                      onChange={(e) => setReasons((s) => ({ ...s, [id]: e.target.value }))}
                    />
                  </div>
                ) : null}
                <Button
                  size="sm"
                  disabled={!valid || record.isPending || (short && reason.trim() === "")}
                  onClick={() =>
                    record.mutate(
                      reason.trim()
                        ? { orderId: id, amount, reason: reason.trim() }
                        : { orderId: id, amount },
                      {
                        onSuccess: () => {
                          setAmounts((s) => ({ ...s, [id]: "" }));
                          setReasons((s) => ({ ...s, [id]: "" }));
                        },
                      },
                    )
                  }
                >
                  Record cash
                </Button>
              </li>
            );
          })}
        </ul>
      </QueryState>
    </SectionCard>
  );
}
