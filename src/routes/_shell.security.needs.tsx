import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  EmptyState,
  QueryState,
  SecurityGuard,
  SecurityStatusBadge,
} from "@/components/security/SecurityShared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { titleCase } from "@/lib/kitchen";
import {
  SECURITY_NEED_UNITS,
  securityNum,
  securityStr,
  useReportSecurityNeed,
  useRequisitionSecurityNeeds,
  useSecurityStockNeeds,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/needs")({
  head: () => ({
    meta: [
      { title: "Security Stock Needs — NEØ" },
      {
        name: "description",
        content:
          "Guards report the supplies their post is short of; the Security Supervisor alone consolidates those needs into a Stores requisition.",
      },
      { property: "og:title", content: "Security Stock Needs — NEØ" },
      {
        property: "og:description",
        content: "Reported security supplies and the requisition raised for Stores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="stock-needs">
      <SecurityNeedsPage />
    </SecurityGuard>
  ),
});

function SecurityNeedsPage() {
  const { can } = useAuth();
  const mayRequisition = can("security-ops", "posts", "edit");
  const [status, setStatus] = useState("all");
  const needs = useSecurityStockNeeds(status);
  const report = useReportSecurityNeed();
  const requisition = useRequisitionSecurityNeeds();

  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<string>("piece");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const rows = (needs.data ?? []) as SecurityRow[];

  function submit() {
    if (!item.trim()) return;
    report.mutate(
      {
        item,
        quantity: Number(quantity) || 1,
        unit,
        priority,
        ...(notes ? { notes } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false);
          setItem("");
          setQuantity("1");
          setNotes("");
        },
      },
    );
  }

  function raise() {
    if (selected.length === 0) return;
    requisition.mutate(
      { needIds: selected, priority: "normal" },
      { onSuccess: () => setSelected([]) },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Stock needs"
        description="Torches, batteries, radios, registers and uniforms. Guards report what the post is short of; only the Security Supervisor sends the requisition to Stores."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(true)}>
              Report a need
            </Button>
            {mayRequisition ? (
              <Button onClick={raise} disabled={requisition.isPending || selected.length === 0}>
                Requisition {selected.length > 0 ? `(${selected.length})` : ""}
              </Button>
            ) : null}
          </div>
        }
      />

      <SectionCard
        title="Reported needs"
        description={
          mayRequisition
            ? "Select the lines to consolidate into one Stores requisition."
            : "What has been reported for the Security department."
        }
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["all", "reported", "acknowledged", "requisitioned", "fulfilled"].map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No needs reported"
              description="Nothing is outstanding for Security."
            />
          }
        >
          <div className="space-y-2">
            {rows.map((r) => {
              const id = String(r["id"]);
              const selectable =
                mayRequisition && ["reported", "acknowledged"].includes(String(r["status"]));
              return (
                <div
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div className="flex items-start gap-3">
                    {selectable ? (
                      <Checkbox
                        checked={selected.includes(id)}
                        onCheckedChange={(v) =>
                          setSelected((prev) => (v ? [...prev, id] : prev.filter((x) => x !== id)))
                        }
                        aria-label={`Select ${securityStr(r["item_name"])}`}
                      />
                    ) : null}
                    <div>
                      <p className="text-sm font-medium">{securityStr(r["item_name"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {securityNum(r["quantity"])} {securityStr(r["unit"], "piece")} ·{" "}
                        {titleCase(securityStr(r["priority"], "normal"))} priority
                      </p>
                      {r["notes"] ? (
                        <p className="text-xs text-muted-foreground">{securityStr(r["notes"])}</p>
                      ) : null}
                    </div>
                  </div>
                  <SecurityStatusBadge status={String(r["status"])} />
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report a stock need</DialogTitle>
            <DialogDescription>
              This goes to the Security Supervisor, not straight to Stores.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="need-item">Item</Label>
              <Input
                id="need-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="Torch batteries"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="need-qty">Quantity</Label>
                <Input
                  id="need-qty"
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label>Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SECURITY_NEED_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>
                        {titleCase(u)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["low", "normal", "high", "urgent"].map((p) => (
                    <SelectItem key={p} value={p}>
                      {titleCase(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="need-notes">Notes</Label>
              <Textarea
                id="need-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={report.isPending || !item.trim()}>
              Report need
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
