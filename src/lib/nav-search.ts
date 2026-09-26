import type { LucideIcon } from "lucide-react";
import { SETTINGS_CATEGORIES, entryCapability } from "./settings-catalogue";
import { navigationForAccess, type CanFn } from "./nav-permissions";


/**
 * Navigation search index.
 *
 * This indexes PAGES only — never guests, reservations, orders, inventory or
 * any other operational record. Entries are derived from the same navigation
 * definitions the sidebar renders, so an unauthorized page can never surface.
 */
export type NavSearchEntry = {
  label: string;
  to: string;
  icon: LucideIcon;
  module: string;
  keywords: string;
};

/** Common alternative terminology mapped onto route keywords. */
const SYNONYMS: { match: RegExp; terms: string }[] = [
  { match: /^\/pms/, terms: "front office reception rooms bedrooms accommodation lodging booking stay checkin check-in checkout" },
  { match: /^\/pms\/rooms/, terms: "room types rack inventory bedroom housekeeping status" },
  { match: /^\/pms\/rack/, terms: "room rack grid room plan occupancy" },
  { match: /^\/pms\/availability/, terms: "room availability inventory allotment" },
  { match: /^\/pms\/folios/, terms: "room charges bills postings guest ledger" },
  { match: /^\/guests/, terms: "guest folios room charges visitors" },
  { match: /^\/pos/, terms: "restaurant bar cashier till waiter menu food beverage sales orders" },
  { match: /^\/kitchen/, terms: "chef production recipes food kitchen stores waste" },
  { match: /^\/housekeeping/, terms: "cleaning rooms room board linen turndown inspection lost found" },
  { match: /^\/laundry/, terms: "linen washing guest laundry" },
  { match: /^\/inventory/, terms: "stock items stock counts stock transfers stock adjustments stores warehouse goods" },
  { match: /^\/procurement/, terms: "purchasing suppliers lpo purchase orders grn goods received stock" },
  { match: /^\/lpos/, terms: "local purchase order lpo procurement supplier" },
  { match: /^\/finance/, terms: "accounting ledger journals payables receivables tax banking money revenue" },
  { match: /^\/crm/, terms: "customers guests loyalty feedback segments profiles relationship" },
  { match: /^\/marketing/, terms: "campaigns promotions leads reviews referrals communications" },
  { match: /^\/events/, terms: "conference banqueting functions weddings meetings venue" },
  { match: /^\/hr/, terms: "human resources staff employees payroll leave attendance recruitment training people" },
  { match: /^\/users/, terms: "staff system users accounts team members profiles invitations" },
  { match: /^\/roles/, terms: "staff permissions access control security rbac" },
  { match: /^\/departments/, terms: "staff department stations teams units" },
  { match: /^\/stations/, terms: "operational stations outlets service points kitchen bar restaurant departments properties branches" },
  { match: /^\/delivery/, terms: "riders orders dispatch takeaway food delivery" },
  { match: /^\/maintenance/, terms: "engineering work orders repairs assets facilities" },
  { match: /^\/analytics/, terms: "bi reports insights kpi metrics charts" },
  { match: /^\/reports/, terms: "reporting exports statements analytics" },
  { match: /^\/ai-insights/, terms: "neo intelligence ai assistant recommendations" },
  { match: /^\/settings/, terms: "system settings configuration preferences organization property settings" },
  { match: /^\/audit-logs/, terms: "audit trail history security log" },
  { match: /^\/approvals/, terms: "authorisation sign off requests" },
  { match: /^\/platform/, terms: "integrations environments subscription migration quality releases support" },
  { match: /^\/admin\/branches/, terms: "property properties branch manage properties locations sites hotels outlets" },
  { match: /^\/admin\/regional/, terms: "property settings timezone currency language country tax" },
  { match: /^\/admin\/brand-identity/, terms: "property branding logo colours theme" },
  { match: /^\/admin\/app-branding/, terms: "property branding guest app delivery app rider app publishing" },
  { match: /^\/admin\/workspace-preview/, terms: "property role preview simulate workspace" },
  { match: /^\/admin\/capability-map/, terms: "diagnostics capability map navigation widget gate developer" },
  { match: /^\/admin\/user-defaults/, terms: "staff invitation defaults new user defaults" },
  { match: /^\/admin\/hotel-information/, terms: "organization company profile property information" },
  { match: /^\/admin/, terms: "administration system settings organization setup" },
];

function synonymsFor(to: string) {
  return SYNONYMS.filter((s) => s.match.test(to))
    .map((s) => s.terms)
    .join(" ");
}

/** Builds the searchable index for exactly the pages this user may open. */
export function buildNavSearchIndex(
  _roleNames: string[],
  isAdmin: boolean,
  can?: CanFn,
  permissionsLoaded = false,
): NavSearchEntry[] {
  const entries: NavSearchEntry[] = [];

  // Effective permissions decide what is searchable — never a role name.
  const groups = can
    ? navigationForAccess(can, isAdmin, permissionsLoaded)
    : navigationForAccess(() => false, isAdmin, false);


  for (const group of groups) {
    for (const item of group.items) {
      entries.push({
        label: item.label,
        to: item.to,
        icon: item.icon,
        module: group.title,
        keywords: `${item.label} ${group.title} ${item.to.replace(/[/-]/g, " ")} ${synonymsFor(item.to)}`.toLowerCase(),
      });
    }
  }

  // Configuration Centre pages are indexed from the same catalogue the centre
  // renders, filtered by the capability each entry declares — never by a role
  // name and never by a blanket "is admin" flag.
  for (const category of SETTINGS_CATEGORIES) {
    for (const entry of category.entries) {
      if (!entry.to) continue;
      const capability = entryCapability(entry);
      if (capability && !(can && can(capability.module, capability.feature, capability.action))) {
        continue;
      }
      if (!capability && !isAdmin) continue;
      entries.push({
        label: entry.label,
        to: entry.to,
        icon: entry.icon,
        module: `Configuration Centre · ${category.title}`,
        keywords: `${entry.label} ${category.title} configuration settings ${(entry.keywords ?? []).join(" ")} ${entry.to.replace(/[/-]/g, " ")} ${synonymsFor(entry.to)}`.toLowerCase(),
      });
    }
  }


  return entries;
}

/** Case-insensitive, partial, multi-token matching with simple relevance ranking. */
export function searchNav(index: NavSearchEntry[], query: string, limit = 12): NavSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);

  return index
    .map((entry) => {
      let score = 0;
      for (const token of tokens) {
        const label = entry.label.toLowerCase();
        if (label.startsWith(token)) score += 6;
        else if (label.includes(token)) score += 4;
        else if (entry.keywords.includes(token)) score += 2;
        else return null;
      }
      return { entry, score };
    })
    .filter((r): r is { entry: NavSearchEntry; score: number } => r !== null)
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
    .slice(0, limit)
    .map((r) => r.entry);
}
