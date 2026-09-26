/**
 * Adapter registration contract.
 *
 * A future onboarding domain is admitted only if every reference field it
 * declares resolves through the shared contract correctly. These tests
 * register a brand-new adapter that does not exist in the product, then break
 * one declaration at a time and assert registration is refused for each.
 */
import { describe, expect, it } from "vitest";
import { allAdapters } from "@/lib/onboarding/adapters";
import { ONBOARDING_DOMAINS } from "@/lib/onboarding/domains";
import type { OnboardingDomain, RelationshipTarget } from "@/lib/onboarding/domains";
import type { MatchPolicy } from "@/lib/onboarding/matching";
import {
  AdapterRegistrationError,
  registerOnboardingAdapter,
  validateAdapterRegistration,
} from "@/lib/onboarding/registration";

const adapterKeys = new Set(allAdapters().map((a) => a.key));

/** A fictional domain, used only to exercise registration. */
function candidateDomain(overrides: Partial<OnboardingDomain> = {}): OnboardingDomain {
  return {
    key: "linen_articles",
    label: "Linen articles",
    module: "Housekeeping",
    blurb: "Linen articles held against a store.",
    supported: false,
    capability: { module: "housekeeping", action: "edit" },
    linksTo: ["stock_category"],
    fields: [
      {
        key: "name",
        label: "Article name",
        requirement: "required",
        format: "text",
        meaning: "What the article is called.",
        example: "Text",
        aliases: [],
      },
      {
        key: "category",
        label: "Stock category",
        requirement: "optional",
        format: "text",
        meaning: "The stock category the article belongs to.",
        example: "Text",
        aliases: [],
        relationship: "stock_category",
      },
    ],
    duplicateKeys: [["name"]],
    example: [],
    ...overrides,
  } as OnboardingDomain;
}

const goodPolicy: MatchPolicy = {
  target: "stock_category",
  label: "Stock category",
  accept: 0.88,
  review: 0.62,
  floor: 0.5,
  identityEvidence: ["code"],
  capabilities: [
    "SELECT_EXISTING",
    "PROPOSE_MATCH",
    "MAP_TO_CANONICAL_VALUE",
    "SKIP_ROW",
    "CREATE_INLINE",
    "CREATE_IN_OWNING_MODULE",
    "LEAVE_UNASSIGNED",
  ],
  inlineCreate: true,
  canonicalise: true,
  inlineSpec: {
    adapterKey: "stock_categories",
    labelField: "name",
    requires: ["name"],
    capability: { module: "inventory", action: "edit" },
    matchOn: ["name", "code"],
  },
  ownedBy: "Inventory & Stores",
  ownerRoute: "/inventory/items",
  allowBlank: true,
  guidance: "You may create this stock category here and map every spelling of it to that one record.",
};

function withPolicy(policy: MatchPolicy) {
  return (target: RelationshipTarget) => (target === policy.target ? policy : undefined);
}

function rules(domain: OnboardingDomain, policy: MatchPolicy): string[] {
  return validateAdapterRegistration(
    { domain, policyFor: withPolicy(policy) },
    adapterKeys,
  ).map((v) => v.rule);
}

