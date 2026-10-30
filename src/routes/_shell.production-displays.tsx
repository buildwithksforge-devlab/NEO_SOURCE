import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { DISPLAY_LABELS, DISPLAY_ROUTES } from "@/lib/production-displays";
import { pathPermitted } from "@/lib/capabilities";

export const Route = createFileRoute("/_shell/production-displays")({ component: DisplayControls });
type Session = {
  id: string;
  label: string;
  branch_id: string;
  read_only: boolean;
  expires_at: string;
};
function DisplayControls() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const sessions = useQuery({
    queryKey: ["production-display-sessions"],
    retry: false,
    queryFn: async () => {
      const { data, error } = await guardedRpc<{ ok: boolean; sessions: Session[] }>(
        supabase,
        "neo_production_display_manage",
      );
      if (error) throw new Error(error.message);
      return data.sessions;
    },
  });
  const revoke = useMutation({
    retry: false,
    mutationFn: async (id: string) => {
      const { error } = await guardedRpc(supabase, "neo_production_display_manage", { _close: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void sessions.refetch();
      toast.success("Shared display access revoked.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Shared display controls"
        description="Open a department display to pair its stations. To pair a screen, choose a department and station, then select Pair this station. This device signs out and opens the independent screen for 12 hours."
      />
      <div className="rounded-lg border border-neo-mist bg-white p-4 text-sm">
        <p className="font-semibold">Independent station screen</p>
        <p className="mt-1 text-neo-steel">
          A paired device receives new POS tickets without an employee signing into the full
          operating system. Staff approve Accept, Preparing and Ready with their personal PIN.
          Pairing or renewal requires an authorized production supervisor.
        </p>
        <Link to="/station-screen" className="mt-2 inline-flex font-medium text-neo-aqua underline">
          Open this device&apos;s station screen
        </Link>
      </div>
      <nav aria-label="Production display entrances" className="flex flex-wrap gap-3">
        {Object.entries(DISPLAY_ROUTES)
          .filter(([, path]) => pathPermitted(can, path))
          .map(([department, path]) => (
            <Link key={path} to={path} className="rounded-lg border p-4">
              {DISPLAY_LABELS[department as keyof typeof DISPLAY_LABELS]}
            </Link>
          ))}
      </nav>
      <h2 className="text-lg font-semibold">
        Active shared screens{branchId ? " at this property" : ""}
      </h2>
      {sessions.isLoading ? <p>Loading shared screens…</p> : null}
      {sessions.error ? (
        <p role="alert" className="text-destructive">
          {sessions.error.message}
        </p>
      ) : null}
      {sessions.data
        ?.filter((s) => !branchId || s.branch_id === branchId)
        .map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div>
              <p className="font-semibold">{s.label}</p>
              <p className="text-sm">
                {s.read_only ? "View only · " : ""}Expires {new Date(s.expires_at).toLocaleString()}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(s.id)}
            >
              Revoke screen access
            </Button>
          </div>
        ))}
      {sessions.data?.filter((s) => !branchId || s.branch_id === branchId).length === 0 ? (
        <p>No active shared screens.</p>
      ) : null}
    </div>
  );
}
