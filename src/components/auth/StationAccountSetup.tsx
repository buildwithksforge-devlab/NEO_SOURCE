import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { useScopedStations } from "@/lib/kitchen-tickets";
import { stationDepartment } from "@/lib/production-displays";
import { guardedRpc, type GuardedRpcError } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type StationAccount = { id: string; name: string | null; email: string | null; display_pin_set: boolean; opens_station: boolean };

export function StationAccountSetup() {
  const { user, organizationId } = useAuth();
  const { activeBranch, branches, setActiveBranchId } = useBranchScope();
  const allowed = useQuery({
    queryKey: ["station-account-admin", organizationId, user?.id],
    enabled: Boolean(organizationId && user),
    queryFn: async () => {
      const { data, error } = await guardedRpc<boolean>(supabase, "neo_device_admin_allowed");
      if (error) throw new Error(error.message);
      return data === true;
    },
  });
  if (!allowed.data) return null;
  return (
    <SectionCard title="Display sign-in setup" description="Choose the station that opens after an assigned staff member signs in.">
      <div className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="station-entry-property">Property</Label>
          <select id="station-entry-property" className="block min-h-11 w-full rounded-md border bg-background px-3"
            value={activeBranch?.id ?? ""} onChange={(event) => setActiveBranchId(event.target.value || "all")}>
            <option value="">Choose a property</option>
            {branches.filter((branch) => branch.active).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </div>
        {activeBranch?.active ? <PropertyStationAccounts key={activeBranch.id} branchId={activeBranch.id} /> : null}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button asChild variant="outline"><Link to="/users">Manage staff accounts and station access</Link></Button>
          <Button asChild variant="outline"><Link to="/device-authorisation">Authorise staff PIN device</Link></Button>
          {activeBranch?.active ? <Button asChild variant="outline">
            <Link to="/workspace" search={{ home: "1", setup: "display", property: activeBranch.id }}>Set up a shared display</Link>
          </Button> : null}
        </div>
      </div>
    </SectionCard>
  );
}

function PropertyStationAccounts({ branchId }: { branchId: string }) {
  const scope = useScopedStations(branchId);
  const [stationId, setStationId] = useState("");
  const stations = scope.stations.filter((station) => stationDepartment(station));
  const selected = stations.some((station) => station.id === stationId);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="station-entry-station">Display station</Label>
        <select id="station-entry-station" className="block min-h-11 w-full rounded-md border bg-background px-3"
          value={selected ? stationId : ""} disabled={scope.isLoading} onChange={(event) => setStationId(event.target.value)}>
          <option value="">{scope.isLoading ? "Loading stations…" : "Choose a station"}</option>
          {stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}
        </select>
        {scope.error ? <p role="alert" className="text-sm text-destructive">Stations could not be loaded. Reload and try again.</p> : null}
      </div>
      {selected ? <StationAccounts key={stationId} branchId={branchId} stationId={stationId} /> : null}
    </div>
  );
}

function StationAccounts({ branchId, stationId }: { branchId: string; stationId: string }) {
  const { organizationId, user } = useAuth();
  const [accountId, setAccountId] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const args = { _branch: branchId, _station: stationId };
  const accounts = useQuery({
    queryKey: ["station-entry-accounts", organizationId, user?.id, branchId, stationId],
    queryFn: async () => {
      const { data, error } = await guardedRpc<StationAccount[]>(supabase, "neo_station_display_pin_admin", args);
      if (error) throw error;
      return data;
    },
  });
  const account = accounts.data?.find((entry) => entry.id === accountId);
  const save = useMutation({
    mutationFn: async (action: "route" | "remove" | "pin" | "disable-pin") => {
      if (!account) throw new Error("Choose a staff account assigned to this station.");
      if (action === "pin" && (pin.length !== 6 || pin !== confirmPin)) throw new Error("Enter and confirm the same six-digit PIN.");
      const { data, error } = action === "pin" || action === "disable-pin"
        ? await guardedRpc<{ ok: boolean }>(supabase, "neo_station_display_pin_admin", { ...args, _user: account.id, _pin: action === "pin" ? pin : null })
        : await guardedRpc<{ ok: boolean }>(supabase, "neo_station_login_admin", { ...args, _user: account.id, _remove: action === "remove" });
      if (error || !data?.ok) throw new Error(error?.message ?? "The setting could not be saved.");
      return action;
    },
    onSuccess: (action) => {
      toast.success(action === "pin" ? "Display PIN saved." : action === "disable-pin" ? "Display PIN disabled." : action === "remove" ? "Direct display entry removed." : "Direct display entry saved.");
      void accounts.refetch();
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => { setPin(""); setConfirmPin(""); },
  });

  if (accounts.isPending) return <p role="status">Loading assigned staff…</p>;
  if (accounts.isError) {
    const error = accounts.error as GuardedRpcError;
    const message = error.code === "PGRST202" || error.code === "42883"
      ? "The assigned-staff service is unavailable. Ask your system administrator to check the display setup database update."
      : error.code === "42501" || error.code === "no_session"
        ? error.message
        : "Could not load assigned staff for this station.";
    return <div role="alert" className="space-y-2">
      <p className="text-sm text-destructive">{message}</p>
      <Button variant="outline" onClick={() => void accounts.refetch()}>Retry loading assigned staff</Button>
    </div>;
  }
  if (!accounts.data?.length) return <p className="text-sm">Assign staff to this station in <Link className="underline" to="/users">Users</Link> to configure their display login.</p>;
  return (
    <div className="space-y-3">
      <Label htmlFor="station-entry-account">Assigned staff account</Label>
      <select id="station-entry-account" className="block min-h-11 w-full rounded-md border bg-background px-3" value={accountId}
        disabled={save.isPending} onChange={(event) => { setAccountId(event.target.value); setPin(""); setConfirmPin(""); }}>
        <option value="">Choose an account</option>
        {accounts.data.map((staff) => <option key={staff.id} value={staff.id}>{staff.name ?? staff.email ?? "Staff account"}{staff.name && staff.email ? ` · ${staff.email}` : ""}</option>)}
      </select>
      {account ? <>
        <p className="text-sm text-muted-foreground">Direct display entry chooses where this account lands after signing in. The display PIN unlocks a paired screen. Staff use their personal PIN to authorize work or approve as a supervisor when permitted.</p>
        <Button type="button" variant={account.opens_station ? "outline" : "default"} disabled={save.isPending}
          onClick={() => save.mutate(account.opens_station ? "remove" : "route")}>
          {account.opens_station ? "Remove direct display entry" : "Open this station after sign-in"}
        </Button>
        <form className="space-y-3 border-t pt-3" onSubmit={(event) => { event.preventDefault(); save.mutate("pin"); }}>
          <p className="text-sm font-medium">{account.display_pin_set ? "Display PIN active" : "Display PIN not set"}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label htmlFor="station-entry-pin">Display PIN</Label><Input id="station-entry-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></div>
            <div><Label htmlFor="station-entry-confirm">Confirm display PIN</Label><Input id="station-entry-confirm" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))} /></div>
          </div>
          <Button type="submit" variant="outline" disabled={save.isPending || pin.length !== 6 || pin !== confirmPin}>Save display PIN</Button>
          {account.display_pin_set ? <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate("disable-pin")}>Disable display PIN</Button> : null}
        </form>
      </> : null}
    </div>
  );
}
