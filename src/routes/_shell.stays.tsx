import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BedDouble, CalendarRange, LogIn, Users } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";
import { useWriteBranchId } from "@/lib/branch-filter";
import { useAuth } from "@/lib/auth";
import { formatDate, titleCase } from "@/lib/pms";

export const Route = createFileRoute("/_shell/stays")({
  head: () => ({
    meta: [
      { title: "Guest Stays — NEØ" },
      {
        name: "description",
        content:
          "Pending, confirmed and in-house stays with room and status, for housekeeping and food & beverage teams.",
      },
      { property: "og:title", content: "Guest Stays — NEØ" },
      {
        property: "og:description",
        content: "Pending, confirmed and in-house stays with room and status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Page,
});

type Row = Record<string, unknown>;

const BUCKETS = [
  { key: "pending", label: "Pending", statuses: ["tentative", "pending-deposit", "waitlisted", "enquiry"] },
  { key: "confirmed", label: "Confirmed", statuses: ["confirmed", "guaranteed"] },
  { key: "in-house", label: "Checked in", statuses: ["checked-in"] },
] as const;

function bucketOf(status: string): string | null {
  const key = String(status || "").toLowerCase();
  const hit = BUCKETS.find((b) => (b.statuses as readonly string[]).includes(key));
  return hit ? hit.key : null;
}

function guestName(row: Row): string {
  const name = String(row["guest_name"] ?? "").trim();
  return name || "Guest name not captured";
}

function roomLabel(row: Row): string {
  const number = String(row["room_number"] ?? "").trim();
  if (number) return `Room ${number}`;
  const typeName = String(row["room_type"] ?? "").trim();
  return typeName ? `${typeName} — room not assigned` : "Room not assigned";
}

/**
 * The board reads a purpose-built, property-scoped view of the booking record:
 * arrival, room and status only. Housekeeping and food & beverage hold no
 * front-office permission, so the full reservation record stays closed to them
 * and no money field is ever fetched to this screen in the first place.
 */
function useStayBoard(branchId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["stay-board", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase as never, "neo_stay_board", { _branch: branchId });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/**
 * Operational stay board. Housekeeping and food & beverage need to know who is
 * arriving, who is in-house and which room to work on — they never need the
 * money. Rates, folio balances and payment instruments are deliberately absent
 * from this screen; those stay behind the finance and front-desk surfaces that
 * already gate them.
 */
function Page() {
  const [bucket, setBucket] = useState<string>("confirmed");
  const [search, setSearch] = useState("");
  const branchId = useWriteBranchId();
  const query = useStayBoard(branchId);

  const rows = (query.data ?? []) as Row[];
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const b of BUCKETS) out[b.key] = 0;
    for (const r of rows) {
      const key = bucketOf(String(r["status"] ?? ""));
      if (key) out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }, [rows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((r) => bucketOf(String(r["status"] ?? "")) === bucket)
      .filter((r) => {
        if (term.length < 2) return true;
        const haystack = [
          guestName(r),
          String(r["confirmation_number"] ?? ""),
          roomLabel(r),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(term);
      });
  }, [rows, bucket, search]);

  return (
    <OpsGuard path="/stays">
      <div className="min-w-0 space-y-6">
        <PageHeader
          title="Guest stays"
          description="Who is arriving, who is in-house and which room to prepare. No rates or payment details are shown here."
        />

        <div className="grid min-w-0 gap-4 sm:grid-cols-3">
          {BUCKETS.map((b) => (
            <StatCard
              key={b.key}
              label={b.label}
              value={query.isLoading ? "…" : String(counts[b.key] ?? 0)}
              icon={b.key === "in-house" ? LogIn : b.key === "pending" ? CalendarRange : Users}
            />
          ))}
        </div>

        <SectionCard title="Stays" description="Straight from the booking system for this property.">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {BUCKETS.map((b) => (
              <Button
                key={b.key}
                type="button"
                size="sm"
                variant={bucket === b.key ? "default" : "outline"}
                onClick={() => setBucket(b.key)}
              >
                {b.label}
                <span className="ml-2 opacity-70">{counts[b.key] ?? 0}</span>
              </Button>
            ))}
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search guest, reference or room"
              className="h-9 w-full min-w-0 sm:w-64"
            />
          </div>

          <QueryState
            query={query}
            isLoading={query.isLoading}
            error={query.error}
            isEmpty={visible.length === 0}
            empty={
              <EmptyState
                title="Nothing in this list"
                description="No stay of this status is recorded for the selected property."
              />
            }
          >
            {(
              <ul className="mt-4 min-w-0 space-y-2">
                {visible.map((r) => (
                  <li
                    key={String(r["id"])}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{guestName(r)}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {String(r["confirmation_number"] ?? "Reference not captured")} ·{" "}
                        {formatDate(String(r["arrival_date"] ?? ""))} →{" "}
                        {formatDate(String(r["departure_date"] ?? ""))}
                      </p>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        <BedDouble className="h-4 w-4" aria-hidden />
                        <span className="truncate">{roomLabel(r)}</span>
                      </span>
                      <Badge variant="outline">{titleCase(String(r["status"] ?? ""))}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </SectionCard>
      </div>
    </OpsGuard>
  );
}
