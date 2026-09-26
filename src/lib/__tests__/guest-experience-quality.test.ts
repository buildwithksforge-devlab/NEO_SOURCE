/**
 * Guest experience quality contract.
 *
 * These are the promises the public guest surfaces must keep: images reserve
 * their space, loading states are the size of the content they replace, tap
 * targets are reachable on a phone, and a page that belongs to one guest is
 * never offered to a search engine.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { responsiveSrcSet, sizedSource } from "@/lib/responsive-image";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const PRIVATE_GUEST_ROUTES = [
  "src/routes/guest.$hotelSlug.account.tsx",
  "src/routes/guest.$hotelSlug.orders.tsx",
  "src/routes/guest.$hotelSlug.trips.tsx",
  "src/routes/guest.$hotelSlug.transport.tsx",
  "src/routes/guest.$hotelSlug.track.tsx",
  "src/routes/guest.$hotelSlug.reservations.$reservationReference.tsx",
];

describe("responsive image sources", () => {
  it("asks storage for a sized rendition", () => {
    const url = "https://example.supabase.co/storage/v1/object/public/menu/item.jpg";
    const srcSet = responsiveSrcSet(url, [64, 128]);
    expect(srcSet).toContain("/storage/v1/render/image/public/menu/item.jpg?width=64");
    expect(srcSet).toContain("128w");
  });

  it("returns no srcset for an origin that cannot resize", () => {
    expect(responsiveSrcSet("https://hotel.example.com/photo.jpg", [64, 128])).toBeNull();
    expect(responsiveSrcSet("data:image/png;base64,AAA", [64])).toBeNull();
    expect(responsiveSrcSet(null, [64])).toBeNull();
  });

  it("falls back to the original when no rendition is possible", () => {
    expect(sizedSource("https://hotel.example.com/photo.jpg", 320)).toBe(
      "https://hotel.example.com/photo.jpg",
    );
  });
});

describe("layout stability", () => {
  it("reserves space for every guest image", () => {
    const image = read("src/components/public/GuestImage.tsx");
    expect(image).toContain("aspectRatio");
    expect(image).toContain("width={width}");
    expect(image).toContain("height={height}");
  });

  it("uses content-shaped skeletons instead of a bare spinner", () => {
    for (const path of [
      "src/routes/guest.$hotelSlug.explore.tsx",
      "src/routes/guest.$hotelSlug.track.tsx",
      "src/routes/guest.$hotelSlug.index.tsx",
    ]) {
      const source = read(path);
      expect(source).toMatch(/GuestRowsSkeleton|GuestCardsSkeleton/);
      expect(source).not.toContain("animate-spin");
    }
  });

  it("marks the hotel hero as the priority image and everything else lazy", () => {
    const start = read("src/routes/start.$propertySlug.tsx");
    expect(start).toContain("priority");
    const cover = read("src/components/public/NeoPublic.tsx");
    expect(cover).toContain('loading={priority ? "eager" : "lazy"}');
  });
});

describe("accessibility", () => {
  it("keeps the guest tab bar above the minimum touch target", () => {
    const shell = read("src/components/public/GuestScreen.tsx");
    expect(shell).toContain("min-h-11");
    expect(shell).toContain('aria-current={isActive ? "page" : undefined}');
  });

  it("uses a muted text colour that clears WCAG AA on white", () => {
    const tokens = read("src/lib/public-apps.ts");
    expect(tokens).toContain('steel: "#5A6880"');
  });
});

describe("privacy", () => {
  it("keeps personal guest pages out of search results", () => {
    for (const path of PRIVATE_GUEST_ROUTES) {
      expect(read(path), path).toContain('{ name: "robots", content: "noindex, nofollow" }');
    }
  });

  it("still lets the public hotel and menu pages be found", () => {
    for (const path of [
      "src/routes/start.$propertySlug.tsx",
      "src/routes/guest.$hotelSlug.explore.tsx",
    ]) {
      expect(read(path), path).not.toContain('content: "noindex');
    }
  });
});

describe("structured data", () => {
  it("describes the hotel only from published facts", () => {
    const start = read("src/routes/start.$propertySlug.tsx");
    expect(start).toContain('"@type": "Hotel"');
    expect(start).toContain("property.property_name");
    // Optional facts are spread in conditionally, never defaulted.
    expect(start).toContain("...(property.phone ? { telephone: property.phone } : {})");
  });
});
