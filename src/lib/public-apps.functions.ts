import { createServerFn } from "@tanstack/react-start";
import { brandFallback, type PublicAppKey, type PublicWorkspace } from "@/lib/public-apps";
type ResolveInput = { appKey: PublicAppKey; slug: string };

/**
 * Resolves a public app slug to its published workspace.
 *
 * Guest and Delivery consume their published projections. The legacy resolver
 * remains server-only for app keys that still use it.
 */
export const resolvePublicWorkspace = createServerFn({ method: "GET" })
  .inputValidator((input: ResolveInput): ResolveInput => ({
    appKey: input.appKey,
    slug: String(input.slug ?? "").trim().toLowerCase().slice(0, 80),
  }))
  .handler(async ({ data }): Promise<PublicWorkspace | null> => {
    if (data.appKey === "guest") {
      const { fetchPublicProperty } = await import("@/lib/front-door");
      const property = await fetchPublicProperty(data.slug);

      if (!property?.publicly_listed || property.doors?.stay_dine === false) {
        return null;
      }

      const heroUrl = property.media?.hero_url || property.cover_image_url || null;
      return {
        id: property.branch_id,
        organization_id: property.organization_id,
        branch_id: property.branch_id,
        app_key: "guest",
        slug: property.public_slug,
        published: true,
        app_name: "Stay & Dine",
        hotel_name: property.property_name,
        logo_url: property.media?.logo_url || property.logo_url || null,
        icon_url: null,
        hero_url: heroUrl,
        currency: property.currency ?? null,
        primary_color: property.brand?.primary || brandFallback.primary,
        secondary_color: property.brand?.accent || brandFallback.secondary,
        background_color:
          property.brand?.surface || brandFallback.background,
        button_style: "rounded",
        menu_style: "tabs",
        welcome_title:
          property.content?.welcome_title || property.property_name,
        welcome_message: property.content?.welcome_message || "",
        contact_phone: property.phone || null,
        contact_email: property.email || null,
        contact_address: property.address || null,
        support_details: null,
        terms_text: null,
        policy_text: null,
        features: property.services || {},
      };
    }

    if (data.appKey === "delivery") {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: workspace, error } = await supabase.rpc("neo_public_delivery_workspace" as never, {
        _slug: data.slug,
      } as never);
      if (error) throw new Error("Delivery publication could not be checked. Try again.");
      const delivery = workspace as PublicWorkspace | null;
      if (!delivery?.guest_slug) return delivery;
      const { fetchPublicProperty } = await import("@/lib/front-door");
      const property = await fetchPublicProperty(delivery.guest_slug).catch(() => null);
      if (!property || property.organization_id !== delivery.organization_id || property.branch_id !== delivery.branch_id) {
        return delivery;
      }
      return {
        ...delivery,
        hotel_name: property.property_name,
        logo_url: property.media?.logo_url || property.logo_url || delivery.logo_url,
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: workspace, error } = await supabaseAdmin.rpc("resolve_public_workspace", {
      _app_key: data.appKey,
      _slug: data.slug,
    });
    if (error) throw new Error("App publication could not be checked. Try again.");
    return workspace as PublicWorkspace | null;
  });
