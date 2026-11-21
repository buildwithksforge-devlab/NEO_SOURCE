import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { LoadingState, EmptyState, ErrorState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/device-authorisation")({
  component: DeviceAuthorisation,
});

type Device = {
  id: string;
  label: string;
  property: string;
  branch_id: string;
  expires_at: string;
  last_used_at: string | null;
  revoked: boolean;
};

type Staff = {
  id: string;
  name: string | null;
  email: string | null;
  staff_id: string | null;
  pin_set: boolean;
};

type Activation = {
  ok: boolean;
  code: string;
  expires_at: string;
  device_expires_at: string;
};

function DeviceAuthorisation() {
  const { organizationId, user } = useAuth();
  const { branches, activeBranchId } = useBranchScope();
  const [branch, setBranch] = useState(activeBranchId ?? "");
  const [label, setLabel] = useState("");
  const [activation, setActivation] = useState<Activation | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Staff | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  useEffect(() => {
    setActivation(null);
    setSelected(null);
    setPin("");
    setConfirmPin("");
    setBranch("");
  }, [organizationId, user?.id]);

  const devices = useQuery({
    queryKey: ["device-authorisations", organizationId, user?.id],
    enabled: Boolean(organizationId && user),
    retry: false,
    queryFn: async () => {
      const { data, error } = await guardedRpc<Device[]>(supabase, "neo_device_admin_list");
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const staff = useQuery({
    queryKey: ["device-admin-staff-pins", organizationId, user?.id, search],
    enabled: Boolean(organizationId && user && devices.isSuccess),
    retry: false,
    queryFn: async () => {
      const { data, error } = await guardedRpc<Staff[]>(supabase, "neo_staff_pin_admin", {
        _query: search,
      });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  async function issueActivation() {
    if (!branches.some((item) => item.id === branch)) {
      toast.error("Select a property from the available list.");
      return;
    }
    setBusy(true);
    setActivation(null);
    try {
      const { data, error } = await guardedRpc<Activation>(
        supabase,
        "neo_device_activation_issue",
        { _branch: branch, _label: label.trim() },
      );
      if (error) throw new Error(error.message);
      if (!data?.ok || !data.code || !data.expires_at) {
        throw new Error("The activation response was incomplete.");
      }
      setActivation(data);
      await devices.refetch();
      toast.success("One-use device activation code created.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: Device) {
    if (!window.confirm(`Revoke staff PIN access for ${device.label} at ${device.property}?`))
      return;
    setBusy(true);
    setActivation(null);
    try {
      const { error } = await guardedRpc(supabase, "neo_staff_login_device_revoke", {
        _device: device.id,
      });
      if (error) throw new Error(error.message);
      await devices.refetch();
      toast.success("Device authorisation revoked.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Revocation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function savePin(disable: boolean) {
    if (!selected) return;
    if (!disable && (!/^[0-9]{6}$/.test(pin) || pin !== confirmPin)) {
      toast.error("Enter and confirm the same six-digit personal PIN.");
      return;
    }
    if (
      disable &&
      !window.confirm(`Disable the personal PIN for ${selected.name ?? selected.email}?`)
    )
      return;
    setBusy(true);
    try {
      const { error } = await guardedRpc(supabase, "neo_staff_pin_admin", {
        _user: selected.id,
        _pin: disable ? null : pin,
        _disable: disable,
      });
      if (error) throw new Error(error.message);
      setSelected(null);
      await staff.refetch();
      toast.success(disable ? "Personal PIN disabled." : "Personal PIN updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "PIN update failed.");
    } finally {
      setPin("");
      setConfirmPin("");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4">
      <PageHeader
        title="Device Authorisation and Staff PINs"
        description="Owner and System Administrator controls. Authorise a property device while each employee retains their own identity, property assignments and permissions."
      />

      {devices.isLoading ? <LoadingState rows={2} /> : null}
      {devices.error ? (
        <ErrorState
          error={devices.error}
          title="Administrator access could not be confirmed"
          onRetry={() => void devices.refetch()}
        />
      ) : null}

      {devices.isSuccess ? (
        <>
          <SectionCard title="Authorise a property device">
            <p className="text-sm text-muted-foreground">
              Create a code here and enter it on the receiving device. Each property issues its own
              authorisation. Codes expire after ten minutes and can be used once.
            </p>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void issueActivation();
              }}
            >
              <label className="block space-y-2">
                <span>Property</span>
                <select
                  required
                  value={branch}
                  className="block w-full rounded-lg border bg-background p-3"
                  disabled={busy}
                  onChange={(event) => {
                    setBranch(event.target.value);
                    setActivation(null);
                  }}
                >
                  <option value="">Select property</option>
                  {branches.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-2">
                <span>Device name</span>
                <Input
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder="Reception tablet / staff terminal"
                  disabled={busy}
                  value={label}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setActivation(null);
                  }}
                />
              </label>
              <Button disabled={busy || !branch || label.trim().length < 2}>
                {busy ? "Working..." : "Create activation code"}
              </Button>
            </form>
            {activation ? (
              <div role="status" className="space-y-2 rounded-xl border p-4">
                <p className="font-semibold">Private one-use activation code</p>
                <code className="block select-all break-all rounded-lg bg-muted p-3">
                  {activation.code}
                </code>
                <p className="text-sm">
                  Use before {new Date(activation.expires_at).toLocaleString()}.
                </p>
                <p className="text-sm">
                  Device authorisation expires{" "}
                  {new Date(activation.device_expires_at).toLocaleString()}. It can be revoked
                  earlier below.
                </p>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Registered property devices">
            {!devices.data.length ? (
              <EmptyState title="No devices registered in your scope" />
            ) : null}
            {devices.data.map((device) => {
              const expired = Date.parse(device.expires_at) <= Date.now();
              return (
                <div
                  key={device.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                >
                  <div className="space-y-1">
                    <p className="font-semibold">{device.label}</p>
                    <p className="text-sm">{device.property}</p>
                    <p className="text-sm">
                      {device.revoked ? "Revoked" : expired ? "Expired" : "Authorised"}
                      {" · "}Last used:{" "}
                      {device.last_used_at
                        ? new Date(device.last_used_at).toLocaleString()
                        : "Not yet used"}
                    </p>
                  </div>
                  {!device.revoked && !expired ? (
                    <Button variant="outline" disabled={busy} onClick={() => void revoke(device)}>
                      Revoke authorisation
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </SectionCard>

          <SectionCard title="Personal staff PIN administration">
            <p className="text-sm text-muted-foreground">
              Search existing active staff. PIN changes are audited against your administrator
              account. Existing personal PINs are never displayed.
            </p>
            <form
              className="flex gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                setSelected(null);
                setPin("");
                setConfirmPin("");
                setSearch(draftSearch.trim());
              }}
            >
              <Input
                aria-label="Search staff"
                placeholder="Name, email or staff ID"
                value={draftSearch}
                maxLength={100}
                disabled={busy}
                onChange={(event) => setDraftSearch(event.target.value)}
              />
              <Button disabled={busy}>Search</Button>
            </form>
            {staff.isLoading ? <LoadingState rows={2} /> : null}
            {staff.error ? (
              <ErrorState
                error={staff.error}
                title="Staff could not be loaded"
                onRetry={() => void staff.refetch()}
              />
            ) : null}
            {staff.data?.length === 0 ? <EmptyState title="No matching active staff" /> : null}
            <div className="max-h-80 space-y-2 overflow-auto">
              {staff.data?.map((person) => (
                <button
                  type="button"
                  key={person.id}
                  disabled={busy}
                  aria-pressed={selected?.id === person.id}
                  className="block w-full rounded-lg border p-3 text-left hover:bg-muted"
                  onClick={() => {
                    setSelected(person);
                    setPin("");
                    setConfirmPin("");
                  }}
                >
                  <span className="block font-semibold">{person.name ?? "Staff member"}</span>
                  <span className="block text-sm">
                    {person.email} {person.staff_id ? ` · ${person.staff_id}` : ""}
                  </span>
                  <span className="block text-sm">
                    {person.pin_set ? "Personal PIN active" : "No active personal PIN"}
                  </span>
                </button>
              ))}
            </div>
            {selected ? (
              <form
                className="space-y-4 rounded-lg border p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void savePin(false);
                }}
              >
                <h3 className="font-semibold">
                  Personal PIN for {selected.name ?? selected.email}
                </h3>
                <label className="block space-y-2">
                  <span>New six-digit PIN</span>
                  <Input
                    required
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    disabled={busy}
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  />
                </label>
                <label className="block space-y-2">
                  <span>Confirm PIN</span>
                  <Input
                    required
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    disabled={busy}
                    value={confirmPin}
                    onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))}
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <Button disabled={busy || pin.length !== 6 || pin !== confirmPin}>
                    Save personal PIN
                  </Button>
                  {selected.pin_set ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void savePin(true)}
                    >
                      Disable personal PIN
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setSelected(null);
                      setPin("");
                      setConfirmPin("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
          </SectionCard>
        </>
      ) : null}
    </main>
  );
}
