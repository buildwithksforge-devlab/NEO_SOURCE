import { createServerFn } from "@tanstack/react-start";
import type { PublicAppKey, PublicWorkspace } from "@/lib/public-apps";

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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error } = await supabaseAdmin.rpc("resolve_public_workspace", {
      _app_key: data.appKey,
      _slug: data.slug,
    });
    if (error) return null;
    return (row as PublicWorkspace | null) ?? null;
  });

