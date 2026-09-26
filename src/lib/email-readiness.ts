/**
 * Authentication e-mail readiness.
 *
 * The application can prove exactly two things by itself: that the branded
 * template exists in this build, and whether an e-mail provider connection has
 * been recorded for the workspace. Actual delivery depends on an external
 * verified sending domain, so this resolver never reports "live", "sent" or
 * any success state that has not been observed.
 */

export type EmailReadinessTone = "ready" | "pending" | "attention";

export type EmailReadinessCheck = {
  key: "template" | "sender_domain" | "provider";
  label: string;
  status: string;
  tone: EmailReadinessTone;
  detail: string;
};

export type EmailProviderConnection = {
  provider: string | null;
  display_name: string | null;
  channel: string | null;
  status: string | null;
  enabled: boolean | null;
  configuration: Record<string, unknown> | null;
  last_error: string | null;
};

export type EmailReadiness = {
  checks: EmailReadinessCheck[];
  overall: "ready_to_send" | "provider_missing" | "domain_missing" | "template_missing";
  overallLabel: string;
  overallTone: EmailReadinessTone;
};

/** The branded confirmation template shipped in this build. */
export const AUTH_EMAIL_TEMPLATE = {
  name: "Confirm signup",
  htmlPath: "emails/auth/confirm-signup.html",
  textPath: "emails/auth/confirm-signup.txt",
  variables: [
    ".ConfirmationURL",
    ".Data.full_name",
    ".Data.organisation_name",
    ".Data.property_name",
    ".Data.role_title",
    ".Data.invited_by_name",
  ],
} as const;

function senderDomainOf(connection: EmailProviderConnection | null): string | null {
  const config = connection?.configuration ?? null;
  if (!config) return null;
  for (const key of ["sender_domain", "domain", "from_domain"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function resolveEmailReadiness(input: {
  templatePresent: boolean;
  connections: EmailProviderConnection[];
}): EmailReadiness {
  const emailConnection =
    input.connections.find((c) => (c.channel ?? "").toLowerCase() === "email") ?? null;
  const providerReady =
    !!emailConnection && emailConnection.enabled === true && (emailConnection.status ?? "") === "active";
  const domain = senderDomainOf(emailConnection);

  const checks: EmailReadinessCheck[] = [
    {
      key: "template",
      label: "Branded confirmation template",
      status: input.templatePresent ? "Template ready" : "Template missing",
      tone: input.templatePresent ? "ready" : "attention",
      detail: input.templatePresent
        ? `${AUTH_EMAIL_TEMPLATE.htmlPath} and ${AUTH_EMAIL_TEMPLATE.textPath} ship with this build, with personalised fallbacks.`
        : "The branded template is not present in this build.",
    },
    {
      key: "sender_domain",
      label: "Verified sending domain",
      status: domain ? `Sender domain: ${domain}` : "Sender/domain not configured",
      tone: domain ? "ready" : "pending",
      detail: domain
        ? "A sending domain has been recorded for this workspace."
        : "No verified sending domain has been recorded, so confirmation e-mails fall back to the platform default sender.",
    },
    {
      key: "provider",
      label: "E-mail provider connection",
      status: providerReady
        ? `Provider connected: ${emailConnection?.display_name ?? emailConnection?.provider ?? "e-mail"}`
        : "Provider not configured",
      tone: providerReady ? "ready" : "pending",
      detail: providerReady
        ? "An enabled, active e-mail provider connection exists for this workspace."
        : emailConnection?.last_error
          ? `Last provider error: ${emailConnection.last_error}`
          : "No enabled e-mail provider connection has been recorded for this workspace.",
    },
  ];

  if (!input.templatePresent) {
    return {
      checks,
      overall: "template_missing",
      overallLabel: "Template missing",
      overallTone: "attention",
    };
  }
  if (!providerReady) {
    return {
      checks,
      overall: "provider_missing",
      overallLabel: "Provider not configured",
      overallTone: "pending",
    };
  }
  if (!domain) {
    return {
      checks,
      overall: "domain_missing",
      overallLabel: "Sender/domain not configured",
      overallTone: "pending",
    };
  }
  return {
    checks,
    overall: "ready_to_send",
    overallLabel: "Ready to send",
    overallTone: "ready",
  };
}

export type EmailReadinessNextStep = {
  /** Short imperative label for the recommended next action. */
  title: string;
  /** Why this is next, in operator language. */
  detail: string;
  /** True when the step must be performed outside this application. */
  external: boolean;
};

/**
 * The single next recommended step.
 *
 * Deliberately one step at a time and never optimistic: when a provider and a
 * verified domain exist, the recommendation is to prove delivery with a real
 * verification e-mail, not to declare the channel live.
 */
export function nextEmailReadinessStep(readiness: EmailReadiness): EmailReadinessNextStep {
  switch (readiness.overall) {
    case "template_missing":
      return {
        title: "Restore the branded confirmation template",
        detail:
          "The confirmation template is missing from this build, so sign-up e-mail would fall back to an unbranded default.",
        external: false,
      };
    case "provider_missing":
      return {
        title: "Connect an e-mail provider",
        detail:
          "Record an enabled, active e-mail provider connection for this workspace. Until then, confirmation e-mail uses the platform default sender.",
        external: true,
      };
    case "domain_missing":
      return {
        title: "Verify a sending domain with your provider",
        detail:
          "Publish the provider's DNS records for your sending domain and record the verified domain on the connection.",
        external: true,
      };
    default:
      return {
        title: "Confirm delivery with a real verification e-mail",
        detail:
          "Template, provider and sending domain are all recorded. Request a verification e-mail to your own address and confirm it arrives.",
        external: false,
      };
  }
}
