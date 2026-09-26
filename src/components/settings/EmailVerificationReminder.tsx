/**
 * Administrator reminder for authentication e-mail.
 *
 * Shows exactly one recommended next step, derived from the same readiness
 * resolver the checklist and the delivery page use, plus a single safe action:
 * request a verification e-mail **to the signed-in administrator's own
 * address**. The action is deliberately narrow — no arbitrary recipient, no
 * bulk send, no claim that anything was delivered. It reports only that the
 * request was accepted; whether the message arrives depends on the external
 * provider and sending domain.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MailCheck, Send } from "lucide-react";
import { toast } from "sonner";

import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  nextEmailReadinessStep,
  resolveEmailReadiness,
  type EmailProviderConnection,
} from "@/lib/email-readiness";
import { cn } from "@/lib/utils";

export const EMAIL_REMINDER_MODULE = "integrations";
export const EMAIL_REMINDER_CAPABILITY = "providers.edit";

export function EmailVerificationReminder({ className }: { className?: string }) {
  const { can, user } = useAuth();
  const permitted = can(EMAIL_REMINDER_MODULE, EMAIL_REMINDER_CAPABILITY);
  const [sending, setSending] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["email-provider-connections"],
    enabled: permitted,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("provider_connections")
        .select("provider, display_name, channel, status, enabled, configuration, last_error")
        .eq("channel", "email");
      if (error) throw error;
      return (data ?? []) as unknown as EmailProviderConnection[];
    },
  });

  // Configuration guidance is administrative: staff without provider authority
  // never see the reminder or the action.
  if (!permitted) return null;

  const readiness = resolveEmailReadiness({ templatePresent: true, connections: data ?? [] });
  const step = nextEmailReadinessStep(readiness);
  const ownEmail = user?.email ?? null;

  async function requestVerificationEmail() {
    // Backend-safe guard: the address is never taken from the UI, only from the
    // signed-in session, so this can never be used to mail a third party.
    if (!ownEmail) {
      toast.error("Your signed-in account has no e-mail address on file.");
      return;
    }
    setSending(true);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email: ownEmail });
      if (error) throw error;
      toast.success(
        `Verification e-mail requested for ${ownEmail}. Delivery depends on the configured sender — confirm it arrives.`,
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "The verification e-mail could not be requested.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <SectionCard
      title="Next step for e-mail verification"
      description="One recommended action at a time, based on what this workspace can actually prove."
      icon={MailCheck}
      className={cn(className)}
      actions={
        <StatusPill tone={step.external ? "warning" : "info"}>
          {step.external ? "External step" : "In-app step"}
        </StatusPill>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{step.title}</p>
          <p className="text-xs text-muted-foreground">{step.detail}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={sending || isLoading || !ownEmail}
          onClick={() => void requestVerificationEmail()}
          data-testid="request-verification-email"
        >
          <Send aria-hidden className="mr-2 size-4" />
          {sending ? "Requesting…" : "Request verification email"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        The request is sent to your own signed-in address
        {ownEmail ? ` (${ownEmail})` : ""} only. This application cannot confirm delivery.
      </p>
    </SectionCard>
  );
}
