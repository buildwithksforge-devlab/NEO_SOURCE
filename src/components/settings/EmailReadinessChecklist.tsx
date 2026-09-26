import { PermittedLink } from "@/components/common/PermittedLink";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, Mail } from "lucide-react";

import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  resolveEmailReadiness,
  type EmailProviderConnection,
  type EmailReadinessTone,
} from "@/lib/email-readiness";
import type { Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * Authentication e-mail readiness, shown in the Configuration Centre.
 *
 * Exactly the same resolver the administration page uses, so the two surfaces
 * can never disagree. Nothing is reported as live: the card states what the
 * application can prove (the branded template) and what is still missing
 * (sender domain, provider), plus the one external step nobody in this app can
 * perform on the operator's behalf.
 */

const TONE: Record<EmailReadinessTone, Tone> = {
  ready: "success",
  pending: "warning",
  attention: "destructive",
};

const ICON: Record<EmailReadinessTone, typeof CheckCircle2> = {
  ready: CheckCircle2,
  pending: Clock,
  attention: AlertTriangle,
};

const ICON_CLASS: Record<EmailReadinessTone, string> = {
  ready: "text-success",
  pending: "text-warning",
  attention: "text-destructive",
};

export function EmailReadinessChecklist({ className }: { className?: string }) {
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

  const readiness = resolveEmailReadiness({ templatePresent: true, connections: data ?? [] });

  return (
    <SectionCard
      title="Email verification readiness"
      description="What sign-up and invitation e-mail can actually do in this workspace today."
      icon={Mail}
      className={cn(className)}
      actions={
        <div className="flex min-w-0 items-center gap-2">
          <StatusPill tone={TONE[readiness.overallTone]}>{readiness.overallLabel}</StatusPill>
          <Button asChild size="sm" variant="outline">
            <PermittedLink to="/admin/email-delivery">Open details</PermittedLink>
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="text-sm text-destructive">
          Provider records could not be read, so readiness cannot be reported.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Checking provider records…</p>
      ) : (
        <ul className="space-y-3">
          {readiness.checks.map((check) => {
            const Icon = ICON[check.tone];
            return (
              <li key={check.key} className="flex min-w-0 items-start gap-3">
                <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", ICON_CLASS[check.tone])} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {check.label} — {check.status}
                  </p>
                  <p className="text-xs text-muted-foreground">{check.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 border-t border-border/70 pt-3 text-xs text-muted-foreground">
        Remaining external step: verify a sending domain with your e-mail provider and record the
        connection. Until that exists, confirmation e-mail uses the platform default sender and
        delivery cannot be guaranteed by this application.
      </p>
    </SectionCard>
  );
}
