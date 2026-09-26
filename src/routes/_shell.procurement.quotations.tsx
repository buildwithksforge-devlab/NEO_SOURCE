import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { FileSpreadsheet, Star } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useProviderConnections } from "@/lib/automation";
import { money } from "@/lib/procurement";
import { usePurchaseRequests, useSuppliers } from "@/lib/inventory-data";

import {
  num,
  str,
  RFQ_DISPATCH_STATES,
  useCreateRfq,
  useRecordQuotation,
  useRecordRfqDispatch,
  useRfqs,
  useSelectQuotation,
  useSupplierQuotations,
  type ProcRow,
  type RfqDispatchState,
} from "@/lib/procurement-department";

export const Route = createFileRoute("/_shell/procurement/quotations")({
  head: () => ({
    meta: [
      { title: "Supplier Quotations — NEØ" },
      {
        name: "description",
        content:
          "Collect at least three supplier quotations per request and record why the winning supplier was chosen.",
      },
      { property: "og:title", content: "Supplier Quotations — NEØ" },
      {
        property: "og:description",
        content:
          "Side-by-side quotation comparison with a recorded selection reason for every award.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/procurement/quotations">
      <QuotationsPage />
    </OpsGuard>
  ),
});

function QuotationsPage() {
  const { can } = useAuth();
  const mayManage = can("procurement", "quotations.manage") || can("procurement", "orders.create");

  const requests = usePurchaseRequests();
  const suppliers = useSuppliers();

  const [requestId, setRequestId] = useState<string>("");
  const quotations = useSupplierQuotations(requestId || null);
  const recordQuote = useRecordQuotation();
  const selectQuote = useSelectQuotation();

  const [supplierId, setSupplierId] = useState("");
  const [amount, setAmount] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  const rows = (quotations.data ?? []) as ProcRow[];
  const cheapest = useMemo(() => {
    if (rows.length === 0) return null;
    return rows.reduce<ProcRow>(
      (best, row) => (num(row["total_amount"]) < num(best["total_amount"]) ? row : best),
      rows[0] as ProcRow,
    );
  }, [rows]);

  // Three comparable quotations is the policy. A single-source award is still
  // possible, but only as a deliberate, recorded exception.
  const enoughQuotes = rows.length >= 3;
  const [singleSource, setSingleSource] = useState(false);
  const mayRecommend = enoughQuotes || singleSource;

  const selectedRequest = useMemo(
    () =>
      ((requests.data ?? []) as ProcRow[]).find((r) => String(r["id"]) === requestId) ?? null,
    [requests.data, requestId],
  );
  const requestStatus = str(selectedRequest?.["status"], "");
  const requestLines = (selectedRequest?.["purchase_request_lines"] ?? []) as ProcRow[];
  // A cancelled, rejected or still-draft request is not a sourcing instruction.
  const sourceable = !["draft", "rejected", "cancelled"].includes(requestStatus);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Procurement"
        title="Supplier quotations"
        description="Compare suppliers on price, terms and delivery record. The cheapest quote is not automatically the right one — the reason for the award is recorded."
      />

      <SectionCard
        title="Choose a request"
        description="Quotations are compared against the request being sourced, and its lines are shown here so a quote is never entered blind."
      >
        <select
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm md:max-w-xl"
          value={requestId}
          onChange={(e) => setRequestId(e.target.value)}
        >
          <option value="">All recent quotations</option>
          {((requests.data ?? []) as ProcRow[]).map((r) => (
            <option key={String(r["id"])} value={String(r["id"])}>
              {str(r["request_number"] ?? r["reference"])} —{" "}
              {str(r["title"] ?? r["notes"], "purchase request")}
            </option>
          ))}
        </select>

        {selectedRequest ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusPill tone={requestStatus === "approved" ? "success" : "info"}>
                {str(requestStatus, "unknown").replace(/_/g, " ")}
              </StatusPill>
              <span className="text-muted-foreground">
                {requestLines.length} line{requestLines.length === 1 ? "" : "s"} requested
              </span>
            </div>

            {requestLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This request has no lines recorded, so there is nothing to quote against. Ask Stores
                to add the item and quantity before sourcing it.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Estimated unit price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requestLines.map((l) => {
                    const item = l["stock_items"] as { name?: string; sku?: string } | null;
                    return (
                      <TableRow key={String(l["id"])}>
                        <TableCell>
                          {item?.name ?? str(l["description"], "Item")}
                          {item?.sku ? (
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {`· ${item.sku}`}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {`${num(l["quantity"])} ${str(l["unit"], "")}`.trim()}
                        </TableCell>

                        <TableCell className="text-right tabular-nums">
                          {num(l["estimated_unit_price"]) > 0
                            ? money(num(l["estimated_unit_price"]))
                            : "Not priced"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            {!sourceable ? (
              <p className="text-sm text-destructive">
                This request is {requestStatus.replace(/_/g, " ")}, so it cannot be sourced. Sourcing
                is available once Stores has submitted it.
              </p>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      {requestId && sourceable ? <RfqPanel requestId={requestId} mayManage={mayManage} /> : null}


      {mayManage && requestId && sourceable ? (
        <SectionCard
          title="Record a quotation"
          description="Enter each supplier's quoted total as it arrives."
        >
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="q-supplier">Supplier</Label>
              <select
                id="q-supplier"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Select supplier…</option>
                {((suppliers.data ?? []) as ProcRow[]).map((s) => (
                  <option key={String(s["id"])} value={String(s["id"])}>
                    {str(s["name"])}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-amount">Quoted total</Label>
              <Input
                id="q-amount"
                type="number"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-valid">Valid until</Label>
              <NeoDatePicker id="q-valid" value={validUntil} onChange={setValidUntil} />
            </div>
            <div className="space-y-1.5 md:col-span-3">
              <Label htmlFor="q-notes">Terms and notes</Label>
              <Textarea
                id="q-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Delivery lead time, payment terms, warranty"
              />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={!supplierId || !amount || recordQuote.isPending}
                onClick={() =>
                  recordQuote.mutate(
                    { requestId, supplierId, totalAmount: Number(amount), validUntil, notes },
                    {
                      onSuccess: () => {
                        setSupplierId("");
                        setAmount("");
                        setNotes("");
                      },
                    },
                  )
                }
              >
                Record quotation
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Comparison"
        description={
          requestId
            ? enoughQuotes
              ? "Three or more quotations collected — this request is ready for award."
              : `Only ${rows.length} quotation${rows.length === 1 ? "" : "s"} collected. Policy expects at least three before awarding.`
            : "Recent quotations across requests."
        }
      >
        <QueryState
          isLoading={quotations.isLoading}
          error={quotations.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No quotations recorded"
              description="Record each supplier's quote to compare price, terms and delivery reliability side by side."
              icon={FileSpreadsheet}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Quotation</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Terms</TableHead>
                  <TableHead>Delivery record</TableHead>
                  <TableHead>Valid until</TableHead>
                  <TableHead className="text-right">Award</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const supplier = (row["suppliers"] ?? {}) as ProcRow;
                  const onTime = num(supplier["on_time_deliveries"]);
                  const late = num(supplier["late_deliveries"]);
                  const total = onTime + late;
                  const selected = Boolean(row["selected"]);
                  const isCheapest =
                    Boolean(cheapest) && String(cheapest?.["id"]) === String(row["id"]);
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-medium">
                        {str(supplier["name"])}
                        {isCheapest ? (
                          <span className="ml-2 align-middle">
                            <StatusPill tone="info">Lowest price</StatusPill>
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {str(row["quotation_number"])}
                      </TableCell>
                      <TableCell>{money(num(row["total_amount"]))}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {str(supplier["payment_terms"] ?? row["notes"])}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {total === 0
                          ? "No history"
                          : `${Math.round((onTime / total) * 100)}% on time (${total} deliveries)`}
                      </TableCell>
                      <TableCell>{str(row["valid_until"])}</TableCell>
                      <TableCell className="text-right">
                        {selected ? (
                          <StatusPill tone="success">
                            <Star className="mr-1 inline size-3" />
                            Recommended
                          </StatusPill>
                        ) : mayManage ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={selectQuote.isPending || !reason.trim() || !mayRecommend}
                            onClick={() =>
                              selectQuote.mutate({
                                quotationId: String(row["id"]),
                                requestId:
                                  requestId ||
                                  (row["request_id"] ? String(row["request_id"]) : null),
                                reason: singleSource
                                  ? `Single-source award (fewer than three quotations): ${reason}`
                                  : reason,
                              })
                            }
                          >
                            Recommend
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {mayManage ? (
            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="q-reason">Selection reason (required before recommending)</Label>
                <Textarea
                  id="q-reason"
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why this supplier — price, quality, lead time, past reliability"
                />
              </div>

              {!enoughQuotes ? (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 rounded border-border"
                    checked={singleSource}
                    onChange={(e) => setSingleSource(e.target.checked)}
                  />
                  <span className="text-muted-foreground">
                    Award with fewer than three quotations. This is a single-source exception and is
                    recorded as one against the award.
                  </span>
                </label>
              ) : null}

              {!mayRecommend ? (
                <p className="text-sm text-muted-foreground">
                  Recommending is held until three quotations are collected, or until the
                  single-source exception above is accepted.
                </p>
              ) : null}
            </div>
          ) : null}
        </QueryState>
      </SectionCard>
    </div>
  );
}

/**
 * Request for quotation.
 *
 * Suppliers hold no accounts in NEØ, so an invitation is only ever "prepared"
 * until a person despatches it. Nothing here claims a message was sent.
 */
/** Channels an RFQ invitation can actually travel on. */
const RFQ_CHANNELS = ["email", "whatsapp"];

function RfqPanel({ requestId, mayManage }: { requestId: string; mayManage: boolean }) {
  const suppliers = useSuppliers();
  const rfqs = useRfqs(requestId);
  const createRfq = useCreateRfq();
  const recordDispatch = useRecordRfqDispatch();
  const providers = useProviderConnections();
  const [invited, setInvited] = useState<string[]>([]);
  const [closesAt, setClosesAt] = useState("");

  const toggle = (id: string) =>
    setInvited((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));

  const rows = (rfqs.data ?? []) as ProcRow[];
  // Provider awareness reads the existing communications provider registry —
  // there is no second provider table and no sending engine here. An RFQ can
  // only travel by email or WhatsApp, so only those channels count as ready.
  const ready = ((providers.data ?? []) as ProcRow[]).filter(
    (p) =>
      RFQ_CHANNELS.includes(String(p["channel"] ?? "")) &&
      Boolean(p["enabled"]) &&
      String(p["status"] ?? "") === "connected",
  );
  const readyChannels = Array.from(new Set(ready.map((p) => String(p["channel"]))));
  const noProvider = !providers.isLoading && readyChannels.length === 0;

  return (
    <SectionCard
      title="Requests for quotation"
      description="Invite suppliers to quote. NEØ prepares the invitation and records how it was actually sent — it never claims to have contacted a supplier on its own."

    >
      {noProvider ? (
        <div
          data-testid="rfq-no-provider"
          className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          <span className="font-medium text-foreground">Provider not configured</span> —{" "}
          <span className="font-medium text-foreground">prepared for manual sending</span>. No email
          or WhatsApp provider is connected for this workspace, so NEØ cannot despatch this RFQ.
          Download the invitation, send it to the supplier yourself, then record the despatch below.
          Connect a provider under Integrations → Providers to change this.
        </div>
      ) : (
        <div
          data-testid="rfq-provider-ready"
          className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          <span className="font-medium text-foreground">
            Provider configured ({readyChannels.join(", ")})
          </span>{" "}
          — RFQ despatch is still recorded by hand here. Send the invitation through the connected
          channel, then mark it sent so the trail shows who sent it and when.
        </div>
      )}

      {mayManage ? (

        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {((suppliers.data ?? []) as ProcRow[]).map((s) => {
              const id = String(s["id"]);
              const chosen = invited.includes(id);
              return (
                <Button
                  key={id}
                  type="button"
                  size="sm"
                  variant={chosen ? "default" : "outline"}
                  onClick={() => toggle(id)}
                >
                  {str(s["name"])}
                </Button>
              );
            })}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="rfq-closes">Quotes close</Label>
              <NeoDatePicker id="rfq-closes" value={closesAt} onChange={setClosesAt} />
            </div>
            <div className="flex items-end md:col-span-2">
              <Button
                disabled={invited.length === 0 || createRfq.isPending}
                onClick={() =>
                  createRfq.mutate(
                    { requestId, supplierIds: invited, closesAt: closesAt || null },
                    { onSuccess: () => setInvited([]) },
                  )
                }
              >
                Raise RFQ for {invited.length || "no"} supplier{invited.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <QueryState
        isLoading={rfqs.isLoading}
        error={rfqs.error}
        isEmpty={rows.length === 0}
        empty={<EmptyState title="No RFQ raised yet" description="Invite suppliers to quote against this request." />}
      >
        {(
          <div className="space-y-4">
            {rows.map((rfq) => {
              const invites = (rfq["rfq_suppliers"] as ProcRow[] | null) ?? [];
              return (
                <div key={String(rfq["id"])} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <FileSpreadsheet className="h-4 w-4" />
                    {str(rfq["rfq_number"])}
                    <StatusPill>{str(rfq["status"], "draft")}</StatusPill>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead>
                        <TableHead>Communication</TableHead>
                        <TableHead>Quotation</TableHead>
                        <TableHead className="text-right">Record</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invites.map((invite) => {
                        const supplier = (invite["suppliers"] as ProcRow | null) ?? {};
                        const state = String(invite["dispatch_state"] ?? "prepared") as RfqDispatchState;
                        return (
                          <TableRow key={String(invite["id"])}>
                            <TableCell>{str(supplier["name"])}</TableCell>
                            <TableCell>
                              <StatusPill>{RFQ_DISPATCH_STATES[state] ?? state}</StatusPill>
                            </TableCell>
                            <TableCell>{invite["responded_at"] ? "Received" : "Awaiting"}</TableCell>
                            <TableCell className="text-right">
                              {mayManage ? (
                                <div className="flex justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={recordDispatch.isPending}
                                    onClick={() =>
                                      recordDispatch.mutate({
                                        inviteId: String(invite["id"]),
                                        state: "downloaded",
                                        channel: "download",
                                      })
                                    }
                                  >
                                    Downloaded
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={recordDispatch.isPending}
                                    onClick={() =>
                                      recordDispatch.mutate({
                                        inviteId: String(invite["id"]),
                                        state: "marked-sent",
                                        channel: str(supplier["whatsapp"], "") ? "whatsapp" : "email",
                                      })
                                    }
                                  >
                                    Mark sent manually
                                  </Button>
                                </div>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              );
            })}
          </div>
        )}
      </QueryState>
    </SectionCard>
  );
}
