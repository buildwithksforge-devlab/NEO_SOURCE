/**
 * NEØ Intelligent Data Onboarding — adapter registration contract.
 *
 * A new domain is not admitted to the onboarding engine because it compiles.
 * Every reference field it declares must resolve through the shared contract,
 * and the contract must be internally consistent: a policy that grants inline
 * creation must say where and under what permission; a policy that refuses it
 * must say which module owns the master; a governed master (a person, a
 * supplier, a guest, money) may never be creatable from inside someone else's
 * import; and the guidance a hotel reads may never promise a capability that
 * was not granted.
 *
 * Registration fails loudly when any of that is wrong, so a future adapter
 * cannot reintroduce the "create it here" / "create it elsewhere" defect by
 * copying an existing declaration and editing half of it.
 */
import type { DomainAdapter } from "./adapters";
import type { OnboardingDomain, RelationshipTarget } from "./domains";
import { matchPolicy, type MatchPolicy, type ResolutionCapability } from "./matching";

/** Masters carrying identity, money or legal terms. Never created inline. */
export const GOVERNED_TARGETS: RelationshipTarget[] = [
  "employee",
  "supplier",
  "customer",
  "corporate_account",
  "account",
  "rate_plan",
  "room",
  "property",
  "department",
];

export type RegistrationViolation = {
  /** Reference field the violation belongs to, or "domain" for whole-domain rules. */
  field: string;
  target: RelationshipTarget | null;
  rule: string;
  detail: string;
};

export type AdapterRegistrationInput = {
  domain: OnboardingDomain;
  adapter?: DomainAdapter;
  /** Lets a candidate declare policies that are not in the shared table yet. */
  policyFor?: (target: RelationshipTarget) => MatchPolicy | undefined;
};

const PROMISES_INLINE = /\b(create|add)\b[^.]{0,40}\bhere\b/i;

function resolvePolicy(
  target: RelationshipTarget,
  override?: (t: RelationshipTarget) => MatchPolicy | undefined,
): MatchPolicy | undefined {
  const supplied = override?.(target);
  if (supplied) return supplied;
  try {
    return matchPolicy(target);
  } catch {
    return undefined;
  }
}

function has(policy: MatchPolicy, capability: ResolutionCapability): boolean {
  return policy.capabilities.includes(capability);
}

/**
 * Checks one reference field's declared resolution behaviour. Returns every
 * violation found rather than the first, so a declaration is corrected once.
 */
export function validateReferenceField(
  fieldKey: string,
  policy: MatchPolicy,
  knownAdapterKeys?: ReadonlySet<string>,
): RegistrationViolation[] {
  const out: RegistrationViolation[] = [];
  const fail = (rule: string, detail: string) =>
    out.push({ field: fieldKey, target: policy.target, rule, detail });

  if (!has(policy, "SELECT_EXISTING")) {
    fail(
      "select_existing_required",
      "Every reference field must let a human choose an existing record.",
    );
  }

  if (policy.inlineCreate !== has(policy, "CREATE_INLINE")) {
    fail(
      "inline_flag_mismatch",
      "inlineCreate must mirror the CREATE_INLINE capability exactly; the two disagree.",
    );
  }

  if (has(policy, "CREATE_INLINE")) {
    const spec = policy.inlineSpec;
    if (!spec) {
      fail("inline_spec_missing", "CREATE_INLINE is granted but no inline creation rule is declared.");
    } else {
      if (!spec.adapterKey) fail("inline_spec_adapter", "Inline creation must name the adapter that owns the destination.");
      else if (knownAdapterKeys && !knownAdapterKeys.has(spec.adapterKey)) {
        fail("inline_spec_adapter", `Inline creation names an unknown adapter "${spec.adapterKey}".`);
      }
      if (!spec.labelField) fail("inline_spec_label", "Inline creation must say which field the file value is written to.");
      else if (!spec.requires.includes(spec.labelField)) {
        fail("inline_spec_requires", "The field carrying the value must itself be required by the master.");
      }
      if (spec.matchOn.length === 0) {
        fail("inline_spec_match", "Inline creation must declare how an existing record is recognised, or imports double up.");
      }
      if (!spec.capability?.module || !spec.capability?.action) {
        fail("inline_spec_capability", "Inline creation must declare the permission the actor needs.");
      }
    }
    if (GOVERNED_TARGETS.includes(policy.target)) {
      fail(
        "governed_master_inline",
        `${policy.label} carries identity, money or legal terms and may never be created from inside another import.`,
      );
    }
  } else if (policy.inlineSpec) {
    fail("inline_spec_unused", "An inline creation rule is declared but CREATE_INLINE was not granted.");
  }

  // Canonicalisation may clean, cluster and propose. It must never be pointed
  // at records where two similar names are routinely two different entities.
  if (policy.canonicalise && GOVERNED_TARGETS.includes(policy.target)) {
    fail(
      "governed_master_canonicalise",
      `${policy.label} is a governed master: NEØ may not normalise or merge its names, because similar names can be genuinely different records.`,
    );
  }
  if (policy.canonicalise && !has(policy, "CREATE_INLINE") && !has(policy, "MAP_TO_CANONICAL_VALUE")) {
    fail(
      "canonicalise_unusable",
      "Canonicalisation is declared but this relationship can neither create a canonical record nor map to one.",
    );
  }


  if (has(policy, "CREATE_IN_OWNING_MODULE")) {
    if (!policy.ownedBy.trim()) fail("owner_missing", "The owning module must be named.");
    if (!policy.ownerRoute.startsWith("/")) {
      fail("owner_route_invalid", "The owning module needs a real in-app destination beginning with /.");
    }
  }

  if (policy.allowBlank !== has(policy, "LEAVE_UNASSIGNED")) {
    fail(
      "blank_flag_mismatch",
      "allowBlank must mirror LEAVE_UNASSIGNED; one says the value may be left empty and the other does not.",
    );
  }

  if (!has(policy, "CREATE_INLINE") && !has(policy, "LEAVE_UNASSIGNED")) {
    if (!has(policy, "CREATE_IN_OWNING_MODULE") && !has(policy, "BLOCK")) {
      fail(
        "no_way_forward",
        "A value that cannot be created here and cannot be left unassigned must either hand off to its owning module or block the row.",
      );
    }
  }

  if (!(policy.accept > policy.review && policy.review > policy.floor)) {
    fail("thresholds_unordered", "Confidence thresholds must run accept > review > floor.");
  }
  if (policy.floor < 0 || policy.accept > 1) {
    fail("thresholds_range", "Confidence thresholds must sit between 0 and 1.");
  }

  if (!policy.guidance.trim()) {
    fail("guidance_missing", "A reference field must explain, in plain language, what a human may do.");
  } else if (!has(policy, "CREATE_INLINE") && PROMISES_INLINE.test(policy.guidance)) {
    fail(
      "guidance_promises_inline",
      "The guidance offers creation here, but CREATE_INLINE was not granted.",
    );
  }

  return out;
}

