import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { useGuestProfile, useGuestScreenView, useUpdateGuestProfile } from "@/lib/guest-app";

export const Route = createFileRoute("/guest/$hotelSlug/settings")({
  head: () => ({
    meta: [
      { title: "Settings — NEØ Guest" },
      { name: "description", content: "Notifications, preferences, accessibility, privacy and help for your guest account." },
      { property: "og:title", content: "Settings — NEØ Guest" },
      { property: "og:description", content: "Notifications, preferences, accessibility, privacy and help for your guest account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: SettingsPage,
});

/** Display-only preferences live with the device, never with the booking. */
const DEVICE_KEY = "neo.guest.display-preferences";

type DevicePrefs = { reducedMotion: boolean; largerText: boolean; highContrast: boolean };
const defaultPrefs: DevicePrefs = { reducedMotion: false, largerText: false, highContrast: false };

function readPrefs(): DevicePrefs {
  if (typeof window === "undefined") return defaultPrefs;
  try {
    return { ...defaultPrefs, ...(JSON.parse(window.localStorage.getItem(DEVICE_KEY) ?? "{}") as Partial<DevicePrefs>) };
  } catch {
    return defaultPrefs;
  }
}

function Row({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="grid min-w-0 items-center gap-3 border-b border-black/5 py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="text-sm font-medium" style={{ color: brandFallback.secondary }}>
          {title}
        </p>
        {description ? (
          <p className="neo-public-copy text-xs" style={{ color: brandFallback.steel }}>
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div data-public-actions>{children}</div> : null}
    </div>
  );
}

function SettingsPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customer = profile.data;
  const update = useUpdateGuestProfile(ws.organization_id);
  useGuestScreenView(ws.organization_id, "settings", Boolean(customer));

  const [prefs, setPrefs] = useState<DevicePrefs>(defaultPrefs);
  useEffect(() => setPrefs(readPrefs()), []);

  function setPref(key: keyof DevicePrefs, value: boolean) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try {
      window.localStorage.setItem(DEVICE_KEY, JSON.stringify(next));
    } catch {
      /* private browsing: the preference simply does not persist */
    }
    document.documentElement.dataset["guestPrefs"] = JSON.stringify(next);
  }

  if (!loading && !user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="settings">
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to manage settings"
          description="Notifications, preferences and privacy controls belong to your account."
        />
      </GuestScreen>
    );
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="settings">
      <header className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight" style={{ color: brandFallback.secondary }}>
          Settings
        </h1>
        <p className="neo-public-copy mt-1 text-sm" style={{ color: brandFallback.steel }}>
          Your account, how {ws.hotel_name} contacts you, and what this app remembers.
        </p>
      </header>

      <section id="account">
        <GuestSection title="Account">
          <div className="rounded-2xl bg-white p-4 sm:p-5">
            <Row title="Name and contact details" description="Managed on your profile.">
              <Link to="/guest/$hotelSlug/profile" params={{ hotelSlug }} className="text-sm font-semibold" style={{ color: ws.primary_color }}>
                Open profile
              </Link>
            </Row>
            <Row title="Sign-in email" description={String(customer?.["email"] ?? "—")}>
              <span className="text-xs" style={{ color: brandFallback.steel }}>
                Verified
              </span>
            </Row>
            <Row
              title="Password"
              description="A reset link is sent to your verified email."
            >
              <BrandButton
                variant="outline"
                onClick={() => {
                  const email = String(customer?.["email"] ?? user?.email ?? "");
                  if (!email) return;
                  void supabase.auth
                    .resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
                    .then(() => toast.success("Password reset link sent"))
                    .catch(() => toast.error("Could not send the reset link"));
                }}
              >
                Send reset link
              </BrandButton>
            </Row>
            <Row title="Sign out" description="Ends this session on this device only.">
              <BrandButton
                variant="outline"
                onClick={() => {
                  void supabase.auth.signOut().then(() => toast.success("Signed out"));
                }}
              >
                <LogOut className="size-4" aria-hidden /> Sign out
              </BrandButton>
            </Row>
          </div>
        </GuestSection>
      </section>

      <section id="notifications">
        <GuestSection
          title="Notifications"
          description="Updates about your bookings, orders, requests and bill."
        >
          <div className="rounded-2xl bg-white p-4 sm:p-5">
            <Row
              title="Service updates"
              description="Confirmations, order progress, request and laundry updates always appear in this app."
            >
              <span className="text-xs font-semibold" style={{ color: ws.primary_color }}>
                In app
              </span>
            </Row>
            <Row
              title="Offers and news from this hotel"
              description="Marketing only — never service updates."
            >
              <Switch
                checked={Boolean(customer?.["marketing_consent"])}
                onCheckedChange={(checked) => {
                  void update
                    .mutateAsync({ marketingConsent: checked })
                    .then(() => toast.success("Preference saved"))
                    .catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : "Could not save"),
                    );
                }}
              />
            </Row>
            <Row
              title="Email, SMS and push delivery"
              description="This hotel has not confirmed an active messaging provider, so outside-the-app delivery cannot be promised yet."
            />
          </div>
        </GuestSection>
      </section>

      <section id="appearance">
        <GuestSection
          title="Appearance and accessibility"
          description="Kept on this device. The app stays usable without changing anything here."
        >
          <div className="rounded-2xl bg-white p-4 sm:p-5">
            <Row title="Reduce motion" description="Fewer transitions and animated effects.">
              <Switch checked={prefs.reducedMotion} onCheckedChange={(v) => setPref("reducedMotion", v)} aria-label="Reduce motion" />
            </Row>
            <Row title="Larger text" description="Increases text size across the guest app.">
              <Switch checked={prefs.largerText} onCheckedChange={(v) => setPref("largerText", v)} aria-label="Larger text" />
            </Row>
            <Row title="Higher contrast" description="Stronger separation between text and background.">
              <Switch checked={prefs.highContrast} onCheckedChange={(v) => setPref("highContrast", v)} aria-label="Higher contrast" />
            </Row>
          </div>
        </GuestSection>
      </section>

      <section id="privacy">
        <GuestSection title="Privacy" description="What this hotel holds about you, and how to control it.">
          <div className="rounded-2xl bg-white p-4 sm:p-5">
            <Row title="Privacy notice">
              <span className="text-xs" style={{ color: brandFallback.steel }}>
                {ws.policy_text ? "Published below" : "Not published yet"}
              </span>
            </Row>
            {ws.policy_text ? (
              <p className="neo-public-copy py-3 text-sm" style={{ color: brandFallback.steel }}>
                {ws.policy_text}
              </p>
            ) : null}
            <Row
              title="Data export or account deletion"
              description="Ask reception or write to the hotel. Requests are handled by the hotel, not automatically."
            >
              {ws.contact_email ? (
                <a className="text-sm font-semibold" style={{ color: ws.primary_color }} href={`mailto:${ws.contact_email}`}>
                  Email the hotel
                </a>
              ) : null}
            </Row>
            <Row
              title="Active sessions"
              description="Signing out ends this device's session. Other devices keep their own session until signed out there."
            />
          </div>
        </GuestSection>
      </section>

      <section id="terms">
        <GuestSection title="Terms">
          <p className="neo-public-copy text-sm" style={{ color: brandFallback.steel }}>
            {ws.terms_text || "This hotel has not published its terms in the guest app yet. Ask reception for a copy."}
          </p>
        </GuestSection>
      </section>

      <section id="accessibility">
        <GuestSection title="Accessibility">
          <p className="neo-public-copy text-sm" style={{ color: brandFallback.steel }}>
            This app is built for keyboard use, screen readers and large touch targets. If anything is hard to use,
            tell reception and it will be recorded as a problem to fix.
          </p>
        </GuestSection>
      </section>

      <section id="help">
        <GuestSection title="Help and support" description={`Reach ${ws.hotel_name} directly.`}>
          <div className="rounded-2xl bg-white p-4 sm:p-5">
            {ws.contact_phone ? (
              <Row title="Call reception" description={ws.contact_phone}>
                <a className="text-sm font-semibold" style={{ color: ws.primary_color }} href={`tel:${ws.contact_phone}`}>
                  Call
                </a>
              </Row>
            ) : null}
            {ws.contact_email ? (
              <Row title="Email the hotel" description={ws.contact_email}>
                <a className="text-sm font-semibold" style={{ color: ws.primary_color }} href={`mailto:${ws.contact_email}`}>
                  Email
                </a>
              </Row>
            ) : null}
            <Row title="Report a problem" description="Raise it as a request and the hotel receives it as a record.">
              <Link to="/guest/$hotelSlug/trips" params={{ hotelSlug }} className="text-sm font-semibold" style={{ color: ws.primary_color }}>
                Open requests
              </Link>
            </Row>
            {ws.support_details ? (
              <p className="neo-public-copy py-3 text-sm" style={{ color: brandFallback.steel }}>
                {ws.support_details}
              </p>
            ) : null}
          </div>
        </GuestSection>
      </section>
    </GuestScreen>
  );
}
