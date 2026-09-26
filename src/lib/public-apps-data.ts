/**
 * Administration data layer for publishing the public Guest, Delivery and
 * Rider applications.
 *
 * A publication record is one row in `public_workspaces` per organisation and
 * app key. Saving a draft writes the row with status `draft`; publishing flips
 * it to `published` and stamps who published it and when. Nothing here creates
 * a second delivery app or a second table — the same row backs the public
 * routes through `resolve_public_workspace`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { publicAppPath, slugify, type PublicAppKey } from "@/lib/public-apps";

const db = supabase as unknown as { from: (t: string) => any; rpc: (n: string, a?: any) => any };

export type PublishStatus = "draft" | "published" | "unpublished";

export type WorkspaceRecord = {
  id: string;
  organization_id: string;
  branch_id: string | null;
  app_key: PublicAppKey;
  slug: string;
  published: boolean;
  status: PublishStatus;
  app_name: string;
  hotel_name: string;
  logo_url: string | null;
  icon_url: string | null;
  primary_color: string;
  secondary_color: string;
  background_color: string;
  button_style: string;
  menu_style: string;
  welcome_title: string;
  welcome_message: string;
  contact_phone: string | null;
  contact_email: string | null;
  contact_address: string | null;
  settings: Record<string, unknown>;
  published_at: string | null;
  published_by: string | null;
  published_by_name: string | null;
  unpublished_at: string | null;
  draft_saved_at: string | null;
  updated_at: string;
};

const SELECT =
  "id, organization_id, branch_id, app_key, slug, published, status, app_name, hotel_name, logo_url, icon_url, primary_color, secondary_color, background_color, button_style, menu_style, welcome_title, welcome_message, contact_phone, contact_email, contact_address, settings, published_at, published_by, published_by_name, unpublished_at, draft_saved_at, updated_at";

export const workspacesKey = (org: string | null) => ["public-workspaces", org];

/** Every publication record for the signed-in organisation. */
export function usePublicWorkspaces() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: workspacesKey(organizationId),
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<WorkspaceRecord[]> => {
      const { data, error } = await db
        .from("public_workspaces")
        .select(SELECT)
        .eq("organization_id", organizationId);
      if (error) throw new Error(error.message);
      return (data ?? []) as WorkspaceRecord[];
    },
  });
}

export function useBranchOptions() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["publish-branches", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("branches")
        .select("id, name, code, is_main, active, phone, email, address")
        .eq("organization_id", organizationId)
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as {
        id: string;
        name: string;
        code: string | null;
        is_main: boolean | null;
        active: boolean | null;
        phone: string | null;
        email: string | null;
        address: string | null;
      }[];
    },
  });
}

export function useOrganization() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["publish-organization", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("organizations")
        .select("id, name")
        .eq("id", organizationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as { id: string; name: string } | null;
    },
  });
}

/** Operational readiness facts for the selected branch (delivery specific). */
export function useDeliveryReadinessFacts(branchId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["publish-delivery-facts", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const menus = await db
        .from("menus")
        .select("id, name, status, branch_id")
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId)
        .eq("status", "active");
      if (menus.error) throw new Error(menus.error.message);

      const settings = await db
        .from("delivery_settings")
        .select(
          "id, delivery_enabled, pickup_enabled, cod_enabled, allowed_payment_methods, branch_id",
        )
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId)
        .maybeSingle();
      if (settings.error && settings.error.code !== "PGRST116") {
        throw new Error(settings.error.message);
      }

      const zones = await db
        .from("delivery_zones")
        .select("id, name, active, branch_id")
        .eq("organization_id", organizationId)
        .eq("branch_id", branchId)
        .eq("active", true);
      if (zones.error) throw new Error(zones.error.message);

      return {
        activeMenus: (menus.data ?? []).length as number,
        settings: (settings.data ?? null) as {
          delivery_enabled: boolean;
          pickup_enabled: boolean;
          cod_enabled: boolean;
          allowed_payment_methods: string[] | null;
        } | null,
        activeZones: (zones.data ?? []).length as number,
      };
    },
  });
}

