import { afterEach, describe, expect, it } from "vitest";
import { isConnectorSecretName, resolveConnectorSecret } from "@/lib/connector-secret.server";

describe("generic connector secret boundary", () => {
  afterEach(() => {
    delete process.env["NEO_CONNECTOR_TEST_KEY"];
  });

  it("refuses core host environment variable names", () => {
    expect(isConnectorSecretName("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
    expect(isConnectorSecretName("OPENAI_API_KEY")).toBe(false);
    expect(resolveConnectorSecret("SUPABASE_SERVICE_ROLE_KEY").status).toBe("invalid");
  });

  it("allows only the dedicated connector namespace", () => {
    expect(isConnectorSecretName("NEO_CONNECTOR_CARD_TERMINAL_API_KEY")).toBe(true);
    expect(isConnectorSecretName("NEO_CONNECTOR_COURIER_TOKEN")).toBe(true);
    expect(isConnectorSecretName("neo_connector_bad")).toBe(false);
  });

  it("returns a connector value only when that dedicated variable exists", () => {
    expect(resolveConnectorSecret("NEO_CONNECTOR_TEST_KEY").status).toBe("missing");
    process.env["NEO_CONNECTOR_TEST_KEY"] = "test-only-value";
    expect(resolveConnectorSecret("NEO_CONNECTOR_TEST_KEY")).toEqual({
      status: "ready",
      value: "test-only-value",
    });
  });
});
