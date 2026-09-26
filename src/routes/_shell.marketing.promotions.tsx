import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { BadgePercent, Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/marketing/MarketingShared";
import {
  useCancelVoucher,
  useCreateVoucher,
  useCustomersLookup,
  usePromotions,
  useVouchers,
} from "@/lib/marketing-data";
import { formatDate, titleCase } from "@/lib/marketing";
import { useAuth } from "@/lib/auth";
import { NeoDatePicker } from "@/components/common/DatePicker";

export const Route = createFileRoute("/_shell/marketing/promotions")({
  head: () => ({
    meta: [
      { title: "Promotions & Vouchers — Marketing & CRM" },
      {
        name: "description",
        content:
          "Issue single-use vouchers and manage promotion codes redeemable at the POS, front desk and delivery checkout.",
      },
      { property: "og:title", content: "Promotions & Vouchers — Marketing & CRM" },
      { property: "og:description", content: "Voucher issuance and promotion code management." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const { data: promotions, isLoading } = usePromotions();
  const { data: vouchers } = useVouchers();
  const cancel = useCancelVoucher();
  const [issueOpen, setIssueOpen] = useState(false);

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Promotions & Vouchers"
        description="Vouchers are single-use, tied to one customer, and validated at redemption by the POS, front office or delivery checkout. Issuing is idempotent so a customer cannot be rewarded twice for the same campaign."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setIssueOpen(true)}>
              <Plus className="mr-1.5 size-4" /> Issue voucher
            </Button>
          ) : null
        }
      />

      <SectionCard
        title="Promotion codes"
        description="Shared codes with usage limits and validity windows."
      >
        {isLoading ? (
          <LoadingState variant="rows" rows={3} />
        ) : !promotions?.length ? (
          <EmptyState
            icon={BadgePercent}
            title="No promotion codes"
            description="Promotion codes created for POS, delivery or reservations appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Valid</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(promotions as Row[]).map((p) => (
                  <TableRow key={String(p["id"])}>
                    <TableCell className="font-medium">{String(p["code"])}</TableCell>
                    <TableCell>
                      {String(p["discount_type"] ?? "") === "percentage"
                        ? `${Number(p["discount_value"] ?? 0)}%`
                        : Number(p["discount_value"] ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(p["valid_from"])} –{" "}
                      {formatDate(p["valid_to"] ?? p["valid_until"])}
                    </TableCell>
                    <TableCell>
                      {Number(p["times_used"] ?? p["usage_count"] ?? 0)} / {p["usage_limit"] ?? "∞"}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={p["is_active"] === false ? "default" : "success"}>
                        {p["is_active"] === false ? "Inactive" : "Active"}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        className="mt-6"
        title="Issued vouchers"
        description="Personal, single-use rewards."
      >
        {!vouchers?.length ? (
          <p className="text-sm text-muted-foreground">No vouchers issued yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(vouchers as Row[]).map((v) => (
                  <TableRow key={String(v["id"])}>
                    <TableCell className="font-mono text-xs">{String(v["code"])}</TableCell>
                    <TableCell>{v["customers"]?.full_name ?? "—"}</TableCell>
                    <TableCell>{Number(v["value"] ?? v["amount"] ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(v["expires_at"])}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={String(v["status"]) === "active" ? "success" : "default"}>
                        {titleCase(String(v["status"]))}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {String(v["status"]) === "active" && can("marketing", "edit") ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            cancel.mutate({ id: String(v["id"]), reason: "Cancelled by staff" })
                          }
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <IssueDialog open={issueOpen} onOpenChange={setIssueOpen} />
    </div>
  );
}

function IssueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const { data: customers } = useCustomersLookup(search);
  const create = useCreateVoucher();
  const [customerId, setCustomerId] = useState("");
  const [value, setValue] = useState("");
  const [expires, setExpires] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue voucher</DialogTitle>
          <DialogDescription>
            The voucher code is generated securely and can be redeemed once. Issuing is logged in
            the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Find customer</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, number, email or phone"
            />
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {((customers ?? []) as Row[]).map((c) => (
                <button
                  key={String(c["id"])}
                  type="button"
                  onClick={() => setCustomerId(String(c["id"]))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm ${
                    customerId === String(c["id"]) ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  {String(c["full_name"])} · {String(c["customer_number"] ?? "")}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Value</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div>
            <Label>Expires</Label>
            <NeoDatePicker value={expires} onChange={setExpires} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!customerId || !value || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  customer_id: customerId,
                  value: Number(value),
                  expires_at: expires ? new Date(expires).toISOString() : null,
                  reward_source: "marketing_manual",
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/promotions">
      <Page />
    </OpsGuard>
  );
}
