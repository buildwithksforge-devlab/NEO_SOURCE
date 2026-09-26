import { guardedRpc } from "@/lib/rpc-guard";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Crown, ShieldAlert, Link2, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { FolioIdentityLine } from "@/components/pms/FolioIdentitySummary";
import { GuestDocuments } from "@/components/crm/GuestDocuments";
import { CustomerAccount } from "@/components/crm/CustomerAccount";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  COMMUNICATION_CHANNELS,
  CONSENT_TYPES,
  PREFERENCE_CATEGORIES,
  recordTimelineEvent,
  titleCase,
  useCustomer,
  useCustomerChildren,
  useInvalidateCrm,
  type PreferenceCategory,
} from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/customers/$id")({
  head: () => ({
    meta: [
      { title: "Customer Profile — Guest CRM" },
      {
        name: "description",
        content:
          "A 360-degree guest profile: preferences, loyalty, communications, feedback, consent and timeline.",
      },
      { property: "og:title", content: "Customer Profile — Guest CRM" },
      { property: "og:description", content: "The unified hospitality guest profile." },
      { property: "og:type", content: "profile" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const TABS = [
  "overview",
  "contact",
  "stays",
  "orders",
  "spending",
  "billing",
  "preferences",
  "loyalty",
  "communications",
  "feedback",
  "digital",
  "timeline",
  "notes",
  "identity",
  "documents",
  "privacy",
] as const;


function Awaiting({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Page() {
  const { id } = Route.useParams();
  const { profile, user, isAdmin, can } = useAuth();
  const invalidate = useInvalidateCrm();
  const { data: customer, isLoading } = useCustomer(id);

  const prefs = useCustomerChildren<Record<string, string | boolean>>("customer_preferences", id);
  const notes = useCustomerChildren<Record<string, string>>("customer_notes", id);
  const comms = useCustomerChildren<Record<string, string>>(
    "customer_communications",
    id,
    "occurred_at",
  );
  const feedback = useCustomerChildren<Record<string, string>>(
    "customer_feedback",
    id,
    "received_at",
  );
  const timeline = useCustomerChildren<Record<string, string>>(
    "customer_timeline_events",
    id,
    "occurred_at",
  );
  const consents = useCustomerChildren<Record<string, string | boolean>>(
    "customer_consents",
    id,
    "effective_at",
  );
  const identifiers = useCustomerChildren<Record<string, string>>("customer_identifiers", id);
  const loyalty = useCustomerChildren<Record<string, string | number>>("loyalty_accounts", id);
  const ledger = useCustomerChildren<Record<string, string | number>>("loyalty_transactions", id);
  const history = useQuery({
    queryKey: ["crm", "customer-360", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_customer_360", { _customer: id });
      if (error) throw error;
      return data as unknown as Record<string, never[] | Record<string, number | string>>;
    },
  });
  const stays = (history.data?.["stays"] as Record<string, string | number>[] | undefined) ?? [];
  const txns =
    (history.data?.["transactions"] as Record<string, string | number>[] | undefined) ?? [];
  const spendAreas =
    (history.data?.["spend_by_area"] as Record<string, string | number>[] | undefined) ?? [];
  const folioList =
    (history.data?.["folios"] as Record<string, string | number>[] | undefined) ?? [];
  const totals = (history.data?.["totals"] as Record<string, string | number> | undefined) ?? {};
  // One person, every way they have transacted: restaurant, delivery, laundry
  // and the receipts raised against them. All referenced, never duplicated.
  const restaurantOrders =
    (history.data?.["restaurant_orders"] as Record<string, string | number>[] | undefined) ?? [];
  const deliveryOrders =
    (history.data?.["delivery_orders"] as Record<string, string | number>[] | undefined) ?? [];
  const laundryOrders =
    (history.data?.["laundry_orders"] as Record<string, string | number>[] | undefined) ?? [];
  const receipts =
    (history.data?.["receipts"] as Record<string, string | number>[] | undefined) ?? [];

  const canEdit = can("crm-customers", "edit");
  const canIdentity = can("crm-identity", "view");

  const [prefForm, setPrefForm] = useState({
    category: "accommodation" as PreferenceCategory,
    preference_key: "Preferred room type",
    preference_value: "",
    is_critical: false,
  });
  const [noteBody, setNoteBody] = useState("");
  const [comm, setComm] = useState({ channel: "phone-call", subject: "", summary: "" });
  const guestAccountLabel = customer?.auth_user_id
    ? "Active"
    : customer?.guest_account_status === "invited"
      ? "Invited"
      : customer?.guest_account_status === "suspended"
        ? "Suspended"
        : "No account";

  async function toggleVip() {
    if (!customer || !profile) return;
    const next = !customer.is_vip;
    const { error } = await supabase.from("customers").update({ is_vip: next }).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.customer.vip_change",
      module: "crm-customers",
      recordId: id,
      previousValue: { is_vip: customer.is_vip },
      newValue: { is_vip: next },
    });
    await recordTimelineEvent({
      organizationId: profile.organization_id,
      customerId: id,
      eventType: "vip-status-changed",
      description: next ? "Marked as VIP" : "VIP status removed",
      staffUserId: user?.id ?? null,
    });
    invalidate();
    toast.success(next ? "Marked as VIP" : "VIP status removed");
  }

  async function addPreference() {
    if (!profile || !prefForm.preference_value.trim()) return;
    const { error } = await supabase.from("customer_preferences").insert({
      organization_id: profile.organization_id,
      customer_id: id,
      category: prefForm.category,
      preference_key: prefForm.preference_key,
      preference_value: prefForm.preference_value.trim(),
      is_critical: prefForm.is_critical,
      source: "staff-entry",
      recorded_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await recordTimelineEvent({
      organizationId: profile.organization_id,
      customerId: id,
      eventType: "preference-updated",
      description: `${prefForm.preference_key}: ${prefForm.preference_value}`,
      staffUserId: user?.id ?? null,
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.preference.create",
      module: "crm-preferences",
      recordId: id,
      newValue: prefForm,
    });
    setPrefForm({ ...prefForm, preference_value: "", is_critical: false });
    void prefs.refetch();
    toast.success("Preference recorded");
  }

  async function addNote() {
    if (!profile || !noteBody.trim()) return;
    const { error } = await supabase.from("customer_notes").insert({
      organization_id: profile.organization_id,
      customer_id: id,
      body: noteBody.trim(),
      is_internal: true,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setNoteBody("");
    void notes.refetch();
    toast.success("Internal note added — never visible to the customer");
  }

  async function logCommunication() {
    if (!profile || !comm.subject.trim()) return;
    const { error } = await supabase.from("customer_communications").insert({
      organization_id: profile.organization_id,
      customer_id: id,
      channel: comm.channel,
      direction: "outgoing",
      category: "service",
      subject: comm.subject.trim(),
      summary: comm.summary.trim(),
      delivery_status: "logged",
      is_marketing: false,
      consent_verified: true,
      customer_visible: true,
      sender_user_id: user?.id ?? null,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await recordTimelineEvent({
      organizationId: profile.organization_id,
      customerId: id,
      eventType: "communication-logged",
      description: `${titleCase(comm.channel)} — ${comm.subject}`,
      staffUserId: user?.id ?? null,
      customerVisible: true,
    });
    setComm({ channel: "phone-call", subject: "", summary: "" });
    void comms.refetch();
    toast.success("Communication recorded");
  }

  async function recordConsent(type: string, granted: boolean) {
    if (!profile) return;
    const { error } = await supabase.from("customer_consents").insert({
      organization_id: profile.organization_id,
      customer_id: id,
      consent_type: type,
      granted,
      consent_source: "staff-entry",
      consent_wording: `Consent for ${titleCase(type)} recorded by staff.`,
      recorded_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    if (type === "email-marketing") {
      await supabase.from("customers").update({ marketing_consent: granted }).eq("id", id);
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.consent.change",
      module: "crm-customers",
      recordId: id,
      newValue: { type, granted },
    });
    void consents.refetch();
    invalidate();
    toast.success("Consent history updated");
  }

  async function inviteToGuestApp() {
    if (!customer) return;
    const { error } = await (
      supabase as unknown as {
        rpc: (
          n: string,
          a: Record<string, unknown>,
        ) => Promise<{ error: { message: string } | null }>;
      }
    ).rpc("neo_customer_invite_guest", {
      _customer: id,
      _reason: "Invited to the NEØ Guest app from CRM",
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    invalidate();
    toast.success(
      "Guest app invitation recorded. The guest links to this same profile on sign-in.",
    );
  }

  if (isLoading) return <LoadingState variant="cards" rows={3} />;
  if (!customer)
    return (
      <SectionCard title="Customer not found">
        <p className="text-sm text-muted-foreground">
          This profile does not exist, or it belongs to another organisation.
        </p>
      </SectionCard>
    );

  const critical = prefs.data?.filter((p) => p["is_critical"]) ?? [];

  return (
    <div>
      <Button asChild size="sm" variant="ghost" className="mb-3">
        <Link to="/crm/customers">
          <ArrowLeft className="mr-2 size-4" /> Customer directory
        </Link>
      </Button>

      <PageHeader
        eyebrow={customer.customer_number}
        title={customer.full_name}
        description={`${titleCase(customer.customer_type)} · ${customer.city || "Location not recorded"}`}
        actions={
          canEdit ? (
            <Button size="sm" variant={customer.is_vip ? "default" : "outline"} onClick={toggleVip}>
              <Crown className="mr-2 size-4" /> {customer.is_vip ? "VIP guest" : "Mark VIP"}
            </Button>
          ) : null
        }
      />

      {critical.length ? (
        <div className="mb-6 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-on-tint-warning">
            <ShieldAlert className="size-4" /> Service-critical information
          </p>
          <ul className="mt-2 space-y-1 text-sm text-on-tint-warning">
            {critical.map((p, i) => (
              <li key={i}>
                {String(p["preference_key"])}: {String(p["preference_value"])}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList className="flex flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {titleCase(t)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-4 grid gap-6 lg:grid-cols-2">
          <SectionCard title="Customer summary">
            <dl className="grid gap-2 text-sm">
              <Row label="Customer ID" value={customer.customer_number} />
              <Row label="Preferred name" value={customer.preferred_name || "—"} />
              <Row label="Type" value={titleCase(customer.customer_type)} />
              <Row label="Nationality" value={customer.nationality || "—"} />
              <Row label="Birthday" value={customer.date_of_birth ?? "Not recorded"} />
              <Row label="Anniversary" value={customer.anniversary_date ?? "Not recorded"} />
              <Row
                label="Last interaction"
                value={
                  customer.last_interaction_at
                    ? new Date(customer.last_interaction_at).toLocaleString()
                    : "No recorded interaction"
                }
              />
              <Row label="Account status" value={titleCase(customer.account_status)} />
              <Row label="Guest account" value={guestAccountLabel} />
              <Row
                label="Last guest app activity"
                value={
                  customer.last_guest_app_activity_at
                    ? new Date(String(customer.last_guest_app_activity_at)).toLocaleString()
                    : "No recorded activity"
                }
              />
            </dl>
          </SectionCard>
          <SectionCard
            title="Recorded activity"
            description="Values appear once the source modules record real data."
          >
            <dl className="grid gap-2 text-sm">
              <Row
                label="Open complaints"
                value={String(
                  (feedback.data ?? []).filter(
                    (f) => !["resolved", "closed"].includes(String(f["status"])),
                  ).length,
                )}
              />
              <Row label="Recorded communications" value={String(comms.data?.length ?? 0)} />
              <Row label="Recorded preferences" value={String(prefs.data?.length ?? 0)} />
              <Row label="Loyalty accounts" value={String(loyalty.data?.length ?? 0)} />
              <Row
                label="Total recorded spend"
                value={Number(totals["charges"] ?? 0).toLocaleString()}
              />
              <Row
                label="Stays recorded"
                value={`${Number(totals["stays"] ?? 0)} stay(s) · ${Number(totals["nights"] ?? 0)} night(s)`}
              />
            </dl>
          </SectionCard>
        </TabsContent>

        <TabsContent value="contact" className="mt-4">
          <SectionCard title="Contact details">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Row label="Phone" value={customer.phone || "—"} />
              <Row label="Alternative phone" value={customer.alt_phone || "—"} />
              <Row label="Email" value={customer.email || "—"} />
              <Row label="Address" value={customer.address || "—"} />
              <Row label="City" value={customer.city || "—"} />
              <Row label="Country" value={customer.country || "—"} />
              <Row label="Occupation" value={customer.occupation || "—"} />
              <Row label="Company" value={customer.company || "—"} />
              <Row label="Job title" value={customer.job_title || "—"} />
              <Row label="Preferred language" value={customer.preferred_language} />
            </dl>
          </SectionCard>

          <SectionCard
            className="mt-6"
            title="NEØ Guest account"
            description="A guest is linked to this existing profile through their verified email — never by name, and never by creating a second profile."
          >
            <p className="text-sm text-muted-foreground">
              Status: <span className="font-medium text-foreground">{guestAccountLabel}</span>
              {customer.guest_linked_at
                ? ` · linked ${new Date(String(customer.guest_linked_at)).toLocaleDateString()} (${String(customer.guest_link_method ?? "unknown method")})`
                : ""}
            </p>
            {!customer.auth_user_id ? (
              <div className="mt-3">
                <Button
                  onClick={() => void inviteToGuestApp()}
                  disabled={!canEdit || !customer.email}
                >
                  <Link2 className="mr-2 size-4" /> Invite to NEØ Guest
                </Button>
                {!customer.email ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    A verified email address is required before an invitation can be sent.
                  </p>
                ) : null}
              </div>
            ) : null}
          </SectionCard>
        </TabsContent>

        <TabsContent value="digital" className="mt-4">
          <GuestDigitalActivity customerId={id} />
        </TabsContent>

        <TabsContent value="stays" className="mt-4">
          <SectionCard
            title="Stay history"
            description="Sourced from Reservations and Front Office."
          >
            {stays.length ? (
              <div className="space-y-2 text-sm">
                {stays.map((s) => (
                  <div
                    key={String(s["id"])}
                    className="flex flex-wrap justify-between gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{String(s["confirmation_number"] ?? "—")}</span>
                    <span>
                      {String(s["arrival_date"])} → {String(s["departure_date"])}
                    </span>
                    <span>Room {String(s["room_number"] ?? "—")}</span>
                    <span>{titleCase(String(s["status"]))}</span>
                    <span className="tabular-nums">
                      {Number(s["total_amount"] ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>No stay has been recorded for this guest yet.</Awaiting>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="orders" className="mt-4 space-y-6">
          <SectionCard
            title="Everything this person has bought"
            description="Restaurant, delivery and laundry orders together with the receipts raised against them — all referenced from the source records."
          >
            <dl className="grid gap-2 text-sm sm:grid-cols-4">
              <Row label="Stays" value={String(Number(totals["stays"] ?? 0))} />
              <Row label="Orders" value={String(Number(totals["orders"] ?? 0))} />
              <Row label="Receipts" value={String(Number(totals["receipts"] ?? 0))} />
              <Row
                label="Receipted total"
                value={Number(totals["receipts_total"] ?? 0).toLocaleString()}
              />
            </dl>
          </SectionCard>

          <SectionCard title="Restaurant orders" description="Sourced from Point of Sale.">
            {restaurantOrders.length ? (
              <div className="space-y-2 text-sm">
                {restaurantOrders.map((o) => (
                  <div
                    key={String(o["id"])}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{String(o["order_number"] ?? "—")}</span>
                    <span>{new Date(String(o["date"])).toLocaleString()}</span>
                    <StatusPill tone="default">{titleCase(String(o["status"] ?? ""))}</StatusPill>
                    <span className="tabular-nums">
                      {Number(o["total"] ?? 0).toLocaleString()} · paid{" "}
                      {Number(o["paid"] ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>No restaurant order has been recorded for this guest yet.</Awaiting>
            )}
          </SectionCard>

          <SectionCard
            title="Delivery and room-service orders"
            description="Placed through the NEØ Guest app and matched to this person's verified identity."
          >
            {deliveryOrders.length ? (
              <div className="space-y-2 text-sm">
                {deliveryOrders.map((o) => (
                  <div
                    key={String(o["id"])}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{String(o["order_number"] ?? "—")}</span>
                    <span>{new Date(String(o["date"])).toLocaleString()}</span>
                    <span>{titleCase(String(o["fulfilment"] ?? ""))}</span>
                    <StatusPill tone="default">{titleCase(String(o["status"] ?? ""))}</StatusPill>
                    <span className="tabular-nums">
                      {Number(o["total"] ?? 0).toLocaleString()} ·{" "}
                      {titleCase(String(o["payment_status"] ?? ""))}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>
                {customer.auth_user_id
                  ? "No guest-app order has been placed by this person yet."
                  : "This profile is not yet linked to a NEØ Guest account, so no app orders can be matched to it."}
              </Awaiting>
            )}
          </SectionCard>

          <SectionCard title="Laundry orders" description="Sourced from Guest Services.">
            {laundryOrders.length ? (
              <div className="space-y-2 text-sm">
                {laundryOrders.map((o) => (
                  <div
                    key={String(o["id"])}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{String(o["laundry_number"] ?? "—")}</span>
                    <span>{new Date(String(o["date"])).toLocaleString()}</span>
                    <StatusPill tone="default">{titleCase(String(o["status"] ?? ""))}</StatusPill>
                    <span className="tabular-nums">{Number(o["total"] ?? 0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>No laundry order has been recorded for this guest yet.</Awaiting>
            )}
          </SectionCard>

          <SectionCard
            title="Receipts"
            description="Every receipt raised against this person, from the front office and the restaurant."
          >
            {receipts.length ? (
              <div className="space-y-2 text-sm">
                {receipts.map((r) => (
                  <div
                    key={String(r["id"])}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{String(r["receipt_number"] ?? "—")}</span>
                    <span>
                      {r["date"] ? new Date(String(r["date"])).toLocaleString() : "Not settled"}
                    </span>
                    <span>{titleCase(String(r["source"] ?? ""))}</span>
                    <span>{titleCase(String(r["method"] ?? ""))}</span>
                    <StatusPill tone="default">{titleCase(String(r["status"] ?? ""))}</StatusPill>
                    <span className="tabular-nums">{Number(r["amount"] ?? 0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>No receipt has been raised against this guest yet.</Awaiting>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="billing" className="mt-4">
          <CustomerAccount
            customerId={id}
            corporateAccountId={(customer.corporate_account_id as string | null) ?? null}
          />
        </TabsContent>

        <TabsContent value="spending" className="mt-4 space-y-6">

          <SectionCard
            title="Spend by area"
            description="Referenced from the source folios — the CRM never stores duplicate financial transactions."
          >
            {spendAreas.length ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {spendAreas.map((a) => (
                  <Row
                    key={String(a["area"])}
                    label={titleCase(String(a["area"]))}
                    value={Number(a["amount"] ?? 0).toLocaleString()}
                  />
                ))}
                <Row
                  label="Total charges"
                  value={Number(totals["charges"] ?? 0).toLocaleString()}
                />
                <Row
                  label="Open balance"
                  value={Number(totals["open_balance"] ?? 0).toLocaleString()}
                />
              </dl>
            ) : (
              <Awaiting>No charge has been posted for this guest yet.</Awaiting>
            )}
          </SectionCard>

          <SectionCard title="Folios">
            {folioList.length ? (
              <div className="space-y-2 text-sm">
                {folioList.map((f) => (
                  <div
                    key={String(f["id"])}
                    className="flex flex-wrap justify-between gap-2 rounded-md border p-3"
                  >
                    <span className="font-medium">{String(f["folio_number"] ?? "—")}</span>
                    <span>{titleCase(String(f["status"]))}</span>
                    <span className="tabular-nums">
                      Charges {Number(f["total_charges"] ?? 0).toLocaleString()} · Balance{" "}
                      {Number(f["balance"] ?? 0).toLocaleString()}
                    </span>
                    {/* The ledger row carries the same canonical identity the
                        folio page and the printed statement carry. */}
                    <div className="w-full">
                      <FolioIdentityLine folioId={String(f["id"])} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>No folio has been opened for this guest yet.</Awaiting>
            )}
          </SectionCard>

          <SectionCard title="Recent transactions">
            {txns.length ? (
              <div className="space-y-2 text-sm">
                {txns.slice(0, 25).map((t) => (
                  <div
                    key={String(t["id"])}
                    className="flex flex-wrap justify-between gap-2 rounded-md border p-3"
                  >
                    <span>{new Date(String(t["date"])).toLocaleString()}</span>
                    <span className="font-medium">
                      {String(t["description"] ?? titleCase(String(t["category"])))}
                    </span>
                    <span>{titleCase(String(t["source"] ?? t["category"] ?? ""))}</span>
                    <span className="tabular-nums">
                      {Number(t["amount"] ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Awaiting>No transaction has been recorded against this guest yet.</Awaiting>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="preferences" className="mt-4 space-y-6">
          <SectionCard title="Record a preference">
            <div className="grid gap-3 md:grid-cols-4">
              <Select
                value={prefForm.category}
                onValueChange={(v) =>
                  setPrefForm({
                    ...prefForm,
                    category: v as PreferenceCategory,
                    preference_key: PREFERENCE_CATEGORIES[v as PreferenceCategory][0] ?? "",
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(PREFERENCE_CATEGORIES).map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={prefForm.preference_key}
                onValueChange={(v) => setPrefForm({ ...prefForm, preference_key: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PREFERENCE_CATEGORIES[prefForm.category].map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Value"
                value={prefForm.preference_value}
                onChange={(e) => setPrefForm({ ...prefForm, preference_value: e.target.value })}
              />
              <Button onClick={addPreference} disabled={!canEdit}>
                <Plus className="mr-2 size-4" /> Add
              </Button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefForm.is_critical}
                onChange={(e) => setPrefForm({ ...prefForm, is_critical: e.target.checked })}
              />
              Service-critical (allergy, dietary or accessibility need) — shown prominently to
              serving staff
            </label>
          </SectionCard>

          <SectionCard title="Recorded preferences">
            {!prefs.data?.length ? (
              <Awaiting>No preferences recorded yet.</Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {prefs.data.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="font-medium">
                        {String(p["preference_key"])}: {String(p["preference_value"])}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {titleCase(String(p["category"]))} · source {String(p["source"])}
                      </p>
                    </div>
                    {p["is_critical"] ? <StatusPill tone="warning">Critical</StatusPill> : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="loyalty" className="mt-4 space-y-6">
          <SectionCard title="Loyalty membership">
            {!loyalty.data?.length ? (
              <Awaiting>
                This customer is not enrolled. Enrol members from the Loyalty & Rewards screen.
              </Awaiting>
            ) : (
              <ul className="space-y-2 text-sm">
                {loyalty.data.map((l, i) => (
                  <li key={i} className="rounded-lg border border-border p-3">
                    <p className="font-medium">Membership {String(l["membership_number"])}</p>
                    <p className="text-muted-foreground">
                      Available {String(l["points_available"])} pts · earned{" "}
                      {String(l["points_earned"])} · redeemed {String(l["points_redeemed"])}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard
            title="Points ledger"
            description="Every movement is an immutable ledger entry."
          >
            {!ledger.data?.length ? (
              <Awaiting>No loyalty transactions recorded.</Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {ledger.data.map((t, i) => (
                  <li key={i} className="flex justify-between py-2">
                    <span>
                      {titleCase(String(t["transaction_type"]))} · {String(t["reason"] ?? "")}
                    </span>
                    <span className="font-medium">{String(t["points"])} pts</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="communications" className="mt-4 space-y-6">
          <SectionCard
            title="Record a communication"
            description="Phone calls and walk-in conversations can be logged manually. External providers are not connected, so nothing is sent."
          >
            <div className="grid gap-3 md:grid-cols-4">
              <Select value={comm.channel} onValueChange={(v) => setComm({ ...comm, channel: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMUNICATION_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Subject"
                value={comm.subject}
                onChange={(e) => setComm({ ...comm, subject: e.target.value })}
              />
              <Input
                placeholder="Summary"
                value={comm.summary}
                onChange={(e) => setComm({ ...comm, summary: e.target.value })}
              />
              <Button onClick={logCommunication}>Log</Button>
            </div>
          </SectionCard>
          <SectionCard title="Communication history">
            {!comms.data?.length ? (
              <Awaiting>No communications recorded.</Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {comms.data.map((c, i) => (
                  <li key={i} className="py-2">
                    <p className="font-medium">
                      {titleCase(String(c["channel"]))} · {String(c["subject"])}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(String(c["occurred_at"])).toLocaleString()} ·{" "}
                      {titleCase(String(c["delivery_status"]))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="feedback" className="mt-4">
          <SectionCard title="Feedback & complaints">
            {!feedback.data?.length ? (
              <Awaiting>
                No feedback recorded. Cases can be raised from the Feedback & Complaints screen.
              </Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {feedback.data.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="font-medium">{String(f["subject"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {String(f["reference"])} · {titleCase(String(f["feedback_type"]))}
                      </p>
                    </div>
                    <StatusPill tone="info">{titleCase(String(f["status"]))}</StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <SectionCard title="Guest timeline" description="Generated from recorded CRM events.">
            {!timeline.data?.length ? (
              <Awaiting>No timeline events yet.</Awaiting>
            ) : (
              <ol className="space-y-3 border-l border-border pl-4 text-sm">
                {timeline.data.map((t, i) => (
                  <li key={i} className="relative">
                    <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary" />
                    <p className="font-medium">{titleCase(String(t["event_type"]))}</p>
                    <p className="text-muted-foreground">{String(t["description"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(String(t["occurred_at"])).toLocaleString()} ·{" "}
                      {String(t["source_module"])}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="notes" className="mt-4 space-y-6">
          <SectionCard title="Add internal note">
            <Textarea
              rows={3}
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Internal notes are never shown to the customer."
            />
            <Button className="mt-3" onClick={addNote} disabled={!noteBody.trim()}>
              Save note
            </Button>
          </SectionCard>
          <SectionCard title="Internal notes">
            {!notes.data?.length ? (
              <Awaiting>No notes recorded.</Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {notes.data.map((n, i) => (
                  <li key={i} className="py-2">
                    <p>{String(n["body"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(String(n["created_at"])).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="identity" className="mt-4">
          <SectionCard
            title="Restricted identity section"
            description="Document numbers are stored masked and are limited to authorised Front Office and management roles."
          >
            {!canIdentity ? (
              <Awaiting>
                You do not have permission to view identity documents for this customer.
              </Awaiting>
            ) : !identifiers.data?.length ? (
              <Awaiting>No identity documents recorded.</Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {identifiers.data.map((d, i) => (
                  <li key={i} className="flex justify-between py-2">
                    <span>
                      {titleCase(String(d["document_type"]))} · {String(d["masked_number"])}
                    </span>
                    <StatusPill
                      tone={d["verification_status"] === "verified" ? "success" : "default"}
                    >
                      {titleCase(String(d["verification_status"]))}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          <GuestDocuments customerId={id} />
        </TabsContent>



        <TabsContent value="privacy" className="mt-4 space-y-6">
          <SectionCard
            title="Consent management"
            description="Consent history is appended, never overwritten. Essential service messages stay separate from marketing."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {CONSENT_TYPES.map((t) => (
                <div
                  key={t}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span>{titleCase(t)}</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => recordConsent(t, true)}>
                      Grant
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => recordConsent(t, false)}>
                      Withdraw
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Consent history">
            {!consents.data?.length ? (
              <Awaiting>No consent records yet.</Awaiting>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {consents.data.map((c, i) => (
                  <li key={i} className="flex justify-between py-2">
                    <span>{titleCase(String(c["consent_type"]))}</span>
                    <StatusPill tone={c["granted"] ? "success" : "destructive"}>
                      {c["granted"] ? "Granted" : "Withdrawn"} ·{" "}
                      {new Date(String(c["effective_at"])).toLocaleDateString()}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

type DigitalSummary = {
  account_status: string | null;
  linked_at: string | null;
  last_activity_at: string | null;
  event_count: number;
  recent_events: {
    event_type: string;
    surface: string | null;
    subject_id: string | null;
    occurred_at: string;
  }[];
  app_orders: {
    id: string;
    order_number: string;
    fulfilment_type: string;
    order_status: string;
    grand_total: number;
    created_at: string;
  }[];
  stays: {
    id: string;
    confirmation_number: string;
    status: string;
    arrival_date: string;
    departure_date: string;
  }[];
  service_requests: { id: string; category: string; status: string; created_at: string }[];
  transport_requests: { id: string; request_number: string; status: string; pickup_at: string }[];
  favourites: { menu_item: string }[];
  consents: { consent_type: string; granted: boolean; effective_at: string }[];
};

/**
 * Factual Guest-app activity for this customer, read through a scoped routine
 * that re-checks the caller's tenant, branch and CRM permission. Nothing here
 * is derived or modelled — every figure is a count of canonical records.
 */
function GuestDigitalActivity({ customerId }: { customerId: string }) {
  const query = useQuery({
    queryKey: ["crm-digital-summary", customerId],
    queryFn: async () => {
      const { data, error } = await (
        supabase as unknown as {
          rpc: (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: { message: string } | null }>;
        }
      ).rpc("neo_customer_digital_summary", { _customer: customerId });
      if (error) throw new Error(error.message);
      return data as DigitalSummary;
    },
  });

  if (query.isLoading) return <LoadingState variant="rows" rows={3} />;
  if (query.error) {
    return <ErrorState error={query.error} inline />;
  }
  const d = query.data;
  if (!d) return <Awaiting>No guest activity recorded.</Awaiting>;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SectionCard title="Guest app account" description="Status of this guest's own NEØ account.">
        <dl className="grid gap-2 text-sm">
          <Row label="Account" value={d.account_status ?? "Not linked"} />
          <Row label="Linked" value={d.linked_at ? new Date(d.linked_at).toLocaleString() : "—"} />
          <Row
            label="Last activity"
            value={d.last_activity_at ? new Date(d.last_activity_at).toLocaleString() : "—"}
          />
          <Row label="Recorded events" value={String(d.event_count)} />
          <Row label="Saved favourites" value={String(d.favourites.length)} />
        </dl>
      </SectionCard>

      <SectionCard
        title="Recent activity"
        description="The last screens and actions the guest recorded."
      >
        {d.recent_events.length === 0 ? (
          <Awaiting>No app activity recorded.</Awaiting>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.recent_events.map((e, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {e.event_type}
                  {e.subject_id ? ` · ${e.subject_id}` : ""}
                </span>
                <span className="text-muted-foreground">
                  {new Date(e.occurred_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Guest-app orders"
        description="Room service, collection and delivery placed by the guest."
      >
        {d.app_orders.length === 0 ? (
          <Awaiting>No orders placed from the guest app.</Awaiting>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.app_orders.map((o) => (
              <li key={o.id} className="flex justify-between gap-3">
                <span>
                  {o.order_number} · {o.fulfilment_type}
                </span>
                <StatusPill>{o.order_status}</StatusPill>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Stays" description="Canonical reservations for this guest.">
        {d.stays.length === 0 ? (
          <Awaiting>No reservations on record.</Awaiting>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.stays.map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span>{r.confirmation_number}</span>
                <span className="text-muted-foreground">
                  {r.arrival_date} → {r.departure_date} · {r.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Service requests">
        {d.service_requests.length === 0 ? (
          <Awaiting>No service requests raised.</Awaiting>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.service_requests.map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span>{r.category}</span>
                <StatusPill>{r.status}</StatusPill>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Transfers">
        {d.transport_requests.length === 0 ? (
          <Awaiting>No transfers requested.</Awaiting>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.transport_requests.map((t) => (
              <li key={t.id} className="flex justify-between gap-3">
                <span>{t.request_number}</span>
                <span className="text-muted-foreground">
                  {t.pickup_at ? new Date(t.pickup_at).toLocaleString() : "—"} · {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Consent" description="As recorded against this guest.">
        {d.consents.length === 0 ? (
          <Awaiting>No consent records.</Awaiting>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.consents.map((c, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{c.consent_type}</span>
                <StatusPill>{c.granted ? "Granted" : "Withdrawn"}</StatusPill>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/customers">
      <Page />
    </OpsGuard>
  );
}
