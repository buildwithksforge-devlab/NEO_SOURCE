import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Heart, Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { EmptyState, MetricTile } from "@/components/marketing/MarketingShared";
import {
  useCreateReferralProgramme,
  useReferralProgrammes,
  useReferrals,
  useReviewReferral,
} from "@/lib/marketing-data";
import { formatDate, titleCase } from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/referrals")({
  head: () => ({
    meta: [
      { title: "Referrals — Marketing & CRM" },
      {
        name: "description",
        content:
          "Referral programmes with qualification rules and manual fraud review before any reward is issued.",
      },
      { property: "og:title", content: "Referrals — Marketing & CRM" },
      {
        property: "og:description",
        content: "Referral tracking with qualification and fraud review.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const { data: programmes } = useReferralProgrammes();
  const { data: referrals } = useReferrals();
  const review = useReviewReferral();
  const [open, setOpen] = useState(false);

  const rows = (referrals ?? []) as Row[];
  const qualified = rows.filter((r) => String(r["reward_status"]) === "qualified").length;
  const flagged = rows.filter((r) => r["fraud_flag"] === true).length;

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Referrals"
        description="A referral only qualifies once the referred customer completes a recorded, paid stay or order. Rewards are never issued automatically — each qualification is reviewed by an authorized user."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 size-4" /> New programme
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <MetricTile label="Referrals recorded" value={String(rows.length)} />
        <MetricTile label="Qualified" value={String(qualified)} tone="success" />
        <MetricTile
          label="Flagged for fraud"
          value={String(flagged)}
          tone={flagged ? "warning" : "default"}
        />
      </div>

      <SectionCard title="Programmes" description="Reward rules and qualification criteria.">
        {!programmes?.length ? (
          <EmptyState
            icon={Heart}
            title="No referral programmes"
            description="Create a programme to define what the referrer and the referred customer each receive."
          />
        ) : (
          <ul className="space-y-2">
            {(programmes as Row[]).map((p) => (
              <li key={String(p["id"])} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-foreground">{String(p["name"])}</p>
                  <StatusPill tone={p["is_active"] === false ? "default" : "success"}>
                    {p["is_active"] === false ? "Inactive" : "Active"}
                  </StatusPill>
                </div>
                <p className="text-sm text-muted-foreground">{String(p["description"] ?? "")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Referrer reward {Number(p["referrer_reward_value"] ?? 0).toLocaleString()} ·
                  Referred reward {Number(p["referred_reward_value"] ?? 0).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        className="mt-6"
        title="Referral register"
        description="Every recorded referral and its review state."
      >
        {!rows.length ? (
          <p className="text-sm text-muted-foreground">No referrals recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Referrer</TableHead>
                  <TableHead>Referred</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={String(r["id"])}>
                    <TableCell>{r["referrer"]?.full_name ?? "—"}</TableCell>
                    <TableCell>{r["referred"]?.full_name ?? "Pending sign-up"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(r["created_at"])}
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        tone={
                          r["fraud_flag"]
                            ? "destructive"
                            : String(r["reward_status"]) === "qualified"
                              ? "success"
                              : "default"
                        }
                      >
                        {r["fraud_flag"]
                          ? "Rejected"
                          : titleCase(String(r["reward_status"] ?? "pending"))}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {can("marketing", "approve") &&
                      String(r["reward_status"]) !== "qualified" &&
                      !r["fraud_flag"] ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              review.mutate({ id: String(r["id"]), status: "qualified" })
                            }
                          >
                            Qualify
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              review.mutate({
                                id: String(r["id"]),
                                status: "rejected",
                                reason: "Failed fraud review",
                              })
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <ProgrammeDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function ProgrammeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateReferralProgramme();
  const [form, setForm] = useState<Row>({ is_active: true });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New referral programme</DialogTitle>
          <DialogDescription>
            Rewards apply only after the referred customer completes a paid stay or order.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input
              value={String(form["name"] ?? "")}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={String(form["description"] ?? "")}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Referrer reward value</Label>
              <Input
                type="number"
                min={0}
                onChange={(e) => set("referrer_reward_value", Number(e.target.value || 0))}
              />
            </div>
            <div>
              <Label>Referred reward value</Label>
              <Input
                type="number"
                min={0}
                onChange={(e) => set("referred_reward_value", Number(e.target.value || 0))}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form["name"] || create.isPending}
            onClick={() => create.mutate(form, { onSuccess: () => onOpenChange(false) })}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/referrals">
      <Page />
    </OpsGuard>
  );
}
