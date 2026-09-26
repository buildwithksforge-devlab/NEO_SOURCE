/**
 * One property brand, expressed everywhere.
 *
 * A hotel configures its brand once, in the Experience Studio, and the same
 * resolved values are used by its public page, Stay & Dine, Partner and Rider
 * surfaces. Nothing here invents a hotel's identity: every value falls back to
 * the neutral NEØ palette until the hotel sets its own.
 */

export type PersonalityKey = "editorial" | "warm" | "modern" | "classic";

export type FontKey =
  | "plus-jakarta"
  | "inter"
  | "manrope"
  | "dm-sans"
  | "playfair"
  | "instrument-serif";

/** Only fonts the platform already loads may be chosen. */
export const fontCatalogue: Record<FontKey, { label: string; stack: string }> = {
  "plus-jakarta": { label: "Plus Jakarta Sans", stack: '"Plus Jakarta Sans", ui-sans-serif, sans-serif' },
  inter: { label: "Inter", stack: '"Inter", ui-sans-serif, sans-serif' },
  manrope: { label: "Manrope", stack: '"Manrope", ui-sans-serif, sans-serif' },
  "dm-sans": { label: "DM Sans", stack: '"DM Sans", ui-sans-serif, sans-serif' },
  playfair: { label: "Playfair Display", stack: '"Playfair Display", ui-serif, Georgia, serif' },
  "instrument-serif": { label: "Instrument Serif", stack: '"Instrument Serif", ui-serif, Georgia, serif' },
};

export const personalities: Record<
  PersonalityKey,
  { label: string; hint: string; display: FontKey; body: FontKey; radius: number }
> = {
  editorial: {
    label: "Editorial",
    hint: "Magazine-like. Serif headlines, generous space.",
    display: "instrument-serif",
    body: "plus-jakarta",
    radius: 18,
  },
  warm: {
    label: "Warm",
    hint: "Soft and hospitable. Rounded corners, friendly type.",
    display: "dm-sans",
    body: "dm-sans",
    radius: 26,
  },
  modern: {
    label: "Modern",
    hint: "Crisp and technical. Tight corners, neutral type.",
    display: "manrope",
    body: "inter",
    radius: 12,
  },
  classic: {
    label: "Classic",
    hint: "Traditional luxury. Formal serif headlines.",
    display: "playfair",
    body: "inter",
    radius: 8,
  },
};

/** Exactly what a hotel stores. Every field is optional until they choose it. */
export type ExperienceBrand = {
  personality?: PersonalityKey;
  primary?: string;
  accent?: string;
  surface?: string;
  ink?: string;
  display_font?: FontKey;
  body_font?: FontKey;
  radius?: number;
};

export type ExperienceMedia = {
  logo_url?: string | null;
  hero_url?: string | null;
  gallery?: string[];
};

export type ExperienceContent = {
  welcome_title?: string;
  welcome_message?: string;
  stay_note?: string;
  partner_note?: string;
  rider_note?: string;
};

/** Neutral NEØ values used until a hotel decides otherwise. */
export const brandDefaults = {
  personality: "editorial" as PersonalityKey,
  primary: "#18C4C8",
  accent: "#D5AF63",
  surface: "#020A1C",
  ink: "#F7F9FC",
  radius: 18,
};

export type ResolvedBrand = {
  personality: PersonalityKey;
  primary: string;
  accent: string;
  surface: string;
  ink: string;
  displayFont: string;
  bodyFont: string;
  radius: number;
  configured: boolean;
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function colour(value: unknown, fallback: string) {
  return typeof value === "string" && HEX.test(value.trim()) ? value.trim() : fallback;
}

export function resolveBrand(brand: ExperienceBrand | null | undefined): ResolvedBrand {
  const b = brand ?? {};
  const personality = (b.personality && personalities[b.personality] ? b.personality : brandDefaults.personality);
  const preset = personalities[personality];
  const displayKey = b.display_font && fontCatalogue[b.display_font] ? b.display_font : preset.display;
  const bodyKey = b.body_font && fontCatalogue[b.body_font] ? b.body_font : preset.body;
  return {
    personality,
    primary: colour(b.primary, brandDefaults.primary),
    accent: colour(b.accent, brandDefaults.accent),
    surface: colour(b.surface, brandDefaults.surface),
    ink: colour(b.ink, brandDefaults.ink),
    displayFont: fontCatalogue[displayKey].stack,
    bodyFont: fontCatalogue[bodyKey].stack,
    radius: typeof b.radius === "number" && b.radius >= 0 && b.radius <= 40 ? b.radius : preset.radius,
    configured: Boolean(b && Object.keys(b).length),
  };
}

/** CSS custom properties consumed by the public surfaces. */
export function brandStyle(brand: ExperienceBrand | null | undefined): React.CSSProperties {
  const r = resolveBrand(brand);
  return {
    ["--pb-primary" as string]: r.primary,
    ["--pb-accent" as string]: r.accent,
    ["--pb-surface" as string]: r.surface,
    ["--pb-ink" as string]: r.ink,
    ["--pb-display" as string]: r.displayFont,
    ["--pb-body" as string]: r.bodyFont,
    ["--pb-radius" as string]: `${r.radius}px`,
  } as React.CSSProperties;
}

/**
 * Whether a hotel genuinely offers a customer service.
 *
 * The same service has been stored under more than one key over the life of
 * the platform (`bookings` before `booking`, `restaurant_pickup` before
 * `pickup`). Reading a single key would hide a service a hotel really switched
 * on, so every surface asks this one resolver instead. It only ever widens to
 * keys that mean the same thing — it never invents a service.
 */
const serviceAliases: Record<string, string[]> = {
  hotel_information: ["hotel_information", "about", "information"],
  rooms: ["rooms", "booking", "bookings", "accommodation"],
  booking: ["booking", "bookings"],
  menu: ["menu", "digital_menu", "food_ordering", "restaurant", "restaurant_pickup", "room_service", "delivery"],
  food_ordering: ["food_ordering", "restaurant_pickup", "pickup", "delivery", "room_service"],
  pickup: ["pickup", "restaurant_pickup", "collection"],
  delivery: ["delivery"],
  room_service: ["room_service"],
  laundry_resident: ["laundry_resident"],
  laundry_public: ["laundry_public"],
  laundry_collection: ["laundry_collection"],
  laundry_delivery: ["laundry_delivery"],
  guest_requests: ["guest_requests", "requests", "concierge"],
  feedback: ["feedback", "reviews"],
};

export function serviceEnabled(
  services: Record<string, boolean> | null | undefined,
  key: string,
): boolean {
  if (!services) return false;
  const keys = serviceAliases[key] ?? [key];
  return keys.some((k) => Boolean(services[k]));
}
