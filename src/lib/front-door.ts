/**
 * NEØ front door.
 *
 * One entry experience in front of every hotel on the platform. The address
 * only proposes which hotel a person wants; which of the four entrances they
 * may actually use is always decided in the database, from real relationships.
 */
import { supabase } from "@/integrations/supabase/client";
import type {
  ExperienceBrand,
  ExperienceContent,
  ExperienceMedia,
} from "@/lib/experience-brand";

export type DoorKey = "stay_dine" | "work" | "partner" | "rider";

export const doorLabels: Record<DoorKey, string> = {
  stay_dine: "Stay & Dine",
  work: "Work",
  partner: "Partner",
  rider: "Rider",
};

export const doorDescriptions: Record<DoorKey, string> = {
  stay_dine: "Book a room, order food, send a request or open your stay.",
  work: "The hotel's staff workspace, for people employed here.",
  partner: "Suppliers, corporate clients, agents and contractors working with this hotel.",
  rider: "The delivery rider field app for authorised riders.",
};

export type DirectoryProperty = {
  branch_id: string;
  organization_id: string;
  public_slug: string;
  property_name: string;
  organization_name: string;
  tagline: string | null;
  summary: string | null;
  city: string | null;
  country: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  services: Record<string, boolean>;
  brand?: ExperienceBrand | null;
  media?: ExperienceMedia | null;
  /** Lowest active published nightly rate, from the hotel's own rate plans. */
  from_rate?: number | null;
  currency?: string | null;
  room_type_count?: number | null;
};

/** A room the hotel has configured, as shown to a visitor. */
export type PublicRoomType = {
  room_type_id: string;
  name: string;
  description: string | null;
  max_occupancy: number | null;
  bed_configuration: string | null;
  amenities: string[];
  images: string[];
  from_rate: number | null;
  currency: string | null;
};

/** The rooms and rates a listed hotel has already configured. */
export async function fetchPublicPropertyRooms(slug: string): Promise<PublicRoomType[]> {
  const { data, error } = await supabase.rpc("neo_public_property_rooms" as never, {
    _slug: slug,
  } as never);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PublicRoomType[];
}

export type PublicProperty = DirectoryProperty & {
  phone: string | null;
  email: string | null;
  address: string | null;
  doors: Record<DoorKey, boolean>;
  portal_slug: string | null;
  /** The hotel's own brand, media and words, configured in the Experience Studio. */
  brand?: ExperienceBrand | null;
  media?: ExperienceMedia | null;
  content?: ExperienceContent | null;
  /** False when the hotel has not opened a public page. */
  publicly_listed?: boolean;
  /** True when this hotel was resolved from the viewer's own relationship. */
  via_relationship?: boolean;
};

export type DoorState = { available: boolean; allowed: boolean; relationships?: string[] };

export type PropertyDoors = {
  found: boolean;
  branch_id?: string;
  organization_id?: string;
  signed_in?: boolean;
  stay_dine?: DoorState;
  work?: DoorState;
  partner?: DoorState;
  rider?: DoorState;
};

/** How a visitor may narrow the public hotel list. */
export type DirectoryFilters = {
  /** Free text: hotel, group, destination or published description. */
  search?: string;
  /** An exact destination (city, or country where no city is recorded). */
  place?: string | null;
  /** A published service key, e.g. rooms, dining, delivery, events. */
  service?: string | null;
};

/** Hotels that have deliberately switched on public discovery. */
export async function fetchPublicDirectory(
  filters: DirectoryFilters = {},
): Promise<DirectoryProperty[]> {
  const { data, error } = await supabase.rpc("neo_public_directory" as never, {
    _search: filters.search?.trim() || null,
    _limit: 60,
    _place: filters.place?.trim() || null,
    _service: filters.service?.trim() || null,
  } as never);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DirectoryProperty[];
}

export type Destination = { place: string; hotels: number };

/**
 * Every destination that has at least one publicly listed hotel. Read from the
 * platform rather than from the current page of results, so the places on offer
 * stay complete as the platform grows.
 */
export async function fetchPublicDestinations(): Promise<Destination[]> {
  const { data, error } = await supabase.rpc("neo_public_destinations" as never, {} as never);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Destination[];
}

/** One hotel's public front page, resolved from its public address. */
export async function fetchPublicProperty(slug: string): Promise<PublicProperty | null> {
  const { data, error } = await supabase.rpc("neo_public_property" as never, {
    _slug: slug,
  } as never);
  if (error) throw new Error(error.message);
  return (data as unknown as PublicProperty | null) ?? null;
}

/**
 * The same hotel, resolved from a real relationship instead of a public page.
 *
 * Public discovery is a marketing decision; it is not an access decision. A
 * hotel that never opened a public page still has staff, partners and riders,
 * and they must be able to reach it. This resolver returns a property only to
 * someone the database already recognises there, so nothing hidden is exposed.
 */
export async function fetchRelationshipProperty(key: string): Promise<PublicProperty | null> {
  const { data, error } = await supabase.rpc("neo_relationship_property" as never, {
    _key: key,
  } as never);
  if (error) throw new Error(error.message);
  return (data as unknown as PublicProperty | null) ?? null;
}

/**
 * Resolve a hotel address for whoever is asking: the public page first, and —
 * when the hotel is unlisted — the asker's own relationship with it.
 */
export async function fetchPropertyForVisitor(key: string): Promise<PublicProperty | null> {
  const open = await fetchPublicProperty(key);
  if (open) return open;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return fetchRelationshipProperty(key);
}

/** Which entrances the signed-in person may use at this hotel. */
export async function fetchPropertyDoors(branchId: string): Promise<PropertyDoors> {
  const { data, error } = await supabase.rpc("neo_property_doors" as never, {
    _branch: branchId,
  } as never);
  if (error) throw new Error(error.message);
  return (data as unknown as PropertyDoors) ?? { found: false };
}

export type MyEntrance = {
  branch_id: string;
  organization_id: string;
  property_name: string;
  organization_name: string;
  public_slug: string | null;
  portal_slug: string | null;
  logo_url: string | null;
  work: boolean;
  rider: boolean;
  partner: boolean;
};

/**
 * Hotels this signed-in person already has a real relationship with.
 *
 * This is a convenience shortcut so returning people need not search for their
 * hotel every morning. It never grants access: each entrance is still resolved
 * and enforced in the database when it is opened.
 */
export async function fetchMyEntrances(): Promise<MyEntrance[]> {
  const { data, error } = await supabase.rpc("neo_my_entrances" as never);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MyEntrance[];
}

/** Why an entrance is closed for this person — never a blank screen. */
export const doorRefusal: Record<DoorKey, string> = {
  stay_dine: "This hotel has not opened its guest experience yet.",
  work: "Your account is not an active staff account at this hotel. Ask the hotel's administrator.",
  partner:
    "No business relationship with portal access has been granted to your account by this hotel.",
  rider: "You are not registered as an active rider for this hotel.",
};
