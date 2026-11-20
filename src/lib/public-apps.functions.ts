import { createServerFn } from "@tanstack/react-start";
import { brandFallback, type PublicAppKey, type PublicWorkspace } from "@/lib/public-apps";
import type { PublicProperty } from "@/lib/front-door";

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
    slug: String(input.slug ?? "").trim().toLowerCase().slice(0, 80),
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

    if (error) throw new Error("App publication could not be checked. Try again.");
    if (data.appKey !== "delivery") return row as PublicWorkspace | null;

    const propertyResult = await supabaseAdmin.rpc("neo_public_property", { _slug: data.slug });
    if (propertyResult.error && !row) throw new Error("Delivery publication could not be checked. Try again.");
    let property = propertyResult.data as PublicProperty | null;
    let workspace = row as PublicWorkspace | null;
    // Experience Studio shares the property's slug, while App Branding can
    // publish a different Delivery slug. Resolve the alias by property ID.
    if (!workspace && property?.branch_id) {
      const result = await supabaseAdmin.from("public_workspaces")
        .select("id,organization_id,branch_id,app_key,slug,published,app_name,hotel_name,logo_url,icon_url,primary_color,secondary_color,background_color,button_style,menu_style,welcome_title,welcome_message,contact_phone,contact_email,contact_address,support_details,terms_text,policy_text,features")
        .eq("organization_id", property.organization_id)
        .eq("branch_id", property.branch_id)
        .eq("app_key", "delivery")
        .eq("published", true)
        .limit(2);
      if (result.error) throw new Error("Delivery publication could not be checked. Try again.");
      if (result.data.length !== 1) return null;
      workspace = result.data[0] as PublicWorkspace;
    }
    if (!workspace) return null;
    if (workspace.branch_id && (property?.branch_id !== workspace.branch_id || property.organization_id !== workspace.organization_id)) {
      const { data: experience } = await supabaseAdmin.from("neo_public_experience")
        .select("public_slug").eq("branch_id", workspace.branch_id).maybeSingle();
      if (experience?.public_slug && experience.public_slug !== data.slug) {
        const result = await supabaseAdmin.rpc("neo_public_property", { _slug: experience.public_slug });
        property = result.data as PublicProperty | null;
      }
    }
    if (property?.branch_id !== workspace.branch_id || property.organization_id !== workspace.organization_id) {
      return workspace;
    }
    return {
      ...workspace,
      ...(property.publicly_listed && property.doors?.stay_dine !== false ? { guest_slug: property.public_slug } : {}),
      logo_url: workspace.logo_url || property.media?.logo_url || property.logo_url,
      hero_url: property.media?.hero_url || property.cover_image_url,
      currency: property.currency ?? null,
      contact_phone: workspace.contact_phone || property.phone || null,
      contact_email: workspace.contact_email || property.email || null,
      contact_address: workspace.contact_address || property.address || null,
      primary_color: workspace.primary_color || property.brand?.primary || brandFallback.primary,
      secondary_color: workspace.secondary_color || property.brand?.accent || brandFallback.secondary,
      background_color: workspace.background_color || property.brand?.surface || brandFallback.background,
    };
  })
