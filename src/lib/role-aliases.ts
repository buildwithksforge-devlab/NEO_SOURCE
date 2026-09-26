/**
 * Deterministic role-name normalisation.
 *
 * Mirrors `public.neo_auto_alias_key()` in the database so the interface, the
 * migration screens and the backend all agree on what an "obvious equivalent"
 * of an approved role name is. Obvious variants — typos, singular/plural,
 * hyphenation, abbreviations, dropped connective words — are resolved
 * automatically and never surfaced as a human decision. Genuinely ambiguous
 * titles stay unresolved on purpose.
 */

/** The approved catalogue (`public.role_catalogue`), key → display name. */
export const CATALOGUE_ROLES: Record<string, string> = {
  owner: "Owner / Director",
  "operations-manager": "Operations Manager",
  "finance-manager": "Finance Manager",
  accountant: "Accountant",
  cashier: "Cashier",
  "food-and-beverage-manager": "F&B Manager",
  "restaurant-manager": "Restaurant Manager",
  "coffee-station-supervisor": "Coffee Station Supervisor",
  waiter: "Waiter / Waitress",
  barista: "Barista",
  "bar-manager": "Bar Manager",
  "bar-attendant": "Bar Attendant",
  "delivery-manager": "Delivery Manager",
  rider: "Rider / Driver",
  "front-office-manager": "Front Office Manager",
  "front-office-supervisor": "Front Office Supervisor",
  "front-office-cashier": "Front Office Cashier",
  "reservations-agent": "Reservations Agent",
  driver: "Driver / Transport Officer",
  receptionist: "Receptionist",
  "housekeeping-manager": "Housekeeping Manager",
  housekeeper: "Housekeeper",
  storekeeper: "Storekeeper",
  "receiving-clerk": "Receiving Clerk",
  "laundry-manager": "Laundry Manager",
  "laundry-supervisor": "Laundry Supervisor",
  "laundry-attendant": "Laundry Attendant",
  "human-resources-manager": "Human Resources Manager",
  "hr-officer": "HR Officer",
  "procurement-manager": "Procurement Manager",
  "procurement-officer": "Procurement Officer",
  "marketing-manager": "Marketing Manager",
  "social-media-manager": "Social Media Manager",
  "sales-and-events-manager": "Sales & Events Manager",
  "events-coordinator": "Events / Banqueting Coordinator",
  "banqueting-staff": "Banqueting Service Staff",
  "maintenance-manager": "Maintenance & Landscaping Manager",
  "maintenance-technician": "Maintenance Technician",
  "maintenance-officer": "Maintenance Officer",
  "grounds-worker": "Ground Worker",
  "head-chef": "Kitchen Manager / Head Chef",
  "hot-kitchen-supervisor": "Hot Kitchen Supervisor",
  "hot-kitchen-chef": "Hot-Kitchen Chef",
  "kitchen-steward": "Kitchen Steward / Dishwasher",
  "chief-steward": "Chief Steward",
  "head-pastry-chef": "Head Pastry Chef",
  "pastry-chef": "Pastry Chef",
  "security-supervisor": "Security Supervisor",
  "security-guard": "Security Guard",
  "it-system-administrator": "IT/System Administrator",
};

/** Approved equivalents that no longer require a human decision. */
export const ROLE_ALIASES: Record<string, string> = {
  "hr manager": "human-resources-manager",
  "human resource manager": "human-resources-manager",
  waitress: "waiter",
  waiter: "waiter",
  "hot kitchen chef": "hot-kitchen-chef",
  "finance manager": "finance-manager",
  "events manager": "sales-and-events-manager",
  "sales manager": "sales-and-events-manager",
  "front office manager": "front-office-manager",
  "front office supervisor": "front-office-supervisor",
  "housekeeping supervisor": "housekeeping-manager",
  "laundry supervisor": "laundry-supervisor",
  "restaurant supervisor": "restaurant-manager",
  "bar supervisor": "bar-manager",
  "maintenance technician": "maintenance-technician",
  "maintenance supervisor": "maintenance-manager",
  "front office cashier": "front-office-cashier",
  "kitchen manager": "head-chef",
  "pastry supervisor": "head-pastry-chef",
  "reservations agent": "reservations-agent",
  driver: "driver",
  "hr officer": "hr-officer",
  "procurement officer": "procurement-officer",
  "chief steward": "chief-steward",
  "events coordinator": "events-coordinator",
};

/**
 * Titles that genuinely need a human: the approved catalogue has no single
 * honest equivalent, so the platform must not guess. Night Audit is an
 * automated system process, never a human role.
 */
export const AMBIGUOUS_ROLE_NAMES = new Set([
  "general manager",
  "night auditor",
  "porter",
  "bell attendant",
  "duty manager",
]);

const STOP_WORDS = new Set(["and", "of", "the", "a", "or", "de"]);

/** Lowercase, strip punctuation, collapse repeated characters (typo tolerance). */
export function squash(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** Normalised comparison key: lowercase, single-spaced. */
export function normKey(value: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Significant words, with hospitality abbreviations expanded. */
export function roleTokens(value: string): string[] {
  const expanded = (value ?? "")
    .toLowerCase()
    .replace(/\bhr\b/g, "human resources")
    .replace(/\b(f&b|fnb)\b/g, "food beverage");
  return Array.from(
    new Set(
      expanded
        .split(/[^a-z0-9]+/)
        .filter((t) => t && !STOP_WORDS.has(t))
        .map(squash),
    ),
  ).sort();
}

/**
 * Resolves a role name to an approved catalogue key, or `null` when the name
 * needs a real human decision.
 */
export function resolveCatalogueRoleKey(name: string): string | null {
  if (!name?.trim()) return null;
  const key = normKey(name);

  const alias = ROLE_ALIASES[key];
  if (alias) return alias;
  if (AMBIGUOUS_ROLE_NAMES.has(key)) return null;

  const squashed = squash(name);
  const direct = Object.entries(CATALOGUE_ROLES).find(
    ([roleKey, roleName]) => squash(roleName) === squashed || squash(roleKey) === squashed,
  );
  if (direct?.[0]) return direct[0];

  const aliasSquash = Object.entries(ROLE_ALIASES).find(([alias]) => squash(alias) === squashed);
  if (aliasSquash?.[1]) return aliasSquash[1];

  // Token subset: every word of the given name appears in exactly one approved role.
  const tokens = roleTokens(name);
  if (!tokens.length) return null;
  const matches = Object.entries(CATALOGUE_ROLES).filter(([, roleName]) => {
    const catalogueTokens = new Set(roleTokens(roleName));
    return tokens.every((t) => catalogueTokens.has(t));
  });
  return matches.length === 1 ? (matches[0]?.[0] ?? null) : null;
}

/** The approved display name for a role name, or the original when unresolved. */
export function canonicalRoleName(name: string): string {
  const key = resolveCatalogueRoleKey(name);
  return (key ? CATALOGUE_ROLES[key] : name) ?? name;
}

/** True when a name still requires an administrator to decide. */
export function needsHumanDecision(name: string): boolean {
  return resolveCatalogueRoleKey(name) === null;
}
