/**
 * NEØ CONTEXT RESOLVER.
 *
 * Authentication answers "who is this person". It never answers "what are
 * they here as". This module answers the second question from real, already
 * existing relationships only: employment, a business relationship, a rider
 * registration, or a genuine stay history at a hotel.
 *
 * Nothing here creates a relationship. A guest context exists only because
 * the database already holds that person's stays — signing in never invents
 * one. Every destination is re-checked by its own route and row policies when
 * it opens; this resolver only decides where to knock first.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchMyEntrances } from "@/lib/front-door";
import { guardedRpc } from "@/lib/rpc-guard";

export type ContextKind = "work" | "guest" | "partner" | "rider";

export type NeoContext = {
  /** Stable key for remembering a choice: kind + property. */
  key: string;
  kind: ContextKind;
  branchId: string;
  organizationId: string;
  propertyName: string;
  organizationName: string | null;
  /** Public or portal address for the property, when it has one. */
  slug: string | null;
  logoUrl: string | null;
  /** Plain words for the person: what this entrance is. */
  label: string;
  /** Plain words: why this entrance exists for them. */
  detail: string;
  /** Where this context opens. */
  route: string;
};

const REMEMBERED_KEY = "neo.context";

/** A remembered choice is a convenience only; authorisation is re-resolved. */
export function readRememberedContext(): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED_KEY);
  } catch {
    return null;
  }
}

export function rememberContext(key: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_KEY, key);
  } catch {
    /* Storage is a convenience, never a system of record. */
  }
}

export function forgetContext(): void {
  try {
    window.localStorage.removeItem(REMEMBERED_KEY);
  } catch {
    /* ignore */
  }
}

type GuestHotel = {
  organization_id: string;
  branch_id: string;
  public_slug: string | null;
  display_name: string | null;
  stays: number | null;
};

/**
 * Every context this account genuinely holds, most operational first.
 *
 * Work comes before the rest because an employee signing in is at work; a
 * guest context is offered only when real stays exist for that account.
 */
export async function resolveMyContexts(): Promise<NeoContext[]> {
  const [entrances, guest] = await Promise.all([
    fetchMyEntrances().catch(() => []),
    (async () => {
      try {
        const { data } = await guardedRpc(supabase, "neo_guest_my_hotels", {});
        return (data ?? []) as unknown as GuestHotel[];
      } catch {
        return [] as GuestHotel[];
      }
    })(),
  ]);

  const out: NeoContext[] = [];

  for (const e of entrances) {
    const address = e.public_slug ?? e.portal_slug ?? e.branch_id;
    const base = {
      branchId: e.branch_id,
      organizationId: e.organization_id,
      propertyName: e.property_name,
      organizationName: e.organization_name,
      slug: e.public_slug ?? e.portal_slug,
      logoUrl: e.logo_url,
    };
    if (e.work) {
      out.push({
        ...base,
        key: `work:${e.branch_id}`,
        kind: "work",
        label: "Work",
        detail: "Your staff workspace and the screens your permissions reach.",
        route: "/workspace?home=1",
      });
    }
    if (e.partner) {
      out.push({
        ...base,
        key: `partner:${e.branch_id}`,
        kind: "partner",
        label: "Partner portal",
        detail: "Your business relationship with this hotel.",
        route: `/partner/${address}`,
      });
    }
    if (e.rider) {
      out.push({
        ...base,
        key: `rider:${e.branch_id}`,
        kind: "rider",
        label: "Rider workspace",
        detail: "Deliveries assigned to you.",
        route: "/rider",
      });
    }
  }

  for (const g of guest) {
    const address = g.public_slug ?? g.branch_id;
    out.push({
      key: `guest:${g.branch_id}`,
      kind: "guest",
      branchId: g.branch_id,
      organizationId: g.organization_id,
      propertyName: g.display_name ?? "Hotel",
      organizationName: null,
      slug: g.public_slug,
      logoUrl: null,
      label: "Guest",
      detail:
        (g.stays ?? 0) > 0
          ? "Your stay, orders and requests at this hotel."
          : "Your guest account at this hotel.",
      route: `/guest/${address}`,
    });
  }

  return out;
}

/** Restore a remembered context only when it is still genuinely held. */
export function revalidateRemembered(
  contexts: NeoContext[],
  remembered: string | null,
): NeoContext | null {
  if (!remembered) return null;
  return contexts.find((c) => c.key === remembered) ?? null;
}
