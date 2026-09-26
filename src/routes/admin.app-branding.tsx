/**
 * Retired screen.
 *
 * App Branding used to hold three separate imaginary "apps" (guest, delivery,
 * rider) with their own colours and welcome screens. A hotel has one brand, so
 * that model has been replaced by the Experience Studio, which writes to the
 * same record the public surfaces actually read.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin/app-branding")({
  head: () => ({
    meta: [
      { title: "App Branding has moved — System Administration" },
      {
        name: "description",
        content:
          "Branding for this property is now configured in the Experience Studio, together with media, welcome words, customer services and publishing.",
      },
      { property: "og:title", content: "App Branding has moved — System Administration" },
      { property: "og:description", content: "Branding now lives in the Experience Studio." },
    ],
  }),
  component: AppBrandingMoved,
});

function AppBrandingMoved() {
  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Branding"
        title="Branding has moved"
        description="A hotel has one brand, not three. Colours, type, logo, photography, welcome words, customer services and publishing are now configured together, for one property at a time."
      />
      <SectionCard
        title="Experience Studio"
        description="Everything customers, partners and riders see for this property, with a live preview."
      >
        <Button asChild>
          <Link to="/admin/experience-studio">
            Open the Experience Studio <ArrowRight className="size-4" />
          </Link>
        </Button>
      </SectionCard>
    </div>
  );
}
