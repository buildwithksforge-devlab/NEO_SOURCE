import { guardedRpc } from "@/lib/rpc-guard";
import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { guardPreview } from "@/lib/preview-mode";
import { PreviewBanner } from "@/components/public/PreviewBanner";
import { RiderTabBar } from "@/components/public/RiderTabBar";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/rider/support")({
  head: () => ({
    meta: [
      { title: "My Support — NEØ Rider" },
      {
        name: "description",
        content: "Report equipment needs and vehicle faults, and see the tasks assigned to you by the Delivery Manager.",
      },
      { property: "og:title", content: "My Support — NEØ Rider" },
      { property: "og:description", content: "Rider supply needs, fault reports and assigned tasks." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RiderSupportPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
type Row = Record<string, unknown>;

const s = (v: unknown, fallback = "—") => {
  const out = v === null || v === undefined ? "" : String(v);
  return out.trim() === "" ? fallback : out;
};

function useMySupplyRequests() {
  return useQuery({
    queryKey: ["rider", "supply-requests"],
    queryFn: async () => {
      const { data, error } = await db
        .from("delivery_supply_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

function useMyRiderTasks(userId?: string) {
  return useQuery({
    queryKey: ["rider", "tasks", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await db
        .from("tasks")
        .select("*")
        .eq("assignee_id", userId)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

function RiderSupportPage() {
  const navigate = useNavigate();
  const { user, loading } = useCustomerSession();
  const qc = useQueryClient();
  const supply = useMySupplyRequests();
  const tasks = useMyRiderTasks(user?.id);

  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [asset, setAsset] = useState("");
  const [fault, setFault] = useState("");

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/rider/login" });
  }, [loading, user, navigate]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["rider"] });
  };

  const requestSupply = useMutation({
    mutationFn: async () => {
      guardPreview();
      const { error } = await guardedRpc(db, "neo_delivery_supply_request_create", {
        _item: item,
        _quantity: Number(quantity) || 1,
        _unit: "unit",
        _priority: "normal",
        _notes: notes || null,
        _branch: null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      setItem("");
      setQuantity("1");
      setNotes("");
      toast.success("Sent to your Delivery Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reportFault = useMutation({
    mutationFn: async () => {
      guardPreview();
      const { error } = await guardedRpc(db, "neo_delivery_maintenance_request", {
        _asset_label: asset,
        _description: fault,
        _priority: "medium",
        _fault_category: "vehicle",
        _branch: null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      setAsset("");
      setFault("");
      toast.success("Fault reported to Maintenance");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateTask = useMutation({
    mutationFn: async (input: { id: string; status: string }) => {
      guardPreview();
      const patch: Row = { status: input.status };
      if (input.status === "completed") patch["completed_at"] = new Date().toISOString();
      const { error } = await db.from("tasks").update(patch).eq("id", input.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (loading) {
    return (
      <div className="neo-public-app flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-white" />
      </div>
    );
  }

  const card = "neo-rider-card p-5";

  return (
    <div className="neo-rider-page">
      <PreviewBanner experience="Rider" />
      <header className="px-5 py-4">
        <div className="mx-auto flex w-full max-w-md items-center gap-3">
          <Link to="/rider" aria-label="Back to deliveries" className="text-white/70">
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="text-base font-semibold text-white">My Support</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md min-w-0 space-y-4 px-5">
        <section className={card}>
          <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            My tasks
          </h2>
          <p className="mt-1 text-xs text-slate-500">Only tasks assigned to you appear here.</p>
          <div className="mt-3 space-y-2">
            {tasks.isLoading ? (
              /* The rider app uses the same designed NEØ state language as the
                 staff app: a shaped skeleton, then a recoverable error card. */
              <LoadingState variant="rows" rows={2} />
            ) : tasks.error ? (
              <div className="space-y-2">
                <ErrorState
                  error={tasks.error}
                  title="Your tasks could not be loaded"
                  inline
                  onRetry={() => void tasks.refetch()}
                />
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link to="/rider">Go back to deliveries</Link>
                </Button>
              </div>
            ) : (tasks.data ?? []).length === 0 ? (
              <EmptyState
                title="No tasks assigned to you"
                description="Tasks your Delivery Manager assigns will appear here."
                inline
              />
            ) : (
              (tasks.data ?? []).map((t) => {
                const id = String(t["id"]);
                const status = s(t["status"], "open");
                return (
                  <div key={id} className="min-w-0 rounded-2xl border border-slate-200 p-3">
                    <p className="break-words text-sm font-medium text-slate-900">{s(t["title"])}</p>
                    {t["description"] ? (
                      <p className="mt-0.5 break-words text-xs text-slate-500">{s(t["description"], "")}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-500">
                      {t["due_at"] ? `Due ${new Date(String(t["due_at"])).toLocaleString()}` : "No due date"} · {status}
                    </p>
                    {status !== "completed" ? (
                      <div className="mt-2 flex gap-2">
                        {status !== "in-progress" ? (
                          <button
                            className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium"
                            onClick={() =>
                              updateTask.mutate({ id, status: "in-progress" })
                            }
                          >
                            Start
                          </button>
                        ) : null}
                        <button
                          className="rounded-full px-3 py-1 text-xs font-semibold text-white"
                          style={{ background: brandFallback.primary }}
                          onClick={() => updateTask.mutate({ id, status: "completed" })}
                        >
                          Done
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className={card}>
          <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            Report a supply need
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Delivery bags, rain gear, helmets, packaging. Your manager decides and Stores issues it.
          </p>
          <div className="mt-3 space-y-3">
            <div>
              <Label htmlFor="item">What do you need</Label>
              <Input id="item" value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Rain jacket" />
            </div>
            <div>
              <Label htmlFor="qty">Quantity</Label>
              <Input id="qty" type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
            <button
              className="w-full rounded-full py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: brandFallback.primary }}
              disabled={requestSupply.isPending || !item.trim()}
              onClick={() => requestSupply.mutate()}
            >
              Send request
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {(supply.data ?? []).map((r) => (
              <div key={String(r["id"])} className="min-w-0 break-words rounded-2xl border border-slate-200 p-3 text-xs text-slate-600">
                <span className="font-medium text-slate-900">{s(r["item"])}</span> · {s(r["quantity"])}{" "}
                {s(r["unit"], "")} · {s(r["status"], "pending")}
                {r["review_notes"] ? <div className="mt-1">{s(r["review_notes"], "")}</div> : null}
              </div>
            ))}
          </div>
        </section>

        <section className={card}>
          <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            Report a fault
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Motorcycle, vehicle or delivery box problems go straight to Maintenance.
          </p>
          <div className="mt-3 space-y-3">
            <div>
              <Label htmlFor="asset">Vehicle or equipment</Label>
              <Input
                id="asset"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                placeholder="e.g. Motorcycle KDD 123A"
              />
            </div>
            <div>
              <Label htmlFor="fault">What is wrong</Label>
              <Input id="fault" value={fault} onChange={(e) => setFault(e.target.value)} placeholder="Describe the fault" />
            </div>
            <button
              className="w-full rounded-full py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: brandFallback.secondary }}
              disabled={reportFault.isPending || !asset.trim() || !fault.trim()}
              onClick={() => reportFault.mutate()}
            >
              Report fault
            </button>
          </div>
        </section>
      </main>
      <RiderTabBar active="support" />
    </div>
  );
}
