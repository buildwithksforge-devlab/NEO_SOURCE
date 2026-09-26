/**
 * Configuration e-mail reminder contract.
 *
 * The reminder must stay honest and narrow: one recommended next step from the
 * shared resolver, a capability gate, and a request action that can only ever
 * target the signed-in administrator's own address.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { nextEmailReadinessStep, resolveEmailReadiness } from "@/lib/email-readiness";

const widget = readFileSync("src/components/settings/EmailVerificationReminder.tsx", "utf8");
const settings = readFileSync("src/routes/_shell.settings.tsx", "utf8");

const connection = (over: Record<string, unknown> = {}) => ({
  provider: "postmark",
  display_name: "Postmark",
  channel: "email",
  status: "active",
  enabled: true,
  configuration: { sender_domain: "mail.example.com" },
  last_error: null,
  ...over,
});

describe("next recommended step", () => {
  it("asks for a provider first when none is connected", () => {
    const step = nextEmailReadinessStep(
      resolveEmailReadiness({ templatePresent: true, connections: [] }),
    );
    expect(step.title).toMatch(/provider/i);
    expect(step.external).toBe(true);
  });

  it("asks for a verified sending domain once a provider exists", () => {
    const step = nextEmailReadinessStep(
      resolveEmailReadiness({
        templatePresent: true,
        connections: [connection({ configuration: {} })],
      }),
    );
    expect(step.title).toMatch(/sending domain/i);
    expect(step.external).toBe(true);
  });

  it("never claims delivery is live once configuration is complete", () => {
    const step = nextEmailReadinessStep(
      resolveEmailReadiness({ templatePresent: true, connections: [connection()] }),
    );
    expect(step.title).toMatch(/confirm delivery/i);
    expect(step.external).toBe(false);
    expect(`${step.title} ${step.detail}`).not.toMatch(/delivered|guaranteed/i);
  });
});

describe("reminder widget guards", () => {
  it("is gated on the provider capability and hidden otherwise", () => {
    expect(widget).toContain('EMAIL_REMINDER_MODULE = "integrations"');
    expect(widget).toContain('EMAIL_REMINDER_CAPABILITY = "providers.edit"');
    expect(widget).toContain("if (!permitted) return null;");
  });

  it("can only request verification for the signed-in address", () => {
    expect(widget).toContain("const ownEmail = user?.email ?? null;");
    expect(widget).toContain('supabase.auth.resend({ type: "signup", email: ownEmail })');
    // No recipient input, no arbitrary address.
    expect(widget).not.toMatch(/<Input\b/);
  });

  it("reports a request, never a delivery", () => {
    expect(widget).toContain("cannot confirm delivery");
    // The success toast must speak of a request, not a delivered message.
    const toastLine = widget.split("\n").find((l) => l.includes("toast.success"));
    expect(toastLine).toBeTruthy();
    expect(widget).toContain("Verification e-mail requested for ${ownEmail}");
    expect(widget).not.toMatch(/toast\.success\([^)]*(sent|delivered)/i);
  });

  it("is shown on the Configuration landing beside the readiness checklist", () => {
    expect(settings).toContain("<EmailReadinessChecklist />");
    expect(settings).toContain("<EmailVerificationReminder />");
  });
});
