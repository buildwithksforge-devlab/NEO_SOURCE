import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

import { useActivePropertyFilter } from "@/lib/branch-filter";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";


export const Route = createFileRoute("/_shell/production-displays")({ component: DisplayControls });
type Session = {
  id: string;
  label: string;
  branch_id: string;
  read_only: boolean;
  expires_at: string;
};
function DisplayControls() {

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
        description="Manage and revoke standalone production screens. New screens are configured from the property work entrance before entering the main NEØ system."
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

        <div className="mt-3">
          <Link
            to="/workspace"
            search={{
              home: "1",
              ...(branchId ? { property: branchId } : {}),
            }}
            className="inline-flex rounded-lg border border-neo-turquoise px-4 py-2 font-semibold text-neo-midnight"
          >
            Set up a new display
          </Link>
        </div>
      </div>

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
