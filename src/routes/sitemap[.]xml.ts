/**
 * sitemap.xml
 *
 * Only PUBLIC_INDEXABLE routes appear here, resolved through the canonical
 * route-visibility registry. Hotel pages are included for the properties that
 * deliberately switched on public discovery; a guest's stay, order, folio or
 * account URL can never enter this file.
 */
import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { canonicalUrl, sitemapPaths } from "@/lib/route-visibility";
import { trustedRpc } from "@/lib/rpc-guard";

async function publicPropertySlugs(): Promise<string[]> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return [];
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await trustedRpc(client, "neo_public_directory", {
      _search: null,
      _limit: 200,
    });
    if (error) return [];
    return ((data ?? []) as { slug?: string; public_slug?: string }[])
      .map((row) => row.slug ?? row.public_slug)
      .filter((slug): slug is string => Boolean(slug));
  } catch {
    return [];
  }
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const slugs = await publicPropertySlugs();
        const urls = sitemapPaths(slugs).map((path) =>
          [
            `  <url>`,
            `    <loc>${canonicalUrl(path)}</loc>`,
            `    <changefreq>daily</changefreq>`,
            `  </url>`,
          ].join("\n"),
        );

        const xml = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
          ...urls,
          `</urlset>`,
        ].join("\n");

        return new Response(xml, {
          headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
        });
      },
    },
  },
});
