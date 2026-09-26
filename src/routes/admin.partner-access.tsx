import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";

export const Route = createFileRoute("/admin/partner-access")({
  head: () => ({
    meta: [
      { title: "Partner access — Configuration Centre" },
      {
        name: "description",
        content:
          "Give a supplier or corporate client's own contact person access to their private partner portal, and withdraw it again.",
      },
      { property: "og:title", content: "Partner access — Configuration Centre" },
      {
        property: "og:description",
        content: "Grant, suspend and withdraw partner portal access for the businesses you work with.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PartnerAccessPage,
});

const relationshipTypes = [
  { value: "supplier", label: "Supplier" },
  { value: "corporate_client", label: "Corporate client" },
  { value: "travel_agent", label: "Travel agent" },
  { value: "tour_operator", label: "Tour operator" },
  { value: "contractor", label: "Contractor" },
  { value: "service_provider", label: "Service provider" },
  { value: "event_partner", label: "Event partner" },
];

type AccessRow = {
  id: string;
  email: string;
  contact_name: string | null;
  relationship_type: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  supplier_name: string | null;
  corporate_name: string | null;
};

const rpc = supabase as unknown as {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

function PartnerAccessPage() {
  const { can } = useAuth();
  const canEdit = can("administration", "workspace", "edit");
  const branches = useBranches();
  const client = useQueryClient();
  const [branchId, setBranchId] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0]!.id);
  }, [branches.data, branchId]);

  const [party, setParty] = useState<"supplier" | "corporate">("supplier");
  const [partyId, setPartyId] = useState("");
  const [email, setEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [relationshipType, setRelationshipType] = useState("supplier");

  const suppliers = useQuery({
    queryKey: ["partner-access-suppliers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id, name")
        .order("name")
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const corporates = useQuery({
    queryKey: ["partner-access-corporates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("corporate_accounts")
        .select("id, legal_name, trading_name")
        .order("legal_name")
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; legal_name: string; trading_name: string | null }[];
    },
  });

  const list = useQuery({
    queryKey: ["partner-access-list", branchId],
    enabled: Boolean(branchId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(rpc, "neo_partner_access_list", { _branch: branchId });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as AccessRow[];
    },
  });

  const invite = useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(rpc, "neo_partner_invite", {
        _branch: branchId,
        _email: email.trim(),
        _relationship_type: relationshipType,
        _supplier: party === "supplier" ? partyId || null : null,
        _corporate: party === "corporate" ? partyId || null : null,
        _contact_name: contactName.trim() || null,
      });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; reason?: string; granted?: boolean };
    },
    onSuccess: (result) => {
      if (!result?.ok) {
        toast.error(refusal[result?.reason ?? ""] ?? "Could not grant partner access.");
        return;
      }
      toast.success(
        result.granted
          ? "Partner access granted — they can sign in now."
          : "Invitation recorded — access starts the first time they sign in with that email.",
      );
      setEmail("");
      setContactName("");
      void client.invalidateQueries({ queryKey: ["partner-access-list", branchId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setAccess = useMutation({
    mutationFn: async (input: { id: string; action: "revoke" | "suspend" | "restore" }) => {
      const { data, error } = await guardedRpc(rpc, "neo_partner_set_access", {
        _invitation: input.id,
        _action: input.action,
      });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; reason?: string };
    },
    onSuccess: (result) => {
      if (!result?.ok) {
        toast.error(refusal[result?.reason ?? ""] ?? "Could not change that access.");
        return;
      }
      toast.success("Partner access updated");
      void client.invalidateQueries({ queryKey: ["partner-access-list", branchId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const partyOptions = useMemo(
    () =>
      party === "supplier"
        ? (suppliers.data ?? []).map((s) => ({ id: s.id, label: s.name }))
        : (corporates.data ?? []).map((c) => ({ id: c.id, label: c.trading_name || c.legal_name })),
    [party, suppliers.data, corporates.data],
  );

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Business relationships"
        title="Partner access"
        description="Portal access is optional. Only businesses you deliberately invite here can open the partner portal, and they only ever see their own orders, deliveries, invoices and account."
      />

      {branches.data?.length ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {branches.data.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBranchId(b.id)}
              className={`rounded-full border px-4 py-1.5 text-xs font-medium ${
                b.id === branchId
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="space-y-4">
        <SectionCard
          title="Invite a business contact"
          description="Choose the business you already work with, then the person who should see its records."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Business type</Label>
              <div className="mt-2 flex gap-2">
                {(["supplier", "corporate"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setParty(value);
                      setPartyId("");
                      setRelationshipType(value === "supplier" ? "supplier" : "corporate_client");
                    }}
                    className={`rounded-full border px-3 py-1.5 text-xs ${
                      party === value ? "border-primary text-primary" : "border-border text-muted-foreground"
                    }`}
                  >
                    {value === "supplier" ? "Supplier" : "Corporate account"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="partner-business">Business</Label>
              <select
                id="partner-business"
                className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={partyId}
                onChange={(e) => setPartyId(e.target.value)}
              >
                <option value="">Select…</option>
                {partyOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="partner-relationship">Relationship</Label>
              <select
                id="partner-relationship"
                className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={relationshipType}
                onChange={(e) => setRelationshipType(e.target.value)}
              >
                {relationshipTypes.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="partner-email">Contact email</Label>
              <Input
                id="partner-email"
                type="email"
                className="mt-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@business.co.ke"
              />
            </div>

            <div>
              <Label htmlFor="partner-name">Contact name</Label>
              <Input
                id="partner-name"
                className="mt-2"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => invite.mutate()}
              disabled={!canEdit || !branchId || !partyId || !email.trim() || invite.isPending}
            >
              {invite.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Grant partner access
            </Button>
            {!canEdit ? (
              <p className="mt-2 text-xs text-muted-foreground">
                You can see this page but only an administrator may grant access.
              </p>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Who has access" description="Every grant, claim and withdrawal is recorded in the audit trail.">
          {list.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : (list.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No business has partner portal access at this property yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(list.data ?? []).map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {row.supplier_name ?? row.corporate_name ?? "—"} · {row.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.relationship_type} · {statusLabels[row.status] ?? row.status}
                      {row.accepted_at ? ` · active since ${new Date(row.accepted_at).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {row.status === "revoked" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canEdit || setAccess.isPending}
                        onClick={() => setAccess.mutate({ id: row.id, action: "restore" })}
                      >
                        Restore
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canEdit || setAccess.isPending}
                          onClick={() => setAccess.mutate({ id: row.id, action: "suspend" })}
                        >
                          Suspend
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!canEdit || setAccess.isPending}
                          onClick={() => setAccess.mutate({ id: row.id, action: "revoke" })}
                        >
                          Withdraw
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

const statusLabels: Record<string, string> = {
  pending: "Invited — waiting for first sign-in",
  accepted: "Active",
  revoked: "Withdrawn",
};

const refusal: Record<string, string> = {
  not_signed_in: "Please sign in again.",
  not_authorised: "Only an administrator of this hotel can grant partner access.",
  unknown_property: "That property is not available.",
  invalid_email: "Enter a valid email address.",
  no_business: "Choose the supplier or corporate account first.",
  supplier_not_yours: "That supplier does not belong to this hotel.",
  corporate_not_yours: "That corporate account does not belong to this hotel.",
  unknown_invitation: "That access record no longer exists.",
  invalid_action: "That action is not supported.",
};
