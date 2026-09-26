import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/marketing/MarketingShared";
import { useMessageTemplates } from "@/lib/marketing-data";
import { TEMPLATE_VARIABLES, invalidVariables, renderPreview, titleCase } from "@/lib/marketing";

export const Route = createFileRoute("/_shell/marketing/templates")({
  head: () => ({
    meta: [
      { title: "Message Templates — Marketing & CRM" },
      {
        name: "description",
        content:
          "Approved, versioned message templates with a strict variable whitelist and live preview.",
      },
      { property: "og:title", content: "Message Templates — Marketing & CRM" },
      {
        property: "og:description",
        content: "Versioned templates with whitelisted personalisation variables.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const [channel, setChannel] = useState("all");
  const { data: templates, isLoading } = useMessageTemplates(
    channel === "all" ? undefined : channel,
  );
  const [draft, setDraft] = useState(
    "Hi {{preferred_name}}, we have a new offer at {{organization_name}}.",
  );
  const bad = invalidVariables(draft);

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Message Templates"
        description="Templates are shared with the Phase 6 communication engine, so a template approved here is the same one used by transactional and journey messages. Only whitelisted variables are substituted — anything else is left untouched rather than guessed."
      />

      <div className="mb-4 w-56">
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {["email", "sms", "whatsapp", "push", "in_app"].map((c) => (
              <SelectItem key={c} value={c}>
                {titleCase(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard title="Templates" description="Ordered by name." className="lg:col-span-2">
          {isLoading ? (
            <LoadingState variant="rows" rows={5} />
          ) : !templates?.length ? (
            <EmptyState
              icon={MessageSquare}
              title="No templates for this channel"
              description="Templates created in Automation → Message Templates appear here too."
            />
          ) : (
            <ul className="space-y-2">
              {(templates as Row[]).map((t) => (
                <li key={String(t["id"])} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-foreground">{String(t["name"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {titleCase(String(t["channel"]))}
                        {t["language"] ? ` · ${String(t["language"]).toUpperCase()}` : ""}
                        {t["version"] ? ` · v${String(t["version"])}` : ""}
                      </p>
                    </div>
                    <StatusPill tone={t["is_active"] === false ? "default" : "success"}>
                      {t["is_active"] === false ? "Inactive" : "Active"}
                    </StatusPill>
                  </div>
                  {t["body"] ? (
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                      {String(t["body"])}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="space-y-6">
          <SectionCard
            title="Variable whitelist"
            description="Anything outside this list is never substituted."
          >
            <ul className="space-y-1.5 text-sm">
              {TEMPLATE_VARIABLES.map((v) => (
                <li key={v.token} className="flex items-baseline justify-between gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{v.token}</code>
                  <span className="text-xs text-muted-foreground">{v.label}</span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Preview sandbox"
            description="Check a draft before saving it as a template."
          >
            <Textarea rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} />
            {bad.length ? (
              <p className="mt-2 text-xs text-destructive">
                Unsupported variables: {bad.join(", ")}
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">All variables are supported.</p>
            )}
            <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
              {renderPreview(draft, { preferred_name: "Amina", organization_name: "your hotel" })}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/templates">
      <Page />
    </OpsGuard>
  );
}