describe("a new onboarding adapter registers only with a correct contract", () => {
  it("accepts a correctly declared adapter", () => {
    expect(() =>
      registerOnboardingAdapter({ domain: candidateDomain(), policyFor: withPolicy(goodPolicy) }, adapterKeys),
    ).not.toThrow();
  });

  it("refuses a reference field with no policy at all", () => {
    const violations = validateAdapterRegistration(
      { domain: candidateDomain(), policyFor: () => undefined as unknown as MatchPolicy },
      adapterKeys,
    );
    // stock_category exists in the shared table, so fall back proves resolution works.
    expect(violations.filter((v) => v.rule === "policy_missing").length).toBe(0);

    const unknown = candidateDomain({
      linksTo: ["meal_plan"],
      fields: [
        {
          key: "plan",
          label: "Plan",
          requirement: "optional",
          format: "text",
          meaning: "x",
          example: "x",
          aliases: [],
          relationship: "phantom" as RelationshipTarget,
        },
      ],
    });
    expect(rules(unknown, goodPolicy)).toContain("policy_missing");
  });

  it("refuses inline creation without a creation rule", () => {
    const broken: MatchPolicy = { ...goodPolicy };
    delete (broken as { inlineSpec?: unknown }).inlineSpec;
    expect(rules(candidateDomain(), broken)).toContain("inline_spec_missing");
  });

  it("refuses inline creation pointing at an unknown adapter", () => {
    const broken: MatchPolicy = {
      ...goodPolicy,
      inlineSpec: { ...goodPolicy.inlineSpec!, adapterKey: "not_a_real_adapter" },
    };
    expect(rules(candidateDomain(), broken)).toContain("inline_spec_adapter");
  });

  it("refuses inline creation with no duplicate protection", () => {
    const broken: MatchPolicy = {
      ...goodPolicy,
      inlineSpec: { ...goodPolicy.inlineSpec!, matchOn: [] },
    };
    expect(rules(candidateDomain(), broken)).toContain("inline_spec_match");
  });

  it("refuses inline creation with no permission declared", () => {
    const broken: MatchPolicy = {
      ...goodPolicy,
      inlineSpec: { ...goodPolicy.inlineSpec!, capability: { module: "", action: "" } },
    };
    expect(rules(candidateDomain(), broken)).toContain("inline_spec_capability");
  });

  it("refuses a policy whose inlineCreate flag disagrees with its capabilities", () => {
    const broken: MatchPolicy = { ...goodPolicy, inlineCreate: false };
    expect(rules(candidateDomain(), broken)).toContain("inline_flag_mismatch");
  });

  it("refuses a policy whose allowBlank disagrees with LEAVE_UNASSIGNED", () => {
    const broken: MatchPolicy = { ...goodPolicy, allowBlank: false };
    expect(rules(candidateDomain(), broken)).toContain("blank_flag_mismatch");
  });

  it("refuses guidance that promises creation the contract did not grant", () => {
    const broken: MatchPolicy = {
      ...goodPolicy,
      capabilities: ["SELECT_EXISTING", "PROPOSE_MATCH", "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED"],
      inlineCreate: false,
    };
    delete (broken as { inlineSpec?: unknown }).inlineSpec;
    expect(rules(candidateDomain(), broken)).toContain("guidance_promises_inline");
  });

  it("refuses a governed master being creatable from inside another import", () => {
    const governed: MatchPolicy = {
      ...goodPolicy,
      target: "supplier",
      label: "Supplier",
      guidance: "Pick the supplier.",
    };
    const domain = candidateDomain({
      linksTo: ["supplier"],
      fields: [
        {
          key: "supplier",
          label: "Supplier",
          requirement: "optional",
          format: "text",
          meaning: "x",
          example: "x",
          aliases: [],
          relationship: "supplier",
        },
      ],
    });
    expect(rules(domain, governed)).toContain("governed_master_inline");
  });

  it("refuses a value that can neither be created, left unassigned, handed off nor blocked", () => {
    const broken: MatchPolicy = {
      ...goodPolicy,
      capabilities: ["SELECT_EXISTING", "PROPOSE_MATCH"],
      inlineCreate: false,
      allowBlank: false,
      guidance: "Pick an existing one.",
    };
    delete (broken as { inlineSpec?: unknown }).inlineSpec;
    expect(rules(candidateDomain(), broken)).toContain("no_way_forward");
  });

  it("refuses unordered confidence thresholds", () => {
    const broken: MatchPolicy = { ...goodPolicy, review: 0.95 };
    expect(rules(candidateDomain(), broken)).toContain("thresholds_unordered");
  });

  it("refuses a reference field the domain does not list in linksTo", () => {
    const domain = candidateDomain({ linksTo: [] });
    expect(rules(domain, goodPolicy)).toContain("link_undeclared");
  });

  it("refuses a declared link with no field resolving against it", () => {
    const domain = candidateDomain({ supported: true, linksTo: ["stock_category", "store"] });
    expect(rules(domain, goodPolicy)).toContain("link_without_field");
  });

  it("reports every violation at once, and names them in the error", () => {
    const broken: MatchPolicy = { ...goodPolicy, inlineCreate: false, allowBlank: false, review: 0.99 };
    try {
      registerOnboardingAdapter({ domain: candidateDomain(), policyFor: withPolicy(broken) }, adapterKeys);
      throw new Error("registration should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterRegistrationError);
      const violations = (error as AdapterRegistrationError).violations.map((v) => v.rule);
      expect(violations).toEqual(
        expect.arrayContaining(["inline_flag_mismatch", "blank_flag_mismatch", "thresholds_unordered"]),
      );
    }
  });
});

describe("every shipped onboarding domain already satisfies the registration contract", () => {
  it.each(ONBOARDING_DOMAINS.map((d) => [d.key, d] as const))("%s", (_key, domain) => {
    const adapter = allAdapters().find((a) => a.key === domain.key);
    const violations = validateAdapterRegistration(
      adapter ? { domain, adapter } : { domain },
      adapterKeys,
    );
    expect(violations).toEqual([]);
  });
});
