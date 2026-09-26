/**
 * Fact-layer isolation contract.
 *
 * The dashboard reads three independent fact services. A failure in one may
 * never present unrelated cards as broken, and a scope refusal must be
 * explained ("select a property") rather than reported as an unreadable source.
 */
import { describe, expect, it } from "vitest";
import {
  FACT_DOMAIN_SERVICE,
  FACTS,
  classifyFactError,
  factDomainOf,
  type FactDomain,
} from "@/lib/facts";
import { resolveCardState } from "@/lib/card-state";

describe("fact domain routing", () => {
  it("routes each fact path to the service that produces it", () => {
    expect(factDomainOf("accounting.revenue_today")).toBe("period");
    expect(factDomainOf("rooms.occupancy_rate")).toBe("period");
    expect(factDomainOf("front_office.arrivals_today")).toBe("front_office");
    expect(factDomainOf("ops.kitchen.new_items")).toBe("operational");
  });

  it("gives every known fact a service", () => {
    for (const path of Object.keys(FACTS)) {
      const domain: FactDomain = factDomainOf(path);
      expect(FACT_DOMAIN_SERVICE[domain]).toBeTruthy();
    }
  });

  it("keeps the three services in distinct cache domains", () => {
    const services = new Set(Object.values(FACT_DOMAIN_SERVICE));
    expect(services.size).toBe(3);
  });
});

describe("fact error classification", () => {
  it("recognises a scoped user who has not chosen a property", () => {
    const failure = classifyFactError(
      new Error("explicit_property_required_for_scoped_user"),
      "period",
    );
    expect(failure?.kind).toBe("property-required");
    expect(failure?.service).toBe("neo_facts");
  });

  it("recognises a session and an out-of-scope property refusal", () => {
    expect(classifyFactError(new Error("reporting_session_required"), "period")?.kind).toBe(
      "session-required",
    );
    expect(classifyFactError(new Error("property_out_of_scope"), "front_office")?.kind).toBe(
      "access-denied",
    );
    expect(
      classifyFactError({ message: "permission denied for function x" }, "operational")?.kind,
    ).toBe("access-denied");
  });

  it("treats an unknown database message as a source error, with the detail kept", () => {
    const failure = classifyFactError(new Error("column foo does not exist"), "operational");
    expect(failure?.kind).toBe("source-error");
    expect(failure?.detail).toContain("column foo");
  });

  it("returns null when there is no error", () => {
    expect(classifyFactError(null, "period")).toBeNull();
    expect(classifyFactError(undefined, "period")).toBeNull();
  });
});

describe("card states stay independent per domain", () => {
  it("shows a property prompt instead of a query failure for a scope refusal", () => {
    expect(
      resolveCardState({
        scopeSelectionRequired: true,
        error: new Error("explicit_property_required_for_scoped_user"),
        hasLoaded: false,
      }),
    ).toBe("select-property");
  });

  it("renders a healthy domain's figure while another domain is failing", () => {
    const failingDomain = { isLoading: false, isSuccess: false, error: new Error("boom") };
    const healthyDomain = { isLoading: false, isSuccess: true, error: null };

    expect(
      resolveCardState({
        isLoading: failingDomain.isLoading,
        hasLoaded: failingDomain.isSuccess,
        error: failingDomain.error,
      }),
    ).toBe("query-failed");

    expect(
      resolveCardState({
        isLoading: healthyDomain.isLoading,
        hasLoaded: healthyDomain.isSuccess,
        error: healthyDomain.error,
        value: 12,
      }),
    ).toBe("ready");
  });

  it("never prints a zero while its own domain is still loading", () => {
    expect(resolveCardState({ isLoading: true, hasLoaded: false, value: 0 })).toBe("loading");
  });
});