/**
 * Validates a whole adapter registration: its reference fields, the targets it
 * claims to link to, and the write rules that carry those relationships.
 */
export function validateAdapterRegistration(
  input: AdapterRegistrationInput,
  knownAdapterKeys?: ReadonlySet<string>,
): RegistrationViolation[] {
  const { domain, adapter, policyFor } = input;
  const out: RegistrationViolation[] = [];
  const referenceFields = domain.fields.filter((f) => f.relationship);

  for (const field of referenceFields) {
    const target = field.relationship as RelationshipTarget;
    const policy = resolvePolicy(target, policyFor);
    if (!policy) {
      out.push({
        field: field.key,
        target,
        rule: "policy_missing",
        detail: `No resolution policy is declared for ${target}.`,
      });
      continue;
    }
    if (policy.target !== target) {
      out.push({
        field: field.key,
        target,
        rule: "policy_target_mismatch",
        detail: `The policy supplied for ${target} declares itself as ${policy.target}.`,
      });
      continue;
    }
    if (!domain.linksTo.includes(target)) {
      out.push({
        field: field.key,
        target,
        rule: "link_undeclared",
        detail: `${field.label} resolves against ${target}, which the domain does not list in linksTo.`,
      });
    }
    out.push(...validateReferenceField(field.key, policy, knownAdapterKeys));
  }

  // A domain that is not yet writable may declare the links it will carry.
  for (const target of domain.supported ? domain.linksTo : []) {
    if (!referenceFields.some((f) => f.relationship === target)) {
      out.push({
        field: "domain",
        target,
        rule: "link_without_field",
        detail: `The domain claims to link to ${target} but declares no field that resolves against it.`,
      });
    }
  }

  if (adapter) {
    const fieldKeys = new Set(domain.fields.map((f) => f.key));
    for (const rule of adapter.write) {
      if (rule.kind === "relation") {
        const field = domain.fields.find((f) => f.key === rule.from);
        if (!field) {
          out.push({
            field: rule.from,
            target: null,
            rule: "relation_write_unknown_field",
            detail: `The adapter writes ${rule.column} from "${rule.from}", which the domain does not declare.`,
          });
        } else if (!field.relationship) {
          out.push({
            field: rule.from,
            target: null,
            rule: "relation_write_not_reference",
            detail: `${rule.column} is written as a relationship, but "${rule.from}" declares no relationship target.`,
          });
        }
      } else if (!fieldKeys.has(rule.from)) {
        out.push({
          field: rule.from,
          target: null,
          rule: "write_unknown_field",
          detail: `The adapter writes ${rule.column} from an undeclared field "${rule.from}".`,
        });
      }
    }
    for (const field of referenceFields) {
      const written = adapter.write.find((r) => r.from === field.key);
      if (written && written.kind !== "relation") {
        out.push({
          field: field.key,
          target: field.relationship ?? null,
          rule: "reference_written_as_text",
          detail: `${field.label} resolves against a master, so it must be written as a relationship, not copied as ${written.kind ?? "text"}.`,
        });
      }
    }
  }

  return out;
}

export class AdapterRegistrationError extends Error {
  violations: RegistrationViolation[];
  constructor(domainKey: string, violations: RegistrationViolation[]) {
    super(
      `Onboarding adapter "${domainKey}" was refused: ${violations
        .map((v) => `${v.field} — ${v.detail}`)
        .join(" | ")}`,
    );
    this.name = "AdapterRegistrationError";
    this.violations = violations;
  }
}

/**
 * Registers an adapter, or refuses it. Registration is the only supported way
 * to admit a new onboarding domain to the engine.
 */
export function registerOnboardingAdapter(
  input: AdapterRegistrationInput,
  knownAdapterKeys?: ReadonlySet<string>,
): { domain: OnboardingDomain; adapter?: DomainAdapter | undefined } {
  const violations = validateAdapterRegistration(input, knownAdapterKeys);
  if (violations.length > 0) throw new AdapterRegistrationError(input.domain.key, violations);
  return { domain: input.domain, adapter: input.adapter };
}
