/**
 * Administration → Email delivery readiness.
 *
 * Shows what the application can actually prove about authentication e-mail:
 * the branded template that ships with this build, and the recorded provider
 * and sending domain. It never reports a delivery as live or sent.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { supabase } from "@/integrations/supabase/client";
import {
  AUTH_EMAIL_TEMPLATE,
  resolveEmailReadiness,
  type EmailProviderConnection,
} from "@/lib/email-readiness";
import { AUTH_EMAIL_METADATA_KEYS } from "@/lib/auth-email-metadata";

export const Route = createFileRoute("/admin/email-delivery")({
  head: () => ({
    meta: [
      { title: "Email Delivery Readiness — NEØ Administration" },
      {
        name: "description",
        content:
          "Check the branded authentication email template, the recorded sending domain and the email provider connection before relying on delivery.",
      },
      { property: "og:title", content: "Email Delivery Readiness — NEØ Administration" },
      {
        property: "og:description",
        content: "Authentication email template, sender domain and provider readiness for this workspace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EmailDeliveryPage,
});

import type { Tone } from "@/lib/tone";
import { ErrorState } from "@/components/common/StateSystem";

const TONE: Record<"ready" | "pending" | "attention", Tone> = {
  ready: "success",
  pending: "warning",
  attention: "destructive",
};

function EmailDeliveryPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["email-provider-connections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("provider_connections")
        .select("provider, display_name, channel, status, enabled, configuration, last_error")
        .eq("channel", "email");
      if (error) throw error;
      return (data ?? []) as unknown as EmailProviderConnection[];
    },
  });

  const readiness = resolveEmailReadiness({
    templatePresent: true,
    connections: data ?? [],
  });

  return (
    <OpsGuard path="/admin/email-delivery">
      <div className="space-y-6">
        <PageHeader
          title="Email delivery readiness"
          description="What this workspace can prove about authentication email today. Delivery is only reported once a provider and sending domain exist."
          icon={Mail}
        />

        <SectionCard title="Overall state">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Checking provider records…</p>
          ) : error ? (
            <ErrorState title="Provider readiness could not be loaded" error={error} inline />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone={TONE[readiness.overallTone]}>{readiness.overallLabel}</StatusPill>
              <p className="text-sm text-muted-foreground">
                {readiness.overall === "ready_to_send"
                  ? "Template, sending domain and provider are all recorded."
                  : "Confirmation emails currently fall back to the platform default sender."}
              </p>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Checks">
          <ul className="space-y-4">
            {readiness.checks.map((check) => (
              <li key={check.key} className="rounded-lg border border-border/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{check.label}</span>
                  <StatusPill tone={TONE[check.tone]}>{check.status}</StatusPill>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{check.detail}</p>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard
          title="Template contract"
          description="Personalisation supplied by every account-creation path. Missing values degrade gracefully in the template."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Files</p>
              <p className="mt-1 text-sm">{AUTH_EMAIL_TEMPLATE.htmlPath}</p>
              <p className="text-sm">{AUTH_EMAIL_TEMPLATE.textPath}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Metadata keys</p>
              <p className="mt-1 text-sm">{AUTH_EMAIL_METADATA_KEYS.join(", ")}</p>
            </div>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Remaining external step: the hosted confirmation template must be pasted once into the project's
            auth email configuration after a verified sending domain exists. Nothing in this application can
            complete that step for you.
          </p>
        </SectionCard>
      </div>
    </OpsGuard>
  );
}
