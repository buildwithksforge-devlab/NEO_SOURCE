import type { ReactNode } from "react";
import { History, Loader2 } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AllergyBanner, PrepTimer, TicketStatusBadge } from "@/components/kitchen/KitchenShared";
import { titleCase } from "@/lib/kitchen";
import {
  ticketActions,
  ticketRoutingException,
  ROUTING_EXCEPTION_MESSAGE,
  type KitchenTicket,
  type KitchenTicketItem,
} from "@/lib/kitchen-tickets";

/**
 * The single ticket presentation used by POS KDS and the Kitchen Live Queue.
 * Layout density differs per page; the data and the lifecycle actions do not —
 * both are derived from the canonical ticket contract.
 */
export function TicketCard({
  ticket,
  onTransition,
  onDelay,
  renderItemActions,
  footer,
  busy,
  pendingTo,
  selected,
  onSelectedChange,
  onOpenAudit,
  stationAuthority = true,
}: {
  ticket: KitchenTicket;
  onTransition: (to: string, needsReason: boolean) => void;
  onDelay: () => void;
  renderItemActions?: (item: KitchenTicketItem) => ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  /** The move currently being applied to THIS ticket, so the card can show it. */
  pendingTo?: string | null;
  selected?: boolean;
  onSelectedChange?: (next: boolean) => void;
  onOpenAudit?: () => void;
  /**
   * False when the viewer is watching someone else's station — a waiter follows
   * their own order through the kitchen but may not accept, start, finish or
   * cancel its production. Matches `neo_kitchen_assert_station_authority`.
   */
  stationAuthority?: boolean;
}) {
  const actions = ticketActions(ticket.status).filter(
    (a) => stationAuthority || a.to === "served" || a.to === "completed",
  );
  // While a move is in flight every action on the card is refused, so a second
  // tap cannot send the same ticket twice.
  const working = Boolean(busy) || Boolean(pendingTo);

  return (
    <Card className="surface-panel">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            {onSelectedChange ? (
              <Checkbox
                className="mt-1"
                checked={Boolean(selected)}
                onCheckedChange={(v) => onSelectedChange(v === true)}
                aria-label={`Select ticket ${ticket.ticket_number}`}
              />
            ) : null}
            <div>
            <CardTitle className="text-base">
              {ticket.table_code ?? ticket.guest_name ?? "Takeaway"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {ticket.ticket_number} · {ticket.station_name ?? "Routing not configured"} ·{" "}
              {titleCase(ticket.order_type ?? ticket.course ?? "")}
            </p>
            {ticket.order_number ? (
              <p className="text-xs text-muted-foreground">Order {ticket.order_number}</p>
            ) : null}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <TicketStatusBadge status={ticket.status} />
            {ticket.priority && ticket.priority !== "normal" ? (
              <StatusPill tone="warning">{titleCase(ticket.priority)}</StatusPill>
            ) : null}
          </div>
        </div>
        <div className="mt-2">
          <PrepTimer startedAt={ticket.received_at} target={ticket.target_minutes} />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {ticketRoutingException(ticket) ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs font-medium">
            {ROUTING_EXCEPTION_MESSAGE}
          </p>
        ) : null}

        <AllergyBanner allergy={ticket.allergy_alert} dietary={ticket.dietary_notes} />

        <ul className="space-y-2">
          {ticket.items.map((i) => (
            <li key={i.ticket_item_id} className="rounded-lg border border-border p-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {i.quantity} × {i.item_name ?? "Item"}
                  </p>
                  {i.special_instructions ? (
                    <p className="text-xs text-muted-foreground">{i.special_instructions}</p>
                  ) : null}
                  {(i.modifiers ?? []).map((m, idx) => (
                    <p key={idx} className="text-xs text-muted-foreground">
                      + {m.option_name}
                    </p>
                  ))}
                  {i.allergy_note ? (
                    <p className="text-xs font-medium text-destructive">Allergy: {i.allergy_note}</p>
                  ) : null}
                </div>
                <StatusPill tone="default">{titleCase(i.status)}</StatusPill>
              </div>
              {renderItemActions && stationAuthority ? (
                <div className="mt-2 flex flex-wrap gap-1">{renderItemActions(i)}</div>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {actions.map((a) => (
            <Button
              key={a.to}
              size="sm"
              variant={a.to === "cancelled" ? "outline" : "default"}
              disabled={working}
              aria-busy={pendingTo === a.to}
              onClick={() => onTransition(a.to, a.needsReason)}
            >
              {pendingTo === a.to ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              {pendingTo === a.to ? "Working…" : a.label}
            </Button>
          ))}
          {onOpenAudit ? (
            <Button size="sm" variant="ghost" onClick={onOpenAudit} aria-label="Open ticket audit trail">
              <History className="mr-1 size-4" /> Audit
            </Button>
          ) : null}
          {stationAuthority ? (
            <Button size="sm" variant="outline" disabled={working} onClick={onDelay}>
              Report delay{ticket.is_delayed ? ` (${Math.max(0, ticket.age_minutes - ticket.target_minutes)}m over)` : ""}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Watching only — {ticket.station_name ?? "this station"} runs this ticket.
            </p>
          )}
          {footer}
        </div>

        {ticket.delay_reason ? (
          <p className="text-xs text-muted-foreground">Delay noted: {ticket.delay_reason}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