export type DraftInput = {
  appKey: PublicAppKey;
  branchId: string | null;
  slug: string;
  appName: string;
  hotelName: string;
  contactPhone: string;
  contactEmail: string;
  contactAddress: string;
  openingTime: string;
  closingTime: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  welcomeTitle: string;
  welcomeMessage: string;
  logoUrl: string | null;
  iconUrl: string | null;
  menuStyle: string;
};

function draftToRow(input: DraftInput, organizationId: string) {
  return {
    organization_id: organizationId,
    app_key: input.appKey,
    branch_id: input.branchId,
    slug: slugify(input.slug || input.hotelName || input.appName),
    app_name: input.appName,
    hotel_name: input.hotelName,
    contact_phone: input.contactPhone || null,
    contact_email: input.contactEmail || null,
    contact_address: input.contactAddress || null,
    primary_color: input.primaryColor,
    secondary_color: input.secondaryColor,
    background_color: input.backgroundColor,
    welcome_title: input.welcomeTitle,
    welcome_message: input.welcomeMessage,
    logo_url: input.logoUrl,
    icon_url: input.iconUrl,
    menu_style: input.menuStyle,
    settings: {
      operating_hours: { opens: input.openingTime, closes: input.closingTime },
    },
    draft_saved_at: new Date().toISOString(),
  };
}

/** Creates or updates the draft publication record. */
export function useSaveWorkspaceDraft() {
  const { organizationId } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DraftInput): Promise<WorkspaceRecord> => {
      if (!organizationId) throw new Error("No organisation in session");
      const row = draftToRow(input, organizationId);
      const existing = await db
        .from("public_workspaces")
        .select("id, status")
        .eq("organization_id", organizationId)
        .eq("app_key", input.appKey)
        .maybeSingle();
      if (existing.error && existing.error.code !== "PGRST116") {
        throw new Error(existing.error.message);
      }
      const query = existing.data?.id
        ? db.from("public_workspaces").update(row).eq("id", existing.data.id)
        : db.from("public_workspaces").insert({ ...row, status: "draft", published: false });
      const { data, error } = await query.select(SELECT).single();
      if (error) throw new Error(error.message);
      return data as WorkspaceRecord;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey(organizationId) }),
  });
}

/** Publishes the app: persists the draft, then stamps the publication record. */
export function usePublishWorkspace() {
  const { organizationId, profile, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DraftInput): Promise<WorkspaceRecord> => {
      if (!organizationId) throw new Error("No organisation in session");
      const row = draftToRow(input, organizationId);
      const publisher =
        (profile as { full_name?: string } | null)?.full_name || user?.email || "Administrator";
      const stamped = {
        ...row,
        status: "published" as const,
        published: true,
        published_at: new Date().toISOString(),
        published_by: user?.id ?? null,
        published_by_name: publisher,
        unpublished_at: null,
      };
      const existing = await db
        .from("public_workspaces")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("app_key", input.appKey)
        .maybeSingle();
      if (existing.error && existing.error.code !== "PGRST116") {
        throw new Error(existing.error.message);
      }
      const query = existing.data?.id
        ? db.from("public_workspaces").update(stamped).eq("id", existing.data.id)
        : db.from("public_workspaces").insert(stamped);
      const { data, error } = await query.select(SELECT).single();
      if (error) throw new Error(error.message);
      return data as WorkspaceRecord;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey(organizationId) }),
  });
}

/** Takes a live app offline without deleting its publication record. */
export function useUnpublishWorkspace() {
  const { organizationId } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db
        .from("public_workspaces")
        .update({
          published: false,
          status: "unpublished",
          unpublished_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey(organizationId) }),
  });
}

export function publicUrlFor(appKey: PublicAppKey, slug: string) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${publicAppPath(appKey, slug)}`;
}
