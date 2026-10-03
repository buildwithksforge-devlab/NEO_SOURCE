/**
 * Authentication e-mail contract.
 *
 * Proves the metadata every account-creation path supplies, that no internal
 * identifier can leak into an e-mail payload, that the branded template still
 * supports each variable with a fallback, and that readiness is never reported
 * as live without a provider and sending domain.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_EMAIL_METADATA_KEYS,
  buildCustomerSignupMetadata,
  buildStaffInviteMetadata,
  buildWorkspaceOwnerMetadata,
} from "@/lib/auth-email-metadata";
import { resolveEmailReadiness } from "@/lib/email-readiness";

const root = resolve(__dirname, "../../..");
const html = readFileSync(resolve(root, "emails/auth/confirm-signup.html"), "utf8");
const text = readFileSync(resolve(root, "emails/auth/confirm-signup.txt"), "utf8");
const usersFn = readFileSync(resolve(root, "src/lib/users.functions.ts"), "utf8");
const customerPanel = readFileSync(
  resolve(root, "src/components/public/CustomerAuthPanel.tsx"),
  "utf8",
);

describe("staff invite metadata", () => {
  it("carries the full personalisation set", () => {
    expect(
      buildStaffInviteMetadata({
        full_name: "Dennis Kimani",
        organisation_name: "Luma Haven",
        property_name: "Luma Haven Nairobi",
        role_title: "Housekeeper",
        job_title: "Room attendant",
        invited_by_name: "Wambui Naikuni",
      }),
    ).toEqual({
      full_name: "Dennis Kimani",
      organisation_name: "Luma Haven",
      property_name: "Luma Haven Nairobi",
      role_title: "Housekeeper",
      invited_by_name: "Wambui Naikuni",
      account_type: "staff",
    });
  });

  it("falls back to the job title and omits absent values", () => {
    const meta = buildStaffInviteMetadata({ full_name: "  Ana  Rossi ", job_title: "Chef de Partie" });
    expect(meta.role_title).toBe("Chef de Partie");
    expect(meta.full_name).toBe("Ana Rossi");
    expect(meta).not.toHaveProperty("property_name");
    expect(meta).not.toHaveProperty("invited_by_name");
  });

  it("never lets an internal identifier through", () => {
    const meta = buildStaffInviteMetadata({
      full_name: "7d9bb747-81b5-404e-84f5-1984259ee068",
      organisation_name: "7D9BB747-81B5-404E-84F5-1984259EE068",
    });
    expect(meta).toEqual({ account_type: "staff" });
  });
});

describe("customer signup metadata", () => {
  it("never assumes staff-only fields", () => {
    const meta = buildCustomerSignupMetadata({
      full_name: "Grace Otieno",
      organisation_name: "Luma Haven",
    });
    expect(meta.account_type).toBe("customer");
    expect(meta).not.toHaveProperty("role_title");
    expect(meta).not.toHaveProperty("invited_by_name");
  });
});

describe("workspace owner metadata", () => {
  it("marks the self-service owner account", () => {
    expect(buildWorkspaceOwnerMetadata({ full_name: "Wambui", organisation_name: "Luma Haven" }))
      .toMatchObject({ account_type: "owner", organisation_name: "Luma Haven" });
  });
});

describe("account-creation workflows populate the metadata", () => {
  it("staff provisioning builds and sends invite metadata", () => {
    expect(usersFn).toContain("buildStaffInviteMetadata");
    expect(usersFn).toContain("data: inviteMetadata");
    expect(usersFn).not.toContain("data: { full_name: data.full_name }");
  });

  it("public customer signup builds customer metadata", () => {
    expect(customerPanel).toContain("buildCustomerSignupMetadata");
  });
});

describe("branded template", () => {
  it("supports every metadata variable with a conditional fallback", () => {
    for (const key of AUTH_EMAIL_METADATA_KEYS) {
      if (key === "account_type") continue;
      expect(html).toContain(`{{ if .Data.${key} }}`);
      expect(text).toContain(`.Data.${key}`);
    }
    expect(html).toContain("{{ .ConfirmationURL }}");
    expect(html).toContain("Welcome to NEØ{{ if .Data.full_name }}");
  });
});

describe("delivery readiness", () => {
  it("reports provider not configured when nothing is recorded", () => {
    const r = resolveEmailReadiness({ templatePresent: true, connections: [] });
    expect(r.overall).toBe("provider_missing");
    expect(r.overallLabel).toBe("Provider not configured");
    expect(r.checks.find((c) => c.key === "template")?.status).toBe("Template ready");
    expect(JSON.stringify(r)).not.toMatch(/\b(Live|Sent)\b/);
  });

  it("reports domain missing when a provider exists without a sending domain", () => {
    const r = resolveEmailReadiness({
      templatePresent: true,
      connections: [
        {
          provider: "smtp",
          display_name: "Workspace SMTP",
          channel: "email",
          status: "active",
          enabled: true,
          configuration: {},
          last_error: null,
        },
      ],
    });
    expect(r.overall).toBe("domain_missing");
  });

  it("only reports ready to send with an active provider and a domain", () => {
    const r = resolveEmailReadiness({
      templatePresent: true,
      connections: [
        {
          provider: "smtp",
          display_name: "Workspace SMTP",
          channel: "email",
          status: "active",
          enabled: true,
          configuration: { sender_domain: "notify.example.com" },
          last_error: null,
        },
      ],
    });
    expect(r.overall).toBe("ready_to_send");
    expect(r.overallTone).toBe("ready");
  });

  it("ignores connections on other channels", () => {
    const r = resolveEmailReadiness({
      templatePresent: true,
      connections: [
        {
          provider: "twilio",
          display_name: "SMS",
          channel: "sms",
          status: "active",
          enabled: true,
          configuration: { sender_domain: "notify.example.com" },
          last_error: null,
        },
      ],
    });
    expect(r.overall).toBe("provider_missing");
  });
});
