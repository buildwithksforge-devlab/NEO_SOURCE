import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

/**
 * A hotel's own branded staff entrance.
 *
 * The address in the URL only proposes which property the person intends to
 * work in. It never grants access: membership, property assignment and
 * permissions are always decided in the database after sign-in.
 */
export type PropertyEntrance = {
  branch_id: string;
  organization_id: string;
  property_name: string;
  organization_name: string;
  city: string | null;
  country: string | null;
  logo_url: string | null;
  branding: Record<string, unknown>;
  slug: string;
};

export type EntranceResult =
  | {
      allowed: true;
      branch_id: string;
      organization_id: string;
      property_name: string;
      access_scope: string;
      group_wide: boolean;
      assigned_property_count: number;
    }
  | { allowed: false; reason: string };

/** Resolve the branded entrance for a property address (no sign-in required). */
export async function resolvePropertyEntrance(slug: string): Promise<PropertyEntrance | null> {
  // Signed-out lookup: the guard refuses anonymous dispatch by design, so the
  // branded entrance page resolves its property through the anon-safe routine.
  const { data, error } = await supabase.rpc("neo_property_entrance", { _slug: slug });
  if (error) throw error;
  return (data as PropertyEntrance | null) ?? null;
}

/**
 * Confirm the signed-in person genuinely belongs to this property, and apply
 * that hotel's workspace context when they do.
 */
export async function enterProperty(branchId: string): Promise<EntranceResult> {
  const { data, error } = await guardedRpc(supabase, "neo_property_entrance_enter", { _branch: branchId });
  if (error) throw error;
  return data as unknown as EntranceResult;
}

export const entranceRefusal: Record<string, string> = {
  not_signed_in: "Please sign in to continue.",
  unknown_property: "This hotel entrance is not available.",
  not_a_member: "Your account does not belong to this hotel group.",
  not_assigned_to_property: "Your account is not assigned to this hotel. Ask your administrator.",
};
