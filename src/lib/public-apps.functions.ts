import { createServerFn } from "@tanstack/react-start";
import { brandFallback, type PublicAppKey, type PublicWorkspace } from "@/lib/public-apps";

type ResolveInput = { appKey: PublicAppKey; slug: string };

/**
 * Resolves a public app slug to its published workspace.
 *
 * Runs server-side only: the lookup routine is no longer callable by signed-out
 * clients directly. It only ever returns published rows and never returns
 * internal columns, so an invalid slug simply yields null rather than leaking
 * tenant existence.
 */
export const resolvePublicWorkspace = createServerFn({ method: "GET" })
  .inputValidator((input: ResolveInput): ResolveInput => ({
    appKey: input.appKey,
    slug: String(input.slug ?? "").slice(0, 80),
  }))
  .handler(async ({ data }): Promise<PublicWorkspace | null> => {
    if (data.appKey === "guest") {
      const { fetchPublicProperty } = await import("@/lib/front-door");
      const property = await fetchPublicProperty(data.slug);

      if (!property?.publicly_listed || property.doors?.stay_dine === false) {
        return null;
      }

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
        icon_url:
          property.media?.hero_url || property.cover_image_url || null,
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

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const { data: row, error } = await supabaseAdmin.rpc(
      "resolve_public_workspace",
      {
        _app_key: data.appKey,
        _slug: data.slug,
      },
    );

    if (error) return null;
    return (row as PublicWorkspace | null) ?? null;
  })
