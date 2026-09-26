import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { COMMUNICATION_CHANNELS, titleCase, useCommunications, useCustomers } from "@/lib/crm";
import { EmptyState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/crm/communications")({
  head: () => ({
    meta: [
      { title: "Customer Communications — Guest CRM" },
      {
        name: "description",
        content:
          "Centralised customer communication history across in-system, email, WhatsApp, SMS, phone and walk-in interactions.",
      },
      { property: "og:title", content: "Customer Communications — Guest CRM" },
      {
        property: "og:description",
        content: "Recorded guest communication history and consent enforcement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

/** Providers are configured by an administrator; nothing is ever simulated as sent. */
const PROVIDERS = [
  { channel: "email", provider: "Resend", status: "Not configured" },
  { channel: "whatsapp", provider: "WhatsApp Business API", status: "Not configured" },
  { channel: "sms", provider: "Africa's Talking", status: "Not configured" },
];

function Page() {
  const { profile, user } = useAuth();
  const { data: comms, refetch } = useCommunications();
  const customers = useCustomers();
  const [form, setForm] = useState({
    customerId: "",
    channel: "phone-call",
    direction: "outgoing",
    subject: "",
    summary: "",
    isMarketing: false,
  });

  async function record() {
    if (!profile?.organization_id || !form.customerId || !form.subject.trim()) return;
    const customer = (customers.data ?? []).find((c) => c.id === form.customerId);
    if (form.isMarketing && !customer?.marketing_consent) {
      toast.error("Blocked: this customer has not given marketing consent.");
      return;
    }
    const { error } = await supabase.from("customer_communications").insert({
      organization_id: profile.organization_id,
      customer_id: form.customerId,
      channel: form.channel,
      direction: form.direction,
      category: form.isMarketing ? "marketing" : "service",
      subject: form.subject.trim(),
      summary: form.summary.trim(),
      delivery_status: "logged",
      is_marketing: form.isMarketing,
      consent_verified: form.isMarketing ? Boolean(customer?.marketing_consent) : true,
      customer_visible: true,
      sender_user_id: user?.id ?? null,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.communication.record",
      module: "crm-communications",
      recordId: form.customerId,
      newValue: { channel: form.channel, marketing: form.isMarketing },
    });
    setForm({ ...form, subject: "", summary: "", isMarketing: false });
    void refetch();
    toast.success("Communication recorded");
  }

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="Communications"
        description="Manual logging is available for every channel. Outbound sending activates only after an administrator connects a messaging provider."
      />

      <SectionCard title="Channel configuration" className="mb-6">
        <ul className="grid gap-2 sm:grid-cols-3">
          {PROVIDERS.map((p) => (
            <li
              key={p.channel}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span>
                {titleCase(p.channel)}
                <span className="block text-xs text-muted-foreground">{p.provider}</span>
              </span>
              <StatusPill tone="warning">{p.status}</StatusPill>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          To enable sending, an administrator adds the provider API credentials as backend secrets;
          messages are then dispatched server-side. Keys are never placed in frontend code.
        </p>
      </SectionCard>

      <SectionCard title="Record a communication" className="mb-6">
        <div className="grid gap-3 md:grid-cols-4">
          <Select
            value={form.customerId}
            onValueChange={(v) => setForm({ ...form, customerId: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Customer" />
            </SelectTrigger>
            <SelectContent>
              {(customers.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={form.channel} onValueChange={(v) => setForm({ ...form, channel: v })}>
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
          <Select value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="outgoing">Outgoing</SelectItem>
              <SelectItem value="incoming">Incoming</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Subject"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </div>
        <Textarea
          className="mt-3"
          rows={2}
          placeholder="Message summary"
          value={form.summary}
          onChange={(e) => setForm({ ...form, summary: e.target.value })}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isMarketing}
              onChange={(e) => setForm({ ...form, isMarketing: e.target.checked })}
            />
            Marketing communication (consent enforced)
          </label>
          <Button onClick={record} disabled={!form.customerId || !form.subject.trim()}>
            Record
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Communication history">
        {!comms?.length ? (
          <EmptyState inline title="No communications recorded" description="No communications have been recorded yet." />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {comms.map((c) => {
              const row = c as unknown as {
                id: string;
                channel: string;
                subject: string;
                summary: string;
                direction: string;
                delivery_status: string;
                occurred_at: string;
                is_marketing: boolean;
                customers: { full_name: string } | null;
              };
              return (
                <li key={row.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">
                      {row.customers?.full_name ?? "Unlinked"} · {row.subject}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(row.channel)} · {titleCase(row.direction)} ·{" "}
                      {new Date(row.occurred_at).toLocaleString()}
                    </p>
                  </div>
                  <StatusPill tone={row.is_marketing ? "info" : "default"}>
                    {row.is_marketing ? "Marketing" : "Service"}
                  </StatusPill>
                </li>
              );
            })}
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
    <OpsGuard path="/crm/communications">
      <Page />
    </OpsGuard>
  );
}
