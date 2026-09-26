import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BedDouble, Heart, Loader2, LogOut, Receipt, Shirt, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AvatarUploader } from "@/components/common/AvatarDisplay";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import {
  useGuestAddresses,
  useGuestProfile,
  useGuestScreenView,
  useUpdateGuestProfile,
} from "@/lib/guest-app";

export const Route = createFileRoute("/guest/$hotelSlug/account")({
  head: () => ({
    meta: [
      { title: "My Account — NEØ Guest" },
      { name: "description", content: "Your guest profile, photo, saved addresses and communication preferences." },
      { property: "og:title", content: "My Account — NEØ Guest" },
      { property: "og:description", content: "Your guest profile, photo, saved addresses and communication preferences." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      // Personal to one guest: never a search result.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customer = profile.data;
  const customerId = customer?.["id"] as string | undefined;
  const addresses = useGuestAddresses(ws.organization_id, customerId);
  const update = useUpdateGuestProfile(ws.organization_id);
  useGuestScreenView(ws.organization_id, "account", Boolean(customerId));

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    setFullName(String(customer?.["full_name"] ?? ""));
    setPhone(String(customer?.["phone"] ?? ""));
  }, [customer]);

  if (!loading && !user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="account">
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to your account"
          description="Your profile, saved places, stays, orders, bills and service history stay private."
        />
      </GuestScreen>
    );
  }

  if (profile.isLoading) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="account">
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      </GuestScreen>
    );
  }

  if (!customer) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="account">
        <GuestSection title="No guest profile yet">
          <PublicEmptyState
            title="Your account is not linked to this property"
            description="Complete a booking or ask the front desk to invite you, and your profile will link to your existing record — never a duplicate."
          />
        </GuestSection>
      </GuestScreen>
    );
  }

  async function save() {
    try {
      await update.mutateAsync({ fullName, phone });
      toast.success("Profile updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile");
    }
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="account">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          My account
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Guest number {String(customer["customer_number"] ?? "—")} ·{" "}
          {String(customer["guest_account_status"] ?? "active")}
        </p>
      </section>

      <GuestSection title="My hotel activity" description="Everything you can manage without entering the hotel operating system.">
        <nav className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Account activity">
          {[
            { to: "/guest/$hotelSlug/trips", label: "Stays & requests", detail: "Bookings, room context and requests", icon: BedDouble },
            { to: "/guest/$hotelSlug/orders", label: "Orders", detail: "Food, delivery and live status", icon: Receipt },
            { to: "/guest/$hotelSlug/folio", label: "Bills & receipts", detail: "Your own folio and confirmed payments", icon: Sparkles },
            { to: "/guest/$hotelSlug/laundry", label: "Laundry", detail: "Prices, requests and progress", icon: Shirt },
            { to: "/guest/$hotelSlug/explore", label: "Saved dishes", detail: "Return to favourites and the live menu", icon: Heart },
          ].map((entry) => {
            const Icon = entry.icon;
            return (
              <Link key={entry.to} to={entry.to} params={{ hotelSlug }} className="neo-rider-card flex min-w-0 items-start gap-3 p-4">
                <Icon className="mt-0.5 size-4 shrink-0" style={{ color: ws.primary_color }} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold" style={{ color: brandFallback.secondary }}>{entry.label}</span>
                  <span className="neo-line-2 block text-xs" style={{ color: brandFallback.steel }}>{entry.detail}</span>
                </span>
              </Link>
            );
          })}
        </nav>
      </GuestSection>

      <GuestSection title="Profile photo">
        <AvatarUploader
          path={(customer["avatar_url"] as string | null) ?? null}
          name={String(customer["full_name"] ?? "")}
          onChange={async (next) => {
            await update.mutateAsync({ avatarUrl: next });
          }}
        />
      </GuestSection>

      <GuestSection title="My details">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="guest-name">Full name</Label>
            <Input id="guest-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="guest-phone">Phone</Label>
            <Input id="guest-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <p className="text-sm" style={{ color: brandFallback.steel }}>
              {String(customer["email"] ?? "—")} (verified sign-in address)
            </p>
          </div>
          <BrandButton onClick={() => void save()} disabled={update.isPending || !fullName.trim()}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save changes
          </BrandButton>
        </div>
      </GuestSection>

      <GuestSection title="Communication preferences">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm" style={{ color: brandFallback.secondary }}>
            Receive offers and news from {ws.hotel_name}
          </span>
          <Switch
            checked={Boolean(customer["marketing_consent"])}
            onCheckedChange={(checked) => {
              void update
                .mutateAsync({ marketingConsent: checked })
                .then(() => toast.success("Preference saved"))
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : "Could not save"),
                );
            }}
          />
        </div>
      </GuestSection>

      <GuestSection title="Saved addresses">
        {(addresses.data?.length ?? 0) === 0 ? (
          <PublicEmptyState
            title="No saved addresses"
            description="Addresses you use for delivery are saved here."
          />
        ) : (
          <ul className="space-y-2">
            {(addresses.data ?? []).map((a) => (
              <li key={String(a["id"])} className="rounded-xl border border-black/5 p-3 text-sm">
                <span className="font-medium" style={{ color: brandFallback.secondary }}>
                  {String(a["label"] ?? "Address")}
                </span>
                <span className="block text-xs" style={{ color: brandFallback.steel }}>
                  {String(a["address_line"] ?? "")} {String(a["city"] ?? "")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </GuestSection>

      <GuestSection title="Account security">
        <BrandButton
          variant="outline"
          onClick={() => {
            void supabase.auth.signOut().then(() => toast.success("Signed out"));
          }}
        >
          <LogOut className="size-4" /> Sign out
        </BrandButton>
      </GuestSection>
    </GuestScreen>
  );
}
