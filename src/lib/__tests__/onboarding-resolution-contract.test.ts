/**
 * The shared resolution contract.
 *
 * Every unresolved relationship value in every adapter is settled through one
 * contract: the capability list on the match policy. Guidance, remedies,
 * buttons, picker empty states and blocking behaviour are all derived from it.
 *
 * The defect these tests lock out was real and shared, not Asset-specific:
 * "utensils → Category → 39 rows" advertised "you may create a category here"
 * while the picker beside it said "Create it in its own module first". Two
 * surfaces were reading two different sources of truth. A screen may now only
 * offer what the contract grants.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ONBOARDING_DOMAINS } from "@/lib/onboarding/domains";
import { adapterFor } from "@/lib/onboarding/adapters";
import { allMatchPolicies, allowedActions, hasCapability, matchPolicy } from "@/lib/onboarding/matching";
import { resolutionContract } from "@/lib/onboarding/resolution";

const wizard = readFileSync("src/components/onboarding/ImportWizard.tsx", "utf8");
const picker = readFileSync("src/components/onboarding/MasterPicker.tsx", "utf8");

/** Masters that carry identity, money or legal terms: never fabricated here. */
const GOVERNED = [
  "employee",
  "supplier",
  "customer",
  "corporate_account",
  "account",
  "rate_plan",
  "room",
  "property",
  "department",
] as const;

describe("every relationship target declares a contract", () => {
  it.each(allMatchPolicies().map((p) => [p.target, p] as const))("%s", (_target, policy) => {
    expect(policy.capabilities.length).toBeGreaterThan(0);
    expect(policy.capabilities).toContain("SELECT_EXISTING");
    expect(policy.ownedBy.trim()).toBeTruthy();
    expect(policy.ownerRoute.startsWith("/")).toBe(true);
    // A value must always have some settled outcome: assign it, create it,
    // leave it, or hold the row back.
    const contract = resolutionContract(policy);
    expect(
      contract.canCreateInline ||
        contract.canLeaveUnassigned ||
        hasCapability(policy, "SKIP_ROW") ||
        hasCapability(policy, "BLOCK"),
    ).toBe(true);
  });

  it("covers every relationship any domain actually links to", () => {
    for (const domain of ONBOARDING_DOMAINS) {
      for (const target of domain.linksTo) {
        expect(matchPolicy(target), `${domain.key} links to ${target} with no policy`).toBeTruthy();
      }
    }
  });
});

describe("inline creation is a granted capability, never an assumption", () => {
  it("mirrors CREATE_INLINE exactly", () => {
    for (const policy of allMatchPolicies()) {
      expect(policy.inlineCreate).toBe(hasCapability(policy, "CREATE_INLINE"));
      expect(allowedActions(policy).includes("create")).toBe(policy.inlineCreate);
      expect(resolutionContract(policy).canCreateInline).toBe(policy.inlineCreate);
    }
  });

  it("gives every inline-creatable target a real destination, scope and duplicate guard", () => {
    for (const policy of allMatchPolicies()) {
      if (!policy.inlineCreate) {
        expect(policy.inlineSpec).toBeUndefined();
        continue;
      }
      const spec = policy.inlineSpec;
      expect(spec, `${policy.target} grants CREATE_INLINE with no destination`).toBeTruthy();
      const adapter = adapterFor(spec!.adapterKey);
      expect(adapter, `${policy.target} points at unknown adapter ${spec!.adapterKey}`).toBeTruthy();
      expect(spec!.requires.length).toBeGreaterThan(0);
      expect(spec!.matchOn.length).toBeGreaterThan(0);
      expect(spec!.capability.module).toBeTruthy();
      expect(spec!.capability.action).toBeTruthy();
      // Only fields the destination actually writes may be required of it.
      expect(adapter!.write.some((w) => w.from === spec!.labelField)).toBe(true);
    }
  });

  it("never lets a governed master be created from inside another import", () => {
    for (const target of GOVERNED) {
      const policy = matchPolicy(target);
      expect(policy.inlineCreate, `${target} must not be inline-creatable`).toBe(false);
      expect(hasCapability(policy, "CREATE_IN_OWNING_MODULE")).toBe(true);
    }
  });

  it("never promises creation in guidance the contract does not grant", () => {
    for (const policy of allMatchPolicies()) {
      const promises = /create [^.]*\bhere\b/i.test(resolutionContract(policy).explanation);
      expect(promises, `${policy.target} guidance promises inline creation`).toBe(policy.inlineCreate);
    }
  });

  it("hands a mandatory target with no inline creation to its owning module", () => {
    for (const policy of allMatchPolicies()) {
      const contract = resolutionContract(policy);
      if (!contract.blocking) continue;
      expect(contract.handoff, `${policy.target} blocks with nowhere to go`).toBeTruthy();
    }
  });
});

describe("the screens read the contract and nothing else", () => {
  it("derives wizard guidance and actions from the contract", () => {
    expect(wizard).toContain("resolutionContract(group.policy)");
    // No screen-level re-derivation of the old boolean.
    expect(/group\.policy\.inlineCreate/.test(wizard)).toBe(false);
    expect(/group\.policy\.allowBlank/.test(wizard)).toBe(false);
  });

  it("offers inline creation and the owning-module handoff from the same contract", () => {
    expect(wizard).toContain("contract.canCreateInline");
    expect(wizard).toContain("contract.handoff");
  });

  it("stops the picker claiming a record must be created elsewhere", () => {
    expect(picker.includes("Create it in its own module first.")).toBe(false);
    expect(picker).toContain("emptyHint");
    expect(picker).toContain("onCreate");
  });

  it("offers the granted create action without requiring the operator to type first", () => {
    // The defect: the affordance existed but only appeared after a search.
    expect(picker).toContain("const canCreate =\n    Boolean(onCreate)");
  });

  it("writes nothing until an explicit confirmation", () => {
    expect(wizard).toContain("<CreateMasterDialog");
    expect(wizard).toContain("openCreate(group)");
    // No direct mutation straight off a decision-table button.
    expect(/onClick=\{\(\) => createMaster\(/.test(wizard)).toBe(false);
  });

  it("groups empty identifiers into one decision instead of a per-row warning", () => {
    expect(wizard).toContain("data-onboarding-identifier-group");
  });
});

describe("the inline-creation confirmation", () => {
  const dialog = readFileSync("src/components/onboarding/CreateMasterDialog.tsx", "utf8");

  it("shows the canonical name, affected rows, destination and scope", () => {
    expect(dialog).toContain("Name of the new record");
    expect(dialog).toContain("Rows this settles");
    expect(dialog).toContain("Where it will live");
    expect(dialog).toContain("scopeNote");
  });

  it("searches the hotel's existing records again and refuses an exact duplicate", () => {
    expect(dialog).toContain("similarity(");
    expect(dialog).toContain("Use this one");
    expect(dialog).toContain("Boolean(exact)");
  });
});
