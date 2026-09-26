import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { ArrowLeft, Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { statusLabel } from "@/lib/public-delivery";
import { useRiderIdentity, useSetRiderAvailability } from "@/lib/delivery-data";
import { removeAvatarObject, uploadAvatar, useAvatarUrl } from "@/lib/avatars";
import { guardPreview, isPreviewMode } from "@/lib/preview-mode";
import { PreviewBanner } from "@/components/public/PreviewBanner";
import { RiderTabBar } from "@/components/public/RiderTabBar";

export const Route = createFileRoute("/rider/profile")({
  head: () => ({
    meta: [
      { title: "My Rider Profile — NEØ" },
      { name: "description", content: "Your rider code, vehicle, availability and delivery record." },
      { property: "og:title", content: "My Rider Profile — NEØ" },
      { property: "og:description", content: "Your rider code, vehicle, availability and delivery record." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RiderProfilePage,
});

function RiderProfilePage() {
  const navigate = useNavigate();
  const { user, loading } = useCustomerSession();
  const identity = useRiderIdentity();
  const setAvailability = useSetRiderAvailability();
  const preview = isPreviewMode();
  const rider = identity.data;
  const avatar = useAvatarUrl(rider?.avatar_url ?? null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [workPhone, setWorkPhone] = useState("");

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/rider/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (rider) {
      setDisplayName(rider.display_name ?? "");
      setWorkPhone(rider.work_phone ?? "");
    }
  }, [rider]);

  if (loading || identity.isLoading) {
    return (
       <div className="neo-public-app flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-white" />
      </div>
    );
  }

  if (!rider) {
    return (
       <div className="neo-public-app flex min-h-screen flex-col items-center justify-center px-5 text-center">
         <div className="neo-rider-card w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold" style={{ color: brandFallback.secondary }}>
            No rider profile
          </h1>
          <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
            This account is not on the rider roster. Ask your delivery manager to enrol you.
          </p>
        </div>
      </div>
    );
  }

  async function saveDetails() {
    try {
      guardPreview();
      setSaving(true);
      // The rider self-update policy allows only these fields on their own row.
      const { error } = await supabase
        .from("rider_profiles")
        .update({ display_name: displayName.trim(), work_phone: workPhone.trim() || null })
        .eq("id", rider!.rider_id);
      if (error) throw new Error(error.message);
      toast.success("Profile updated");
      void identity.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onPhoto(file: File) {
    try {
      guardPreview();
      setSaving(true);
      const path = await uploadAvatar(file);
      const previous = rider!.avatar_url;
      const { error } = await supabase.from("profiles").update({ avatar_url: path }).eq("id", user!.id);
      if (error) throw new Error(error.message);
      if (previous && previous !== path) await removeAvatarObject(previous);
      toast.success("Photo updated");
      void identity.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const availability = rider.availability_status ?? "offline";

  return (
     <div className="neo-rider-page">
      <PreviewBanner experience="Rider" />
      <header className="px-4 py-4" style={{ background: brandFallback.navy }}>
        <div className="mx-auto flex w-full max-w-md items-center gap-3">
          <Link to="/rider" className="text-white/70" aria-label="Back to deliveries">
            <ArrowLeft className="size-4" />
          </Link>
          <p className="text-sm font-semibold text-white">My profile</p>
        </div>
      </header>

       <main className="mx-auto w-full max-w-md min-w-0 space-y-4 px-4 py-5">
         <section className="neo-rider-card p-5">
          <div className="flex items-center gap-4">
            <span className="relative">
              {avatar.data ? (
                <img src={avatar.data} alt="" className="size-16 rounded-full object-cover" />
              ) : (
                <span
                  className="flex size-16 items-center justify-center rounded-full text-lg font-semibold text-white"
                  style={{ background: brandFallback.primary }}
                >
                  {(rider.display_name ?? rider.full_name ?? "R").slice(0, 1).toUpperCase()}
                </span>
              )}
              <button
                type="button"
                aria-label="Change photo"
                disabled={preview || saving}
                onClick={() => fileInput.current?.click()}
                className="absolute -bottom-1 -right-1 rounded-full p-1.5 text-white disabled:opacity-50"
                style={{ background: brandFallback.secondary }}
              >
                <Camera className="size-3.5" aria-hidden />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onPhoto(file);
                  e.target.value = "";
                }}
              />
            </span>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold" style={{ color: brandFallback.secondary }}>
                {rider.display_name ?? rider.full_name ?? "Rider"}
              </p>
              <p className="text-xs" style={{ color: brandFallback.steel }}>
                {rider.rider_code ?? "—"} · {statusLabel(availability)}
              </p>
            </div>
          </div>
        </section>

         <section className="neo-rider-card p-5">
          <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            My details
          </h2>
          <div className="mt-3 space-y-3">
            <div>
              <Label htmlFor="rider-name">Display name</Label>
              <Input id="rider-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rider-phone">Work phone</Label>
              <Input id="rider-phone" value={workPhone} onChange={(e) => setWorkPhone(e.target.value)} inputMode="tel" />
            </div>
            <dl className="grid grid-cols-2 gap-3 pt-1 text-sm">
              <Fact label="Vehicle" value={rider.vehicle_type ?? "Not recorded"} />
              <Fact label="Registration" value={rider.vehicle_registration ?? "Not recorded"} />
            </dl>
            <p className="text-xs" style={{ color: brandFallback.steel }}>
              Vehicle details and cash handling are set by your delivery manager.
            </p>
            <button
              type="button"
              onClick={() => void saveDetails()}
              disabled={preview || saving || !displayName.trim()}
              className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: brandFallback.secondary }}
            >
              {preview ? "Preview only" : saving ? "Saving…" : "Save details"}
            </button>
          </div>
        </section>

         <section className="neo-rider-card p-5">
          <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            Availability
          </h2>
          <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
            Dispatch only offers you work while you are online.
          </p>
          <button
            type="button"
            disabled={preview || setAvailability.isPending}
            onClick={() =>
              setAvailability.mutate({
                riderId: rider.rider_id,
                status: availability === "available" ? "offline" : "available",
              })
            }
            className="mt-3 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: availability === "available" ? brandFallback.primary : brandFallback.steel }}
          >
            {availability === "available" ? "Go offline" : "Go online"}
          </button>
        </section>

         <section className="neo-rider-card p-5">
          <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            My delivery record
          </h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            <Fact label="Open" value={String(rider.stats?.assigned_open ?? 0)} />
            <Fact label="Last 30 days" value={String(rider.stats?.delivered_30d ?? 0)} />
            <Fact label="All time" value={String(rider.stats?.delivered_total ?? 0)} />
          </dl>
        </section>
      </main>
      <RiderTabBar active="profile" />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-black/5 p-3">
      <dt className="text-xs" style={{ color: brandFallback.steel }}>
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm font-semibold" style={{ color: brandFallback.secondary }}>
        {value}
      </dd>
    </div>
  );
}
