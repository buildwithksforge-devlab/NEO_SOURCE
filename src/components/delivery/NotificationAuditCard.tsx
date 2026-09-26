import { useMemo, useState } from "react";
import { BellRing } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { shortDateTime, titleCase } from "@/lib/delivery";
import { useNotificationAudit } from "@/lib/delivery-data";

/**
 * Every notice sent to a rider, and every repeat attempt the database refused
 * to send twice. Dispatchers use this to prove a rider was told, and when.
 */
export function NotificationAuditCard({ branchId }: { branchId?: string | null }) {
  const audit = useNotificationAudit(branchId);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = audit.data ?? [];
    if (!q) return all;
    return all.filter((r) =>
      [r.rider_name, r.rider_code, r.order_number, r.event_type, r.actor_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [audit.data, search]);

  return (
    <SectionCard
      title="Rider notification audit"
      description="Assignment, reassignment and shift notices, with the exact key that keeps a repeat attempt from notifying a rider twice."
      actions={
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rider, order or event"
          className="w-56"
          aria-label="Search rider notifications"
        />
      }
    >
      <QueryState
        isLoading={audit.isLoading}
        error={audit.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={BellRing}
            title="No rider notifications yet"
            description="Notices appear here as soon as an order is assigned or a shift changes."
          />
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sent</TableHead>
                <TableHead>Rider</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Handover</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Idempotency key</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.idempotency_key ?? "key"}-${i}`}>
                  <TableCell className="whitespace-nowrap">{shortDateTime(r.created_at)}</TableCell>
                  <TableCell>
                    <p className="font-medium">{r.rider_name ?? "Rider"}</p>
                    <p className="text-xs text-muted-foreground">{r.rider_code ?? "—"}</p>
                  </TableCell>
                  <TableCell>{titleCase(String(r.event_type ?? "").replace(/^delivery\./, ""))}</TableCell>
                  <TableCell>{r.order_number ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.previous_rider_name ? `${r.previous_rider_name} → ${r.new_rider_name ?? "—"}` : "—"}
                  </TableCell>
                  <TableCell>{r.actor_name ?? "System"}</TableCell>
                  <TableCell>
                    {r.duplicate_suppressed ? (
                      <StatusPill tone="warning">Repeat suppressed</StatusPill>
                    ) : (
                      <StatusPill tone={r.notification_status === "read" ? "success" : "info"}>
                        {titleCase(r.notification_status ?? "sent")}
                      </StatusPill>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[18rem] truncate font-mono text-xs text-muted-foreground" title={r.idempotency_key ?? ""}>
                    {r.idempotency_key ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>
    </SectionCard>
  );
}
