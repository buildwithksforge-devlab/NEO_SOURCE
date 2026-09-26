/**
 * Supplier delivery reminders.
 *
 * Shows every reminder the system prepared for a purchase order still awaiting
 * delivery, who it went to and whether it actually left. Reminders are only
 * ever addressed to stored supplier or requester email addresses; a missing
 * address is shown as skipped rather than guessed.
 */
import { MailCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { sendProcurementDeliveryReminders } from "@/lib/automation.functions";
import { shortDateTime } from "@/lib/delivery";
import { titleCase } from "@/lib/procurement";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ReminderRow = {
  id: string;
  created_at: string;
  recipient_kind: string;
  recipient_email: string | null;
  status: string;
  reason: string | null;
  purchase_orders: { order_number: string | null } | null;
  communication_queue: { status: string | null; last_attempt_at: string | null; failure_message: string | null } | null;
};

function tone(status: string): "default" | "info" | "success" | "warning" | "destructive" {
  if (status === "sent") return "success";
  if (status === "failed") return "destructive";
  if (status === "skipped") return "warning";
  return "info";
}

export function DeliveryRemindersCard({ canSend }: { canSend: boolean }) {
  const qc = useQueryClient();
  const send = useServerFn(sendProcurementDeliveryReminders);

  const reminders = useQuery({
    queryKey: ["procurement", "delivery-reminders"],
    queryFn: async () => {
      const { data, error } = await db
        .from("procurement_delivery_reminders")
        .select(
          "id, created_at, recipient_kind, recipient_email, status, reason, purchase_orders(order_number), communication_queue(status, last_attempt_at, failure_message)",
        )
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as ReminderRow[];
    },
    refetchInterval: 60_000,
  });

  const run = useMutation({
    mutationFn: async () => await send({}),
    onSuccess: async (result: unknown) => {
      const prepared = (result as { prepared?: { queued?: number; skipped?: number } } | null)?.prepared;
      const queued = prepared?.queued ?? 0;
      const skipped = prepared?.skipped ?? 0;
      toast.success(
        queued === 0 && skipped === 0
          ? "No order is due a reminder right now."
          : `${queued} reminder(s) prepared, ${skipped} skipped for a missing address.`,
      );
      await qc.invalidateQueries({ queryKey: ["procurement", "delivery-reminders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = reminders.data ?? [];

  return (
    <SectionCard
      title="Supplier delivery reminders"
      description="Every two days an order still awaiting delivery reminds its supplier and the person who raised it. This log shows what was sent."
      icon={MailCheck}
      actions={
        canSend ? (
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Checking…" : "Send due reminders"}
          </Button>
        ) : null
      }
    >
      <QueryState
        isLoading={reminders.isLoading}
        error={reminders.error}
        isEmpty={rows.length === 0}
        empty="No reminder has been raised yet — no order is currently past its expected delivery date with outstanding quantities."
      >
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Raised</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const delivery = r.communication_queue?.status ?? r.status;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{shortDateTime(r.created_at)}</TableCell>
                    <TableCell className="font-medium">
                      {r.purchase_orders?.order_number ?? "—"}
                    </TableCell>
                    <TableCell>{titleCase(r.recipient_kind)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.recipient_email ?? (r.reason ?? "No stored address")}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={tone(delivery)}>{titleCase(delivery)}</StatusPill>
                      {r.communication_queue?.failure_message ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {r.communication_queue.failure_message}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {r.communication_queue?.last_attempt_at
                        ? shortDateTime(r.communication_queue.last_attempt_at)
                        : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableScroll>
      </QueryState>
    </SectionCard>
  );
}
