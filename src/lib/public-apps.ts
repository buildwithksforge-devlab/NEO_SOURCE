/**
 * Public (customer and rider facing) application vocabulary.
 *
 * A public workspace is one hotel's published Guest, Delivery or Rider app.
 * The slug in the URL is resolved server-side into an organisation + branch,
 * so the browser never dictates which tenant it is looking at.
 */

export type PublicAppKey = "guest" | "delivery" | "rider";

export const publicAppLabels: Record<PublicAppKey, string> = {
  guest: "Guest App",
  delivery: "Delivery App",
  rider: "Rider App",
};

export type PublicWorkspace = {
  id: string;
  organization_id: string;
  branch_id: string | null;
  app_key: PublicAppKey;
  slug: string;
  published: boolean;
  app_name: string;
  hotel_name: string;
  logo_url: string | null;
  icon_url: string | null;
  primary_color: string;
  secondary_color: string;
  background_color: string;
  button_style: "rounded" | "pill" | "square";
  menu_style: "tabs" | "drawer" | "floating";
  welcome_title: string;
  welcome_message: string;
  contact_phone: string | null;
  contact_email: string | null;
  contact_address: string | null;
  support_details: string | null;
  terms_text: string | null;
  policy_text: string | null;
  features: Record<string, boolean>;
};

/**
 * Clean system fallbacks so an unconfigured workspace never renders broken.
 *
 * `steel` is the muted text colour on the light public ground. It is deliberately
 * darker than the decorative brand grey so small secondary text clears WCAG AA
 * (4.5:1) against white; `steelSoft` keeps the lighter tone for non-text use.
 */
export const brandFallback = {
  primary: "#18C4C8",
  secondary: "#07142D",
  background: "#F7F9FC",
  navy: "#020A1C",
  steel: "#5A6880",
  steelSoft: "#8290A6",
  mist: "#E8EDF3",
};

export function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "workspace"
  );
}

export function buttonRadius(style: PublicWorkspace["button_style"]) {
  if (style === "pill") return "9999px";
  if (style === "square") return "6px";
  return "14px";
}

/** Initials used when no logo has been uploaded. */
export function brandInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!parts.length) return "NEØ";
  return parts.map((p) => p[0]!.toUpperCase()).join("");
}

export function isFeatureEnabled(ws: PublicWorkspace, key: string, fallback = true) {
  const value = ws.features?.[key];
  return typeof value === "boolean" ? value : fallback;
}

/** Public link for a workspace, used by Administration → App Branding. */
export function publicAppPath(appKey: PublicAppKey, slug: string) {
  return appKey === "rider" ? "/rider" : `/${appKey}/${slug}`;
}
