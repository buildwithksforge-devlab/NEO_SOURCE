import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  DueLabel,
  EmptyState,
  PastryGuard,
  PastryStatusBadge,
  QueryState,
} from "@/components/pastry/PastryShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  CAKE_FLAVOURS,
  nextCustomCakeStatus,
  pastryNum,
  pastryStr,
  useAdvanceCustomCake,
  useAssignCustomCake,
  useCreateCustomCakeOrder,
  useCustomCakeOrders,
  usePastryStaff,
  type PastryRow,
} from "@/lib/pastry-department";
import { titleCase } from "@/lib/kitchen";

export const Route = createFileRoute("/_shell/pastry/custom-cakes")({
  head: () => ({
    meta: [
      { title: "Custom Cake Orders — NEØ" },
      {
        name: "description",
        content:
          "Take custom cake orders with size, flavour, message and collection time, assign them to a Pastry Chef and track them through to collection.",
      },
      { property: "og:title", content: "Custom Cake Orders — NEØ" },
      {
        property: "og:description",
        content:
          "Every custom cake from order to collection, with the specification the chef needs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-custom-orders">
      <CustomCakesPage />
    </PastryGuard>
  ),
});

function toIso(local: string) {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function CustomCakesPage() {
  const { can } = useAuth();
  const mayManage = can("kitchen", "pastry-custom-orders", "edit");
  const mayCreate = can("kitchen", "pastry-custom-orders", "create");

  const [status, setStatus] = useState("all");
  const orders = useCustomCakeOrders(status);
  const staff = usePastryStaff();
  const create = useCreateCustomCakeOrder();
  const assign = useAssignCustomCake();
  const advance = useAdvanceCustomCake();

  const [open, setOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [product, setProduct] = useState("");
  const [sizeKg, setSizeKg] = useState("1");
  const [flavour, setFlavour] = useState<string>("Vanilla");
  const [cakeMessage, setCakeMessage] = useState("");
  const [decoration, setDecoration] = useState("");
  const [requiredAt, setRequiredAt] = useState("");
  const [quoted, setQuoted] = useState("");

  const rows = (orders.data ?? []) as PastryRow[];

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="Custom cake orders"
        description="A custom cake is a promise with a deadline. Record the specification once, assign it, and the Pastry Chef sees everything except the money."
        actions={
          <>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "all",
                  "new",
                  "assigned",
                  "in-preparation",
                  "decorating",
                  "ready",
                  "collected",
                  "cancelled",
                ].map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mayCreate ? <Button onClick={() => setOpen(true)}>New cake order</Button> : null}
          </>
        }
      />

      <SectionCard title="Orders" description="Ordered by the time they are needed.">
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No custom cake orders"
              description="Recorded cake orders will appear here."
            />
          }
        >
          <div className="space-y-3">
            {rows.map((r) => {
              const id = String(r["id"]);
              const st = String(r["status"]);
              const next = nextCustomCakeStatus(st);
              return (
                <div key={id} className="rounded-xl border border-border/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">
                        {pastryStr(r["product"])} · {pastryNum(r["size_kg"]) || "—"} kg
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {pastryStr(r["order_number"])} · {pastryStr(r["customer_name"])}
                        {r["customer_phone"] ? ` · ${pastryStr(r["customer_phone"])}` : ""}
                      </p>
                      <DueLabel value={r["required_at"] as string | null} />
                      {r["cake_message"] ? (
                        <p className="mt-2 rounded-lg border border-border/70 bg-muted/40 p-2 text-xs">
                          “{pastryStr(r["cake_message"])}”
                        </p>
                      ) : null}
                      {r["decoration_notes"] ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {pastryStr(r["decoration_notes"])}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <PastryStatusBadge status={st} />
                      {mayManage ? (
                        <Select
                          value={pastryStr(r["assignee_id"], "")}
                          onValueChange={(value) =>
                            assign.mutate({ orderId: id, assigneeId: value })
                          }
                        >
                          <SelectTrigger
                            className="h-8 w-44 text-xs"
                            aria-label="Assign Pastry Chef"
                          >
                            <SelectValue placeholder="Assign Pastry Chef" />
                          </SelectTrigger>
                          <SelectContent>
                            {(staff.data ?? []).map((p) => (
                              <SelectItem key={String(p["id"])} value={String(p["id"])}>
                                {pastryStr(p["full_name"], "Unnamed")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      {mayManage && next ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => advance.mutate({ orderId: id, status: next })}
                        >
                          Mark {titleCase(next)}
                        </Button>
                      ) : null}
                      {mayManage && st === "ready" ? (
                        <Button
                          size="sm"
                          onClick={() => advance.mutate({ orderId: id, status: "collected" })}
                        >
                          Collected
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New custom cake order</DialogTitle>
            <DialogDescription>
              Capture the specification exactly as the guest asked for it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cake-customer">Customer</Label>
                <Input
                  id="cake-customer"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="cake-phone">Phone</Label>
                <Input
                  id="cake-phone"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="cake-product">Cake</Label>
              <Input
                id="cake-product"
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder="Two-tier birthday cake"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cake-size">Size (kg)</Label>
                <Input
                  id="cake-size"
                  type="number"
                  min="0"
                  step="0.5"
                  value={sizeKg}
                  onChange={(e) => setSizeKg(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="cake-flavour">Flavour</Label>
                <Select value={flavour} onValueChange={setFlavour}>
                  <SelectTrigger id="cake-flavour">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAKE_FLAVOURS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="cake-message">Message on the cake</Label>
              <Input
                id="cake-message"
                value={cakeMessage}
                onChange={(e) => setCakeMessage(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cake-decoration">Decoration notes</Label>
              <Textarea
                id="cake-decoration"
                value={decoration}
                onChange={(e) => setDecoration(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cake-required">Required by</Label>
                <Input
                  id="cake-required"
                  type="datetime-local"
                  value={requiredAt}
                  onChange={(e) => setRequiredAt(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="cake-quote">Quoted amount</Label>
                <Input
                  id="cake-quote"
                  type="number"
                  min="0"
                  value={quoted}
                  onChange={(e) => setQuoted(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!customerName.trim() || !product.trim() || create.isPending}
              onClick={async () => {
                await create.mutateAsync({
                  customerName: customerName.trim(),
                  product: product.trim(),
                  requiredAt: toIso(requiredAt),
                  sizeKg: sizeKg ? Number(sizeKg) : null,
                  flavour,
                  cakeMessage: cakeMessage.trim(),
                  customerPhone: customerPhone.trim(),
                  decorationNotes: decoration.trim(),
                  quotedAmount: quoted ? Number(quoted) : null,
                });
                setCustomerName("");
                setCustomerPhone("");
                setProduct("");
                setCakeMessage("");
                setDecoration("");
                setRequiredAt("");
                setQuoted("");
                setOpen(false);
              }}
            >
              Record order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
