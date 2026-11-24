import { describe, expect, it, vi } from "vitest";
import { simulationConfigurationIssue, simulationRegistryIssue } from "@/lib/simulation/connection-status";
import { cleanEnvironment, type EnvironmentRow } from "@/lib/simulation/runner.server";

vi.mock("@/lib/simulation/suites.server", () => ({ SUITES: [] }));
vi.mock("@/lib/simulation/environment.server", () => ({
  purgeEnvironment: async () => ({ organisationRemoved: true, accountsRemoved: 0, leftovers: [], problems: [] }),
}));

describe("Simulation connection", () => {
  const config = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture",
  };

  it("accepts the local Supabase project with a server key", () => {
    expect(simulationConfigurationIssue(config)).toBeNull();
  });

  it("reports missing credentials, public keys, and a mismatched project", () => {
    expect(simulationConfigurationIssue({})).toBe("missing_configuration");
    expect(simulationConfigurationIssue({ ...config, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_fixture" })).toBe("unsupported_credential");
    expect(simulationConfigurationIssue({ ...config, VITE_SUPABASE_URL: "https://other.example.com" })).toBe("wrong_project");
  });

  it("distinguishes a rejected key, missing schema, refused access and network failure", () => {
    expect(simulationRegistryIssue(401)).toBe("invalid_credential");
    expect(simulationRegistryIssue(404, "PGRST205")).toBe("registry_missing");
    expect(simulationRegistryIssue(403)).toBe("registry_denied");
    expect(simulationRegistryIssue(0)).toBe("unreachable");
  });
});

describe("Simulation cleanup evidence", () => {
  const environment: EnvironmentRow = {
    id: "qa-a", control_org_id: "operator", test_org_id: "test-only", label: "QA A",
    kind: "primary", owner_user_id: null, branch_id: null, accounts: [], seed: {}, status: "active",
  };
  function registry(wrote: boolean, finalStatus: string | null) {
    return {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({
          maybeSingle: async () => ({ data: wrote ? { id: environment.id } : null, error: null }),
        }) }) }),
        select: () => ({ in: async () => ({
          data: finalStatus ? [{ id: environment.id, status: finalStatus, accounts: [] }] : null,
          error: finalStatus ? null : new Error("Offline"),
        }) }),
      }),
    } as unknown as Parameters<typeof cleanEnvironment>[0];
  }

  it("counts cleanup only after the registry saves and verifies it", async () => {
    await expect(cleanEnvironment(registry(true, "purged"), [environment]))
      .resolves.toMatchObject({ removed: 1, verified: true });
    await expect(cleanEnvironment(registry(false, "active"), [environment]))
      .resolves.toMatchObject({ removed: 0, verified: false });
  });

  it("surfaces a failed verification read instead of claiming success", async () => {
    await expect(cleanEnvironment(registry(true, null), [environment]))
      .resolves.toMatchObject({ verified: false });
  });
});
