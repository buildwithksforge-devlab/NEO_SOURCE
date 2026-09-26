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
  PASTRY_UNITS,
  pastryNum,
  pastryStr,
  useAddPastryPlanItem,
  useAssignPastryItem,
  usePastryPlans,
  usePastryProductionItems,
  usePastryStaff,
  useRecordPastrySales,
  useUpsertPastryPlan,
  type PastryRow,
} from "@/lib/pastry-department";

export const Route = createFileRoute("/_shell/pastry/production")({
  head: () => ({
    meta: [
      { title: "Pastry Production Plan — NEØ" },
      {
        name: "description",
        content:
          "Plan the day's bakery output, assign each product to a Pastry Chef and reconcile what was produced against what sold.",
      },
      { property: "og:title", content: "Pastry Production Plan — NEØ" },
      {
        property: "og:description",
        content:
          "Dated pastry production plans with assignment and produced-versus-sold reconciliation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-schedule">
      <PastryProductionPage />
    </PastryGuard>
  ),
});

function toIso(local: string) {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function PastryProductionPage() {
  const { can } = useAuth();
  const mayPlan = can("kitchen", "pastry-schedule", "create");
  const mayReconcile = can("kitchen", "pastry-schedule", "edit");

  const plans = usePastryPlans();
  const [planId, setPlanId] = useState<string | null>(null);
  const activePlan =
    (plans.data ?? []).find((p) => String(p["id"]) === planId) ?? (plans.data ?? [])[0] ?? null;
  const activeId = activePlan ? String(activePlan["id"]) : null;

  const items = usePastryProductionItems(activeId);
  const staff = usePastryStaff();
  const upsertPlan = useUpsertPastryPlan();
  const addItem = useAddPastryPlanItem();
  const assign = useAssignPastryItem();
  const record = useRecordPastrySales();

  const [open, setOpen] = useState(false);
  const [product, setProduct] = useState("");
  const [quantity, setQuantity] = useState("12");
  const [unit, setUnit] = useState<string>("piece");
  const [assignee, setAssignee] = useState<string>("");
  const [due, setDue] = useState("");
  const [instructions, setInstructions] = useState("");

  const rows = (items.data ?? []) as PastryRow[];

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="Production plan"
        description="Bakery output is planned before an order exists. Every product on the plan carries a quantity, a due time and the Pastry Chef responsible for it."
        actions={
          mayPlan ? (
            <>
              <Button
                variant="outline"
                onClick={async () => {
                  const row = await upsertPlan.mutateAsync({ planDate: null });
                  if (row["id"]) setPlanId(String(row["id"]));
                }}
              >
                Start today's plan
              </Button>
              <Button disabled={!activeId} onClick={() => setOpen(true)}>
                Add product
              </Button>
            </>
          ) : null
        }
      />

      <SectionCard
        title="Plan"
        description="Choose which dated plan you are working on."
        actions={
          <Select value={activeId ?? ""} onValueChange={setPlanId}>
            <SelectTrigger className="w-48" aria-label="Production plan">
              <SelectValue placeholder="Select a plan" />
            </SelectTrigger>
            <SelectContent>
              {(plans.data ?? []).map((p) => (
                <SelectItem key={String(p["id"])} value={String(p["id"])}>
                  {pastryStr(p["plan_date"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        className="mb-6"
      >
        <QueryState
          isLoading={items.isLoading || plans.isLoading}
          error={items.error ?? plans.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="Nothing planned yet"
              description={
                mayPlan
                  ? "Start today's plan, then add each product you intend to bake."
                  : "The Head Pastry Chef has not published a production plan."
              }
            />
          }
        >
          <div className="space-y-2">
            {rows.map((r) => {
              const id = String(r["id"]);
              return (
                <div key={id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{pastryStr(r["product"])}</p>
                      <p className="text-xs text-muted-foreground">
                        Planned {pastryNum(r["quantity"])} {pastryStr(r["unit"], "piece")} ·
                        produced {pastryNum(r["produced_quantity"])} · sold{" "}
                        {pastryNum(r["sold_quantity"])} · wasted {pastryNum(r["wasted_quantity"])}
                      </p>
                      <DueLabel value={r["due_at"] as string | null} />
                      {r["special_instructions"] ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {pastryStr(r["special_instructions"])}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <PastryStatusBadge status={String(r["status"])} />
                      {mayReconcile ? (
                        <Select
                          value={pastryStr(r["assignee_id"], "")}
                          onValueChange={(value) =>
                            assign.mutate({ itemId: id, assigneeId: value })
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
                      {mayReconcile && pastryNum(r["produced_quantity"]) > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const sold = window.prompt(
                              "How many were sold?",
                              String(pastryNum(r["sold_quantity"])),
                            );
                            if (sold === null) return;
                            const wasted = window.prompt(
                              "How many were wasted?",
                              String(pastryNum(r["wasted_quantity"])),
                            );
                            record.mutate({
                              itemId: id,
                              sold: Number(sold),
                              wasted: wasted === null ? null : Number(wasted),
                            });
                          }}
                        >
                          Reconcile
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a product to the plan</DialogTitle>
            <DialogDescription>
              Quantity, due time and finishing instructions travel with the product to the Pastry
              Chef.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="pastry-product">Product</Label>
              <Input
                id="pastry-product"
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder="Croissants"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pastry-qty">Quantity</Label>
                <Input
                  id="pastry-qty"
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pastry-unit">Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger id="pastry-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PASTRY_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pastry-due">Due</Label>
                <Input
                  id="pastry-due"
                  type="datetime-local"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pastry-assignee">Pastry Chef</Label>
                <Select value={assignee} onValueChange={setAssignee}>
                  <SelectTrigger id="pastry-assignee">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    {(staff.data ?? []).map((p) => (
                      <SelectItem key={String(p["id"])} value={String(p["id"])}>
                        {pastryStr(p["full_name"], "Unnamed")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="pastry-instructions">Finishing instructions</Label>
              <Textarea
                id="pastry-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Glaze after cooling, dust with icing sugar"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!activeId || !product.trim() || addItem.isPending}
              onClick={async () => {
                if (!activeId) return;
                await addItem.mutateAsync({
                  planId: activeId,
                  product: product.trim(),
                  quantity: Number(quantity) || 1,
                  unit,
                  assigneeId: assignee || null,
                  dueAt: toIso(due),
                  instructions: instructions.trim(),
                });
                setProduct("");
                setInstructions("");
                setDue("");
                setOpen(false);
              }}
            >
              Add to plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
