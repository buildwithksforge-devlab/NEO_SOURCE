import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { EmptyState, OpsBadge, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  LOST_FOUND_CATEGORIES,
  LOST_FOUND_STATUSES,
  SENSITIVE_CATEGORIES,
  shortDateTime,
  titleCase,
} from "@/lib/operations";
import { useLostFound, useLostFoundHistory, useRoomBoard, useSaveLostFound } from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/housekeeping/lost-found")({
  head: () => ({
    meta: [
      { title: "Lost & Found — Housekeeping — HOS" },
      {
        name: "description",
        content: "Register found property, track custody and record claims or disposal.",
      },
      { property: "og:title", content: "Lost & Found — Housekeeping — HOS" },
      {
        property: "og:description",
        content: "Register found property, track custody and record claims or disposal.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const { can } = useAuth();
  const items = useLostFound();
  const rooms = useRoomBoard();
  const save = useSaveLostFound();

  const [open, setOpen] = useState(false);
  const [trailId, setTrailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [form, setForm] = useState({
    description: "",
    category: "general",
    room_id: "",
    location_found: "",
    storage_location: "",
    notes: "",
  });

  const list = useMemo(
    () =>
      (items.data ?? []).filter((row) =>
        search
          ? String(row["description"] ?? "")
              .toLowerCase()
              .includes(search.toLowerCase())
          : true,
      ),
    [items.data, search],
  );

  const submit = () => {
    save.mutate(
      {
        description: form.description,
        category: form.category,
        sensitive: SENSITIVE_CATEGORIES.includes(form.category),
        room_id: form.room_id || null,
        location_found: form.location_found || null,
        storage_location: form.storage_location || null,
        notes: form.notes || null,
        status: "in-custody",
        found_at: new Date().toISOString(),
      },
      {
        onSuccess: () => {
          setOpen(false);
          setForm({
            description: "",
            category: "general",
            room_id: "",
            location_found: "",
            storage_location: "",
            notes: "",
          });
        },
      },
    );
  };

  return (
    <OpsGuard path="/housekeeping/lost-found">
      <PageHeader
        eyebrow="Housekeeping"
        title="Lost & Found"
        description="Every item is logged with custody, storage location and final outcome. High-value categories are flagged."
        actions={
          can("housekeeping", "create") ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>Register item</Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Register found item</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Description</Label>
                    <Input
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Category</Label>
                    <Select
                      value={form.category}
                      onValueChange={(v) => setForm({ ...form, category: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LOST_FOUND_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {titleCase(c)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Room found in</Label>
                    <Select
                      value={form.room_id}
                      onValueChange={(v) => setForm({ ...form, room_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional" />
                      </SelectTrigger>
                      <SelectContent>
                        {(rooms.data ?? []).map((r) => (
                          <SelectItem key={String(r["id"])} value={String(r["id"])}>
                            Room {String(r["room_number"])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Location found</Label>
                    <Input
                      value={form.location_found}
                      onChange={(e) => setForm({ ...form, location_found: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Storage location</Label>
                    <Input
                      value={form.storage_location}
                      onChange={(e) => setForm({ ...form, storage_location: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Notes</Label>
                    <Textarea
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button disabled={!form.description || save.isPending} onClick={submit}>
                    Save item
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null
        }
      />

      <div className="mb-4 max-w-sm">
        <Input
          placeholder="Search description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <QueryState
        isLoading={items.isLoading}
        error={items.error}
        isEmpty={list.length === 0}
        empty={
          <EmptyState
            title="Nothing recorded"
            description="Register found property to start the custody trail."
            icon={Search}
          />
        }
      >
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Found</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((row) => (
                <TableRow key={String(row["id"])}>
                  <TableCell>
                    <p className="font-medium">{String(row["description"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {row["reference"] ?? "—"}
                      {row["rooms"]?.room_number ? ` · Room ${row["rooms"].room_number}` : ""}
                    </p>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <OpsBadge value={row["category"]} tone="default" />
                      {row["sensitive"] ? <OpsBadge value="High value" tone="warning" /> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {shortDateTime(row["found_at"])}
                  </TableCell>
                  <TableCell className="text-xs">
                    {String(row["storage_location"] ?? "—")}
                  </TableCell>
                  <TableCell>
                    <OpsBadge value={row["status"]} tone="info" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Select
                        value={String(row["status"])}
                        onValueChange={(v) => save.mutate({ id: row["id"], status: v })}
                      >
                        <SelectTrigger className="h-8 w-52">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LOST_FOUND_STATUSES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {titleCase(s)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="lost-found-audit-trail"
                        onClick={() => setTrailId(String(row["id"]))}
                      >
                        Audit trail
                      </Button>
                    </div>
                  </TableCell>

                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>

      <LostFoundAuditTrail itemId={trailId} onClose={() => setTrailId(null)} />
    </OpsGuard>

  );
}

/**
 * Per-item custody audit trail. Reads the canonical
 * `lost_found_custody_history` record written by the database trigger — the UI
 * never writes a parallel log, so what is shown is what actually happened,
 * scoped to the current organisation and property by RLS.
 */
function LostFoundAuditTrail({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  const history = useLostFoundHistory(itemId);
  const rows = history.data ?? [];

  return (
    <Dialog open={Boolean(itemId)} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Custody audit trail</DialogTitle>
        </DialogHeader>
        <QueryState
          isLoading={history.isLoading}
          error={history.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No trail yet"
              description="Registration, custody hand-over and status changes appear here."
              icon={Search}
            />
          }
        >
          <ol className="space-y-3" data-testid="lost-found-audit-entries">
            {rows.map((entry) => (
              <li key={String(entry["id"])} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{titleCase(String(entry["action"] ?? "updated"))}</span>
                  <span className="text-xs text-muted-foreground">{shortDateTime(entry["created_at"])}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {entry["previous_status"]
                    ? `${titleCase(String(entry["previous_status"]))} → ${titleCase(String(entry["new_status"] ?? ""))}`
                    : `Status ${titleCase(String(entry["new_status"] ?? ""))}`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Custody: {String(entry["new_custodian"] ?? "unassigned")} · Recorded by{" "}
                  {String(entry["performed_by"] ?? "system")}
                </p>
                {entry["reason"] ? (
                  <p className="mt-1 text-xs text-muted-foreground">Reason: {String(entry["reason"])}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}
