import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Mail, MessageCircle, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTenant } from "@/lib/tenant";
import { templateVariables, type CommunicationChannel } from "@/lib/tenant-types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/communication")({
  head: () => ({
    meta: [
      { title: "Customer Communication — System Administration" },
      {
        name: "description",
        content:
          "Brand WhatsApp, email and SMS templates for bookings, payments, reminders, deliveries and reviews.",
      },
      { property: "og:title", content: "Customer Communication — System Administration" },
      { property: "og:description", content: "Branded guest messaging templates per channel." },
    ],
  }),
  component: CommunicationPage,
});

const channelMeta: Record<CommunicationChannel, { label: string; icon: typeof Mail }> = {
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  email: { label: "Email", icon: Mail },
  sms: { label: "SMS", icon: Smartphone },
};

function CommunicationPage() {
  const { tenant, updateCommunicationTemplate } = useTenant();
  const [channel, setChannel] = useState<CommunicationChannel>("whatsapp");

  const templates = useMemo(
    () => tenant.communicationTemplates.filter((t) => t.channel === channel),
    [tenant.communicationTemplates, channel],
  );
  const [activeKey, setActiveKey] = useState(templates[0]?.key ?? "");
  const active = templates.find((t) => t.key === activeKey) ?? templates[0];

  const preview = (text: string) =>
    text
      .replaceAll("{{hotel_name}}", tenant.organization.name || "Your hotel")
      .replaceAll("{{branch_name}}", tenant.branches[0]?.name || "Main branch")
      .replaceAll("{{guest_name}}", "Amina Wanjiru")
      .replaceAll("{{booking_reference}}", "BK-10428")
      .replaceAll("{{check_in_date}}", "12/02/2026")
      .replaceAll("{{check_out_date}}", "15/02/2026")
      .replaceAll("{{amount}}", `${tenant.regional.currencySymbol} 24,500`);

  return (
    <div>
      <PageHeader
        eyebrow="Branding"
        title="Customer Communication"
        description="Every guest message carries your brand voice, logo and contact details."
        actions={
          <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Changes save automatically
          </span>
        }
      />

      <Tabs
        value={channel}
        onValueChange={(v) => {
          setChannel(v as CommunicationChannel);
          setActiveKey("");
        }}
      >
        <TabsList>
          {(Object.keys(channelMeta) as CommunicationChannel[]).map((c) => {
            const Icon = channelMeta[c].icon;
            return (
              <TabsTrigger key={c} value={c} className="gap-2">
                <Icon className="size-4" />
                {channelMeta[c].label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="mt-6 grid gap-6 lg:grid-cols-[230px_1fr]">
        <SectionCard title="Templates" description={`${templates.length} in this channel`}>
          <ul className="space-y-1">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setActiveKey(t.key)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    active?.key === t.key
                      ? "bg-primary-soft font-medium text-primary"
                      : "hover:bg-muted",
                  )}
                >
                  <span className="truncate">{t.name}</span>
                  {!t.enabled ? (
                    <span className="text-[0.6rem] uppercase text-muted-foreground">off</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>

        {active ? (
          <div className="space-y-6">
            <SectionCard
              title={active.name}
              description="Use variables to personalize each message"
              actions={
                <Switch
                  checked={active.enabled}
                  onCheckedChange={(v) => updateCommunicationTemplate(active.id, { enabled: v })}
                  aria-label="Enable template"
                />
              }
            >
              <div className="space-y-4">
                {channel === "email" ? (
                  <div className="space-y-2">
                    <Label>Subject line</Label>
                    <Input
                      value={active.subject}
                      onChange={(e) =>
                        updateCommunicationTemplate(active.id, { subject: e.target.value })
                      }
                    />
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label>Greeting</Label>
                  <Input
                    value={active.greeting}
                    onChange={(e) =>
                      updateCommunicationTemplate(active.id, { greeting: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Message body</Label>
                  <Textarea
                    rows={5}
                    value={active.body}
                    onChange={(e) => updateCommunicationTemplate(active.id, { body: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Signature</Label>
                  <Textarea
                    rows={2}
                    value={active.signature}
                    onChange={(e) =>
                      updateCommunicationTemplate(active.id, { signature: e.target.value })
                    }
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  {templateVariables.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        updateCommunicationTemplate(active.id, { body: `${active.body} ${v}` });
                        toast(`${v} inserted`);
                      }}
                      className="rounded-full border border-border px-2.5 py-1 font-mono text-xs hover:bg-muted"
                    >
                      {v}
                    </button>
                  ))}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["includeLogo", "Include logo"],
                      ["includeContact", "Include contact details"],
                      ["includeSocial", "Include social links"],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"
                    >
                      {label}
                      <Switch
                        checked={active[key]}
                        onCheckedChange={(v) => updateCommunicationTemplate(active.id, { [key]: v })}
                      />
                    </label>
                  ))}
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Preview" description="How the guest receives it">
              <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
                {active.includeLogo ? (
                  <div className="mb-3 flex items-center gap-2">
                    {tenant.brand.logoLight ? (
                      <img src={tenant.brand.logoLight} alt="" className="h-7 object-contain" />
                    ) : (
                      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
                        {tenant.brand.logoText}
                      </span>
                    )}
                    <span className="font-semibold">{tenant.organization.name || "Your hotel"}</span>
                  </div>
                ) : null}
                {channel === "email" && active.subject ? (
                  <p className="mb-2 font-semibold">{preview(active.subject)}</p>
                ) : null}
                <p>{preview(active.greeting)}</p>
                <p className="mt-2 whitespace-pre-line">{preview(active.body)}</p>
                <p className="mt-3 whitespace-pre-line text-muted-foreground">
                  {preview(active.signature)}
                </p>
                {active.includeContact ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {tenant.contact.phonePrimary} · {tenant.contact.email} · {tenant.contact.website}
                  </p>
                ) : null}
              </div>
            </SectionCard>
          </div>
        ) : null}
      </div>
    </div>
  );
}
